import { pool, query, reportQuery, withTransaction } from "../../db/pool.js";
import { createCache } from "../../utils/cache.js";
import { conflict } from "../../utils/errors.js";

// Durable queue for certificate emails (table certificate_email_jobs, migration 028). One row per certificate.
// Writers that run inside the review transaction take its `client`, so a verified registration and its
// queued email commit (or roll back) together.

// Test / placeholder addresses are never emailed
export const UNDELIVERABLE_EMAIL = /@example\.(com|net|org)$/i;
// The worker's NO_EMAIL rule (certificate.worker.js) as SQL on the registration r: an address that is set, not blank
// and not a placeholder. Never NULL, so NOT (…) is exactly every other registration.
const DELIVERABLE = "r.email IS NOT NULL AND btrim(r.email) <> '' AND btrim(r.email) !~* '@example\\.(com|net|org)$'";

// last_error_code prefix of a delivery the mail server refused for the address itself (worker: failure kind
// 'recipient'), e.g. RECIPIENT_SMTP_550. Sending to that address again cannot help, so the bulk tools leave such a job
// alone until the participant's address is corrected. As SQL on the job j and its registration r:
export const REJECTED_PREFIX = "RECIPIENT_";
const REJECTED_ADDRESS = "j.status = 'failed' AND j.last_error_code LIKE 'RECIPIENT\\_%' AND j.recipient = btrim(r.email)";

const REQUEUE = `
  SET status = 'queued', reason = EXCLUDED.reason, requested_at = NOW(), requested_by = EXCLUDED.requested_by,
      attempts = 0, run_at = NOW(), locked_at = NULL, locked_by = NULL, last_error_code = NULL, last_error = NULL, updated_at = NOW()`;

/**
 * Queues the first email for these registrations' certificates. Certificates already emailed, revoked, or with a
 * delivery queued / in progress are left alone, so verifying twice (or two admins verifying at once) emails once.
 * Earlier jobs that ended failed / skipped / cancelled are queued again.
 * A registration without a deliverable address gets its job directly as 'skipped' (NO_EMAIL), the worker's verdict:
 * no worker round trip and no log row, and the admin list still says "No email". Returns the number queued.
 */
