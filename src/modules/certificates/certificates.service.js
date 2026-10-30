import { query, withTransaction } from "../../db/pool.js";
import { conflict, notFound } from "../../utils/errors.js";
import { formatCertificateNo, formatRegistrationNo, parseRegistrationNo } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { paginate, pageMeta, sortSql } from "../../utils/pagination.js";
import { renderInPool } from "./certificate.render-pool.js";
import * as emailQueue from "./certificate.queue.js";

const CERT_SELECT = `
  SELECT c.*, r.id AS registration_id, r.name, r.phone, r.email, r.status, d.name_mr AS district,
         p.image_path AS photo_path,
         j.status AS email_status, j.attempts AS email_attempts, j.run_at AS email_next_attempt_at,
         j.last_error_code AS email_error_code, j.last_error AS email_error
  FROM certificates c
  JOIN registrations r ON r.id = c.registration_id
  LEFT JOIN districts d ON d.id = r.district_id
  LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
  LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id`;

// Called inside the review transaction for a single registration.
export const issue = (client, registrationId, adminId) => issueBatch(client, [registrationId], adminId);

// One certificate per registration (UNIQUE registration_id). A new certificate takes the next दुर्गवीर number
// from the column default (a sequence); an existing one keeps its number, and a revoked one becomes valid again.
// Runs inside the review transaction, which already holds the registrations' row locks, so two admins verifying
// the same registration cannot both insert. ON CONFLICT covers callers without that lock (legacy import).
export async function issueBatch(client, registrationIds, adminId) {
  if (!registrationIds.length) return;
  await client.query(
    `UPDATE certificates
     SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, issued_at = NOW()
     WHERE registration_id = ANY($1::int[]) AND revoked_at IS NOT NULL`,
    [registrationIds],
  );
  // Only rows that need a certificate reach the INSERT, so re-verifying does not use up दुर्गवीर numbers
  await client.query(
    `INSERT INTO certificates (registration_id, certificate_no, issued_by)
     SELECT u.reg_id, u.cert_no, $3::int
     FROM UNNEST($1::int[], $2::text[]) AS u(reg_id, cert_no)
     WHERE NOT EXISTS (SELECT 1 FROM certificates c WHERE c.registration_id = u.reg_id)
     ORDER BY u.reg_id
     ON CONFLICT (registration_id) DO NOTHING`,
    [registrationIds, registrationIds.map(formatCertificateNo), adminId],
  );
}

export async function revokeForRegistrations(client, registrationIds, adminId, reason) {
  if (!registrationIds.length) return;
  await client.query(
    `UPDATE certificates SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3
     WHERE registration_id = ANY($1::int[]) AND revoked_at IS NULL`,
    [registrationIds, adminId, reason?.slice(0, 300)],
  );
  await emailQueue.cancelQueued(client, registrationIds);
}

// Queues the certificate email for newly verified registrations (same transaction as the verify)
export const queueEmails = (client, registrationIds, adminId) =>
  emailQueue.queueEmails(client, registrationIds, { reason: "verify", adminId });

async function findValid(registrationId) {
  const { rows } = await query(`${CERT_SELECT} WHERE c.registration_id = $1 AND r.deleted_at IS NULL`, [registrationId]);
  return rows[0] ?? null;
}

export async function renderPdf(cert) {
  if (!cert.photo_path) logger.warn({ registrationId: cert.registration_id }, "Certificate rendered without a photo (none on record)");
  return renderInPool(cert);
}

// ---------------------------------------------------------------- public

export async function getForDownload(registrationInput, phone) {
  const id = parseRegistrationNo(registrationInput);
  if (!id) throw notFound("No registration found for this registration number and mobile number");
  const { rows } = await query("SELECT id, status FROM registrations WHERE id = $1 AND phone = $2 AND deleted_at IS NULL", [id, phone]);
  if (!rows[0]) throw notFound("No registration found for this registration number and mobile number");
  const cert = await findValid(id);
  if (rows[0].status !== "verified" || !cert || cert.revoked_at) {
    throw conflict("Your registration has not been verified yet. The certificate will be available after verification.", "NOT_VERIFIED");
  }
  await query("UPDATE certificates SET download_count = download_count + 1, last_downloaded_at = NOW() WHERE id = $1", [cert.id]);
  return cert;
}

export async function verifyPublic(certificateNo) {
  const { rows } = await query(`${CERT_SELECT} WHERE UPPER(c.certificate_no) = UPPER($1)`, [certificateNo.trim()]);
  const c = rows[0];
  if (!c) throw notFound("No certificate exists with this number");
  return {
    certificate_no: c.certificate_no,
    durgveer_no: c.durgveer_no,
    valid: !c.revoked_at && c.status === "verified",
    name: c.name,
    district: c.district,
    registration_no: formatRegistrationNo(c.registration_id),
    issued_at: c.issued_at,
    revoked_at: c.revoked_at,
  };
}

