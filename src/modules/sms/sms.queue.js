import { EDITION_YEAR_MR } from "../../config/edition.js";
import { query } from "../../db/pool.js";
import { conflict, notFound } from "../../utils/errors.js";
import { formatRegistrationNo } from "../../utils/format.js";
import { certificateLink } from "../certificates/certificate.links.js";
import { CERTIFIED_STATUSES } from "../certificates/certificates.service.js";

// Durable SMS queue (table sms_messages, migrations 033 + 035). One row per message:
//   queued → processing → sent | logged (SMS_DRIVER=log) | failed (attempts used up), or cancelled when it no longer
//   applies (registration deleted, certificate withdrawn before the SMS went out).
// Rows are written in the same transaction as the registration / approval they announce, so an SMS exists exactly when
// that change committed, and survives a crash or restart. Worker processes claim due rows with FOR UPDATE SKIP LOCKED.
//   registration_ack   right after a registration: its number and the participant's status link
//   certificate_link   when an admin approves it: the link to download the certificate

const TEXT = {
  registration_ack: (id) =>
    `अमृत दुर्गोत्सव ${EDITION_YEAR_MR}: नोंदणी ${formatRegistrationNo(id)} प्राप्त झाली. पडताळणीनंतर अभिनंदन पत्र मिळेल. स्थिती पाहा: ${certificateLink(id)} - AMRUT`,
  certificate_link: (id) =>
    `अमृत दुर्गोत्सव ${EDITION_YEAR_MR}: नोंदणी ${formatRegistrationNo(id)} ची पडताळणी पूर्ण. आपले अभिनंदन पत्र डाउनलोड करा: ${certificateLink(id)} - AMRUT`,
};
export const smsText = (purpose, registrationId) => TEXT[purpose](registrationId);

/**
 * Queues one SMS per registration. db: the pool, or the client of the transaction that creates the reason for it.
 * rows: [{ id, phone }]. Returns how many were queued.
 */
export async function enqueue(db, purpose, rows, requestedBy = null) {
  if (!rows.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO sms_messages (registration_id, phone, message, purpose, status, requested_by)
     SELECT u.id, u.phone, u.message, $4::varchar, 'queued', $5::int
     FROM UNNEST($1::int[], $2::varchar[], $3::varchar[]) AS u(id, phone, message)`,
    [rows.map((r) => r.id), rows.map((r) => r.phone), rows.map((r) => smsText(purpose, r.id)), purpose, requestedBy],
  );
  return rowCount;
}

// A withdrawn certificate must not be announced: drop its certificate SMS that have not started
export async function cancelQueued(db, registrationIds, purpose = "certificate_link") {
  if (!registrationIds.length) return;
  await db.query(
    `UPDATE sms_messages SET status = 'cancelled', error = 'NO_CERTIFICATE', updated_at = NOW()
     WHERE registration_id = ANY($1::int[]) AND purpose = $2 AND status = 'queued'`,
    [registrationIds, purpose],
  );
}

// Admin "Send SMS": the certificate link again, for a registration with a valid certificate
export async function queueCertificateSms(registrationId, adminId) {
  const { rows } = await query(
    `SELECT r.id, r.phone, r.status, c.id AS certificate_id, c.revoked_at
     FROM registrations r LEFT JOIN certificates c ON c.registration_id = r.id
     WHERE r.id = $1 AND r.deleted_at IS NULL`,
    [registrationId],
  );
  const r = rows[0];
  if (!r) throw notFound("Registration not found");
  if (!r.certificate_id || r.revoked_at || !CERTIFIED_STATUSES.includes(r.status)) {
    throw conflict("This registration has no valid certificate to send", "NO_CERTIFICATE");
  }
  const saved = await query(
    `INSERT INTO sms_messages (registration_id, phone, message, purpose, status, requested_by)
     VALUES ($1, $2, $3, 'certificate_link', 'queued', $4)
     RETURNING id, phone, purpose, status, created_at`,
    [r.id, r.phone, smsText("certificate_link", r.id), adminId],
  );
  return saved.rows[0];
}

export async function smsHistory(registrationId, limit = 20) {
  const { rows } = await query(
    `SELECT s.id, s.phone, s.purpose, s.message, s.status, s.provider, s.error, s.attempts, s.sent_at, s.created_at,
            a.name AS requested_by_name
     FROM sms_messages s LEFT JOIN admins a ON a.id = s.requested_by
     WHERE s.registration_id = $1 ORDER BY s.id DESC LIMIT $2`,
    [registrationId, limit],
  );
  return rows;
}

// ---------------------------------------------------------------- worker side

// Takes up to `limit` due messages for this worker. SKIP LOCKED: concurrent workers each get different rows.
export async function claimDue(limit, worker) {
  const { rows } = await query(
    `UPDATE sms_messages s
     SET status = 'processing', attempts = s.attempts + 1, locked_at = NOW(), locked_by = $2, updated_at = NOW()
     FROM (SELECT id FROM sms_messages
           WHERE status = 'queued' AND run_at <= NOW()
           ORDER BY run_at, id LIMIT $1
           FOR UPDATE SKIP LOCKED) due
     WHERE s.id = due.id
     RETURNING s.id, s.registration_id, s.phone, s.purpose, s.message, s.attempts`,
    [limit, worker],
  );
  return rows;
}

// What decides whether a claimed SMS still applies, read just before it is sent
export async function loadTarget(registrationId) {
  const { rows } = await query(
    `SELECT r.status, r.deleted_at, c.id AS certificate_id, c.revoked_at
     FROM registrations r LEFT JOIN certificates c ON c.registration_id = r.id
     WHERE r.id = $1`,
    [registrationId],
  );
  return rows[0] ?? null;
}

/**
 * Records one attempt. Applies only while this worker still holds the lease, so a worker whose lease expired cannot
 * overwrite a newer attempt. next: { status, runAt?, provider?, response?, error? }. Returns false when the lease was lost.
 */
export async function finish(job, worker, next) {
  const delivered = next.status === "sent" || next.status === "logged";
  const { rowCount } = await query(
    `UPDATE sms_messages
     SET status = $3, run_at = COALESCE($4, run_at), provider = COALESCE($5, provider), response = $6, error = $7,
         sent_at = CASE WHEN $8 THEN NOW() ELSE sent_at END,
         locked_at = NULL, locked_by = NULL, updated_at = NOW()
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
    [job.id, worker, next.status, next.runAt ?? null, next.provider ?? null, next.response?.slice(0, 500) ?? null,
      next.error?.slice(0, 300) ?? null, delivered],
  );
  if (rowCount && next.status === "sent" && job.purpose === "certificate_link") {
    await query("UPDATE certificates SET sms_sent_at = NOW() WHERE registration_id = $1 AND sms_sent_at IS NULL", [job.registration_id]);
  }
  return rowCount === 1;
}

// Messages whose worker vanished mid-send (crash, restart) are tried again once the lease has expired
export async function reapExpired(leaseMinutes, maxAttempts) {
  const { rowCount } = await query(
    `UPDATE sms_messages
     SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, run_at = NOW(),
         locked_at = NULL, locked_by = NULL, error = 'LEASE_EXPIRED', updated_at = NOW()
     WHERE status = 'processing' AND locked_at < NOW() - make_interval(mins => $1)`,
    [leaseMinutes, maxAttempts],
  );
  return rowCount;
}