export async function queueEmails(client, registrationIds, { reason = "verify", adminId = null } = {}) {
  if (!registrationIds.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by)
     SELECT c.id, $2::varchar, $3::int FROM certificates c JOIN registrations r ON r.id = c.registration_id
     WHERE c.registration_id = ANY($1::int[]) AND c.revoked_at IS NULL AND c.emailed_at IS NULL AND ${DELIVERABLE}
     ORDER BY c.id
     ON CONFLICT (certificate_id) DO UPDATE ${REQUEUE}
     WHERE certificate_email_jobs.status IN ('failed', 'skipped', 'cancelled')`,
    [registrationIds, reason, adminId],
  );
  // An existing job is left as it is: there is nothing to send, and it may still be in a worker's hands
  await client.query(
    `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by, status, last_error_code)
     SELECT c.id, $2::varchar, $3::int, 'skipped', 'NO_EMAIL' FROM certificates c JOIN registrations r ON r.id = c.registration_id
     WHERE c.registration_id = ANY($1::int[]) AND c.revoked_at IS NULL AND c.emailed_at IS NULL AND NOT (${DELIVERABLE})
     ORDER BY c.id
     ON CONFLICT (certificate_id) DO NOTHING`,
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

// Rows per statement of the bulk tools below: each statement stays short, and no lock is held for long
const BATCH = 5_000;
const PENDING_LOCK = "certificates:queue-pending";

/**
 * "Email pending": queues every valid certificate of a verified registration with a deliverable address that has not
 * been emailed yet (an address the mail server rejected only once it has been corrected). Walks the not-yet-emailed
 * certificates in registration order through their own index (certificates_pending_email_idx), BATCH at a time.
 * One run at a time across all instances: an advisory lock on the run's own connection, held until the walk ends; a
 * second run is refused with 409 ALREADY_RUNNING. Resolves once the lock is held, to { done }: the number queued when
 * the walk has finished — so the admin route can answer at once and let the walk go on in the background.
 */
export async function queuePending(adminId = null) {
  const client = await pool.connect();
  let held;
  try {
    ({ rows: [{ held }] } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [PENDING_LOCK]));
  } catch (err) {
    client.release(err);
    throw err;
  }
  if (!held) {
    client.release();
    throw conflict("Pending certificate emails are already being queued. Please wait until that run has finished", "ALREADY_RUNNING");
  }
  return { done: walkPending(client, adminId).finally(() => unlock(client)) };
}

async function walkPending(client, adminId) {
  let queued = 0;
  for (let after = 0; ;) {
    const { rows } = await client.query(
      `SELECT registration_id FROM certificates
       WHERE revoked_at IS NULL AND emailed_at IS NULL AND registration_id > $1
       ORDER BY registration_id LIMIT ${BATCH}`,
      [after],
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].registration_id;
    const { rowCount } = await client.query(
      `INSERT INTO certificate_email_jobs (certificate_id, reason, requested_by)
       SELECT c.id, 'pending', $2::int FROM certificates c
       JOIN registrations r ON r.id = c.registration_id
       WHERE c.registration_id = ANY($1::int[])
         AND c.revoked_at IS NULL AND c.emailed_at IS NULL
         AND r.status = 'verified' AND r.deleted_at IS NULL AND ${DELIVERABLE}
         AND NOT EXISTS (SELECT 1 FROM certificate_email_jobs j WHERE j.certificate_id = c.id AND ${REJECTED_ADDRESS})
       ORDER BY c.id
       ON CONFLICT (certificate_id) DO UPDATE ${REQUEUE}
       WHERE certificate_email_jobs.status IN ('failed', 'skipped', 'cancelled')`,
      [rows.map((r) => r.registration_id), adminId],
    );
    queued += rowCount;
    if (rows.length < BATCH) break;
  }
  statsCache.clear();
  return queued;
}

async function unlock(client) {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [PENDING_LOCK]);
    client.release();
  } catch (err) {
    // Discarding the connection ends its session, which releases the lock as well
    client.release(err);
  }
}

/**
 * "Retry failed": gives failed deliveries a fresh set of attempts (after the cause — SMTP login, quota, a missing
 * photo — is fixed), BATCH jobs per statement in id order. An address the mail server rejected is left out unless it
 * has been corrected since, or `rejected` asks for those too (e.g. after a policy block on the sender was lifted).
 * Returns the number queued again.
 */
export async function retryFailed(adminId = null, { rejected = false } = {}) {
  let queued = 0;
  for (let after = 0; ;) {
    // The batch's ids first, then an update by that list, as walkPending does. Joined to the update as a CTE, the batch
    // may be rescanned for every failed job (all failed × BATCH comparisons) while the planner's statistics have not
    // caught up with a burst of failures — which is just when this runs.
    const { rows } = await query(
      `SELECT id FROM certificate_email_jobs WHERE status = 'failed' AND id > $1 ORDER BY id LIMIT ${BATCH}`,
      [after],
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    // A job changed meanwhile (resent, re-verified) is no longer 'failed' when its row is updated, and is not counted
    const { rowCount } = await query(
      `UPDATE certificate_email_jobs j
       SET status = 'queued', reason = 'retry', requested_by = $1::int, attempts = 0, run_at = NOW(),
           last_error_code = NULL, last_error = NULL, updated_at = NOW()
       WHERE j.id = ANY($2::bigint[]) AND j.status = 'failed'
         AND ($3 OR NOT EXISTS (SELECT 1 FROM certificates c JOIN registrations r ON r.id = c.registration_id
                                WHERE c.id = j.certificate_id AND ${REJECTED_ADDRESS}))`,
      [adminId, rows.map((r) => r.id), rejected],
    );
    queued += rowCount;
    if (rows.length < BATCH) break;
  }
  statsCache.clear();
  return queued;
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
    // The email left: record it on the certificate even if the lease was lost, so no one sends it again. Written first,
    // so this transaction locks the certificate before its job, as review, regenerate and reinstate do (no deadlock)
    if (next.delivered) {
      await client.query("UPDATE certificates SET emailed_at = NOW() WHERE id = $1", [job.certificate_id]);
    }
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
    `SELECT c.id, c.registration_id, c.certificate_no, c.durgveer_no, c.revoked_at, c.emailed_at,
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

// Queue health for the admin page. Counting per status reads the whole queue (seconds at millions of jobs), so it runs
// on the report pool, once per 15 s however many admins watch (utils/cache.js); the bulk tools above clear it.
// rejected: the failed jobs a plain "Retry failed" leaves alone (address refused and not corrected since), read from
// the failed ones only.
const statsCache = createCache({ ttlMs: 15_000, name: "email-queue" });
export const queueStats = () => statsCache.get("all", countQueue);

async function countQueue() {
  const [byStatus, timing] = await Promise.all([
    reportQuery("SELECT status, COUNT(*)::int AS count FROM certificate_email_jobs GROUP BY status"),
    reportQuery(
      `SELECT
         (SELECT MIN(run_at) FROM certificate_email_jobs WHERE status = 'queued') AS next_run_at,
         (SELECT COUNT(*)::int FROM certificate_email_jobs WHERE status = 'queued' AND run_at <= NOW()) AS due_now,
         (SELECT COUNT(*)::int FROM certificate_email_log WHERE outcome = 'sent' AND created_at > NOW() - INTERVAL '1 hour') AS sent_last_hour,
         (SELECT MAX(created_at) FROM certificate_email_log) AS last_activity_at,
         (SELECT COUNT(*)::int FROM certificate_email_jobs j JOIN certificates c ON c.id = j.certificate_id
            JOIN registrations r ON r.id = c.registration_id WHERE ${REJECTED_ADDRESS}) AS rejected`,
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