// ---------------------------------------------------------------- admin

const MARATHI_DIGITS = "०१२३४५६७८९";

// Admin list orders by column: certificate_no and durgveer_no are unique, issued_at and r.name are indexed
export const ADMIN_SORTS = {
  issued_at: { cols: "c.issued_at, c.id", dir: "desc" },
  certificate_no: { cols: "c.certificate_no", dir: "asc" },
  durgveer_no: { cols: "c.durgveer_no", dir: "asc" },
  name: { cols: "r.name, c.id", dir: "asc" },
};

export async function adminList(f) {
  const where = ["r.deleted_at IS NULL"];
  const params = [];
  if (f.state === "valid") where.push("c.revoked_at IS NULL");
  if (f.state === "revoked") where.push("c.revoked_at IS NOT NULL");
  if (f.emailed === "yes") where.push("c.emailed_at IS NOT NULL");
  if (f.emailed === "no") where.push("c.emailed_at IS NULL AND r.email IS NOT NULL");
  if (f.email_status === "none") where.push("j.id IS NULL");
  else if (f.email_status) {
    params.push(f.email_status);
    where.push(`j.status = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    // A plain number (Latin or Marathi digits) also finds the दुर्गवीर number
    const digits = f.q.replace(/[०-९]/g, (d) => String(MARATHI_DIGITS.indexOf(d)));
    const durgveer = /^\d{1,9}$/.test(digits) ? ` OR c.durgveer_no = ${Number(digits)}` : "";
    where.push(`(r.name ILIKE $${params.length} OR c.certificate_no ILIKE $${params.length} OR r.phone LIKE $${params.length}${durgveer})`);
  }
  const { limit, offset } = paginate(f);
  const sqlWhere = `WHERE ${where.join(" AND ")}`;
  const [list, count] = await Promise.all([
    query(`${CERT_SELECT} ${sqlWhere} ORDER BY ${sortSql(ADMIN_SORTS, f, "issued_at")} LIMIT ${limit} OFFSET ${offset}`, params),
    query(
      `SELECT COUNT(*)::int AS total FROM certificates c JOIN registrations r ON r.id = c.registration_id
       LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id ${sqlWhere}`,
      params,
    ),
  ]);
  return {
    data: list.rows.map(({ phone, ...c }) => ({ ...c, phone, registration_no: formatRegistrationNo(c.registration_id) })),
    meta: pageMeta(f, count.rows[0].total),
  };
}

export async function adminGet(registrationId) {
  const cert = await findValid(registrationId);
  if (!cert) throw notFound("Certificate not found");
  return cert;
}

export async function revoke(registrationId, adminId, reason) {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      "UPDATE certificates SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3 WHERE registration_id = $1 AND revoked_at IS NULL",
      [registrationId, adminId, reason],
    );
    if (!rowCount) throw notFound("No active certificate for this registration");
    await emailQueue.cancelQueued(client, [registrationId]);
  });
}

// A reinstated certificate that was never emailed is queued, like a fresh verification
export async function reinstate(registrationId, adminId) {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE certificates c SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
       FROM registrations r
       WHERE c.registration_id = $1 AND r.id = c.registration_id AND r.status = 'verified' AND c.revoked_at IS NOT NULL`,
      [registrationId],
    );
    if (!rowCount) throw conflict("Only revoked certificates of verified registrations can be reinstated");
    await emailQueue.queueEmails(client, [registrationId], { reason: "verify", adminId });
  });
}

// ---------------------------------------------------------------- email delivery (admin)

// Another copy on request. Returns the delivery status ('queued', or 'processing' when one is being sent now).
export async function resend(registrationId, adminId) {
  const cert = await adminGet(registrationId);
  if (cert.revoked_at) throw conflict("A revoked certificate cannot be emailed", "CERTIFICATE_REVOKED");
  if (cert.status !== "verified") throw conflict("Only certificates of verified registrations can be emailed", "NOT_VERIFIED");
  if (!cert.email || emailQueue.UNDELIVERABLE_EMAIL.test(cert.email)) throw conflict("This participant has no email address", "NO_EMAIL");
  return emailQueue.queueResend(registrationId, adminId);
}

export const queuePending = (adminId) => emailQueue.queuePending(adminId);
export const retryFailed = (adminId) => emailQueue.retryFailed(adminId);
export const emailQueueStats = () => emailQueue.queueStats();

export async function deliveryLog(registrationId) {
  await adminGet(registrationId);
  return emailQueue.deliveryLog(registrationId);
}
