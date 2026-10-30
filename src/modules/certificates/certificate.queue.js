import { query, withTransaction } from "../../db/pool.js";

// Durable queue for certificate emails (table certificate_email_jobs, migration 028). One row per certificate.
// Writers that run inside the review transaction take its `client`, so a verified registration and its
// queued email commit (or roll back) together.

// Test / placeholder addresses are never emailed
export const UNDELIVERABLE_EMAIL = /@example\.(com|net|org)$/i;

const REQUEUE = `
  SET status = 'queued', reason = EXCLUDED.reason, requested_at = NOW(), requested_by = EXCLUDED.requested_by,
      attempts = 0, run_at = NOW(), locked_at = NULL, locked_by = NULL, last_error_code = NULL, last_error = NULL, updated_at = NOW()`;

/**
 * Queues the first email for these registrations' certificates. Certificates already emailed, revoked, or with a
 * delivery queued / in progress are left alone, so verifying twice (or two admins verifying at once) emails once.
 * Earlier jobs that ended failed / skipped / cancelled are queued again.
 */
export async function queueEmails(client, registrationIds, { reason = "verify", adminId = null } = {}) {
  if (!registrationIds.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by)
     SELECT c.id, $2::varchar, $3::int FROM certificates c
     WHERE c.registration_id = ANY($1::int[]) AND c.revoked_at IS NULL AND c.emailed_at IS NULL
     ORDER BY c.id
     ON CONFLICT (certificate_id) DO UPDATE ${REQUEUE}
     WHERE certificate_email_jobs.status IN ('failed', 'skipped', 'cancelled')`,
    [registrationIds, reason, adminId],
  );
  return rowCount;
}

// An admin asked for another copy. Returns the job's status afterwards ('queued', or 'processing' if it is being sent now).
export async function queueResend(registrationId, adminId) {
  const { rows } = await query(
    `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by)
     SELECT c.id, 'resend', $2::int FROM certificates c WHERE c.registration_id = $1 AND c.revoked_at IS NULL
     ON CONFLICT (certificate_id) DO UPDATE ${REQUEUE}
     WHERE certificate_email_jobs.status NOT IN ('queued', 'processing')
     RETURNING status`,
    [registrationId, adminId],
  );
  if (rows[0]) return rows[0].status;
  const current = await query(
    "SELECT j.status FROM certificate_email_jobs j JOIN certificates c ON c.id = j.certificate_id WHERE c.registration_id = $1",
    [registrationId],
  );
  return current.rows[0]?.status ?? null;
}

// Revoked certificates must not be emailed: drop deliveries that have not started. (One already being sent is
// re-checked by the worker just before it hands the email to SMTP.)
export async function cancelQueued(client, registrationIds, code = "REVOKED") {
  if (!registrationIds.length) return;
  await client.query(
    `UPDATE certificate_email_jobs j SET status = 'cancelled', last_error_code = $2, last_error = NULL, updated_at = NOW()
     FROM certificates c
     WHERE c.id = j.certificate_id AND c.registration_id = ANY($1::int[]) AND j.status = 'queued'`,
    [registrationIds, code],
  );
}

/**
 * "Email pending": queues every valid certificate of a verified registration with an email address that has not
 * been emailed yet. Walks the certificates in id ranges so millions of rows never sit in one statement.
 */
export async function queuePending(adminId = null, chunk = 20_000) {
  const { rows } = await query("SELECT COALESCE(MIN(id), 0) AS lo, COALESCE(MAX(id), 0) AS hi FROM certificates");
  let queued = 0;
  for (let from = rows[0].lo; from <= rows[0].hi && rows[0].hi > 0; from += chunk) {
    const { rowCount } = await query(
      `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by)
       SELECT c.id, 'pending', $3::int FROM certificates c
       JOIN registrations r ON r.id = c.registration_id
       WHERE c.id >= $1 AND c.id < $2
         AND c.revoked_at IS NULL AND c.emailed_at IS NULL
         AND r.status = 'verified' AND r.deleted_at IS NULL
         AND r.email IS NOT NULL AND r.email !~* '@example\\.(com|net|org)$'
       ORDER BY c.id
       ON CONFLICT (certificate_id) DO UPDATE ${REQUEUE}
       WHERE certificate_email_jobs.status IN ('failed', 'skipped', 'cancelled')`,
      [from, from + chunk, adminId],
    );
    queued += rowCount;
  }
  return queued;
}

// Gives every failed delivery a fresh set of attempts (after the cause — SMTP login, quota, a missing photo — is fixed)
export async function retryFailed(adminId = null) {
  const { rowCount } = await query(
    `UPDATE certificate_email_jobs
     SET status = 'queued', reason = 'retry', requested_by = $1::int, attempts = 0, run_at = NOW(),
         last_error_code = NULL, last_error = NULL, updated_at = NOW()
     WHERE status = 'failed'`,
    [adminId],
  );
  return rowCount;
}

// ---------------------------------------------------------------- worker side

// Takes up to `limit` due jobs for this worker. SKIP LOCKED: concurrent workers each get different rows.
export async function claimDue(limit, worker) {
  const { rows } = await query(
    `UPDATE certificate_email_jobs j
     SET status = 'processing', attempts = j.attempts + 1, locked_at = NOW(), locked_by = $2, updated_at = NOW()
     FROM (SELECT id FROM certificate_email_jobs
           WHERE status = 'queued' AND run_at <= NOW()
           ORDER BY run_at, id LIMIT $1
           FOR UPDATE SKIP LOCKED) due
     WHERE j.id = due.id
     RETURNING j.id, j.certificate_id, j.attempts, j.reason, j.requested_at`,
    [limit, worker],
  );
  return rows;
}

// certificate_email_log columns written per attempt, with the VARCHAR length of the text ones
const LOG_COLUMNS = { recipient: 160, certificate_no: 40, durgveer_no: 0, photo_id: 0, pdf_bytes: 0, pdf_sha256: 64,
  render_ms: 0, send_ms: 0, message_id: 255, smtp_response: 300, error_code: 40, error: 500 };
const clip = (v, n) => (v == null ? null : n ? String(v).slice(0, n) : v);

/**
 * Records the result of one attempt. The job update only applies while this worker still holds the lease
 * (status 'processing', locked_by = worker), so a worker whose lease expired cannot overwrite a newer attempt.
 * next: { status, runAt?, refund?, delivered? } — refund gives the attempt back (put back without being tried);
 * delivered: SMTP accepted the email.
 * Returns false when the lease had been lost.
 */
export async function finishJob(job, worker, next, log) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE certificate_email_jobs
       SET status = $3, run_at = COALESCE($4, run_at), attempts = attempts - $5::int,
           locked_at = NULL, locked_by = NULL, recipient = COALESCE($6, recipient),
           last_error_code = $7, last_error = $8,
           sent_at = CASE WHEN $9 THEN NOW() ELSE sent_at END,
           sent_count = sent_count + CASE WHEN $9 THEN 1 ELSE 0 END,
           updated_at = NOW()
       WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
      [job.id, worker, next.status, next.runAt ?? null, next.refund ? 1 : 0, clip(log.recipient, 160),
        clip(log.error_code, 40), clip(log.error, 500), Boolean(next.delivered)],
    );
    // The email left: record it on the certificate even if the lease was lost, so no one sends it again
    if (next.delivered) {
      await client.query("UPDATE certificates SET emailed_at = NOW() WHERE id = $1", [job.certificate_id]);
    }
    const columns = Object.keys(LOG_COLUMNS);
    const values = columns.map((c) => clip(log[c], LOG_COLUMNS[c]));
    await client.query(
      `INSERT INTO certificate_email_log (job_id, certificate_id, attempt, outcome, worker, ${columns.join(", ")})
       VALUES ($1, $2, $3, $4, $5, ${columns.map((_, i) => `$${i + 6}`).join(", ")})`,
      [job.id, job.certificate_id, job.attempts, log.outcome, worker, ...values],
    );
    return rowCount === 1;
  });
}

// Jobs whose worker vanished (crash, kill -9, server restart) are tried again once their lease has expired.
export async function reapExpiredLeases(leaseMinutes, maxAttempts, worker) {
  const { rows } = await query(
    `WITH expired AS (
       UPDATE certificate_email_jobs
       SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, run_at = NOW(),
           locked_at = NULL, locked_by = NULL, last_error_code = 'LEASE_EXPIRED',
           last_error = 'The worker stopped while handling this email', updated_at = NOW()
       WHERE status = 'processing' AND locked_at < NOW() - make_interval(mins => $1)
       RETURNING id, certificate_id, attempts, status
     )
     INSERT INTO certificate_email_log (job_id, certificate_id, attempt, outcome, error_code, error, worker)
     SELECT id, certificate_id, attempts, CASE WHEN status = 'failed' THEN 'failed' ELSE 'requeued' END,
            'LEASE_EXPIRED', 'The worker stopped while handling this email', $3
     FROM expired
     RETURNING job_id`,
    [leaseMinutes, maxAttempts, worker],
  );
  return rows.length;
}

// Everything printed on the certificate or needed to deliver it, read fresh for every attempt
export async function loadForDelivery(certificateId) {
  const { rows } = await query(
    `SELECT c.id, c.registration_id, c.certificate_no, c.durgveer_no, c.revoked_at, c.emailed_at, c.sms_sent_at,
            r.name, r.phone, r.email, r.status, r.deleted_at,
            p.id AS photo_id, p.registration_id AS photo_registration_id, p.image_path AS photo_path
     FROM certificates c
     JOIN registrations r ON r.id = c.registration_id
     LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
     WHERE c.id = $1`,
    [certificateId],
  );
  return rows;
}

// ---------------------------------------------------------------- admin

export async function queueStats() {
  const [byStatus, timing] = await Promise.all([
    query("SELECT status, COUNT(*)::int AS count FROM certificate_email_jobs GROUP BY status"),
    query(
      `SELECT
         (SELECT MIN(run_at) FROM certificate_email_jobs WHERE status = 'queued') AS next_run_at,
         (SELECT COUNT(*)::int FROM certificate_email_jobs WHERE status = 'queued' AND run_at <= NOW()) AS due_now,
         (SELECT COUNT(*)::int FROM certificate_email_log WHERE outcome = 'sent' AND created_at > NOW() - INTERVAL '1 hour') AS sent_last_hour,
         (SELECT MAX(created_at) FROM certificate_email_log) AS last_activity_at`,
    ),
  ]);
  const counts = { queued: 0, processing: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const r of byStatus.rows) counts[r.status] = r.count;
  return { ...counts, ...timing.rows[0] };
}

export async function deliveryLog(registrationId, limit = 50) {
  const [job, log] = await Promise.all([
    query(
      `SELECT j.* FROM certificate_email_jobs j JOIN certificates c ON c.id = j.certificate_id WHERE c.registration_id = $1`,
      [registrationId],
    ),
    query(
      `SELECT l.* FROM certificate_email_log l JOIN certificates c ON c.id = l.certificate_id
       WHERE c.registration_id = $1 ORDER BY l.id DESC LIMIT $2`,
      [registrationId, limit],
    ),
  ]);
  return { job: job.rows[0] ?? null, attempts: log.rows };
}
