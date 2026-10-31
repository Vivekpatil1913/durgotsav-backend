import { query, withTransaction } from "../../db/pool.js";
import { conflict, notFound } from "../../utils/errors.js";
import { formatCertificateNo, formatRegistrationNo, latinDigits, likeContains, parseRegistrationNo } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { assertBrowsable, cappedCount, cappedMeta, COUNT_CAP, paginate, sortSql } from "../../utils/pagination.js";
import { certificateToken, parseCertificateToken } from "./certificate.links.js";
import { renderBundleInPool, renderInPool } from "./certificate.render-pool.js";
import { CertificateDataError } from "./certificate.renderer.js";
import * as emailQueue from "./certificate.queue.js";

// A certificate is generated only when an admin approves the registration after checking its photo and details
// (review action "verify"). Pending, rejected, duplicate and info-requested registrations have no valid certificate:
// rejecting / marking duplicate / asking for more information after an approval revokes it, approving again
// reinstates it with the same दुर्गवीर number.
export const CERTIFIED_STATUSES = ["verified"];
const isValid = (c) => Boolean(c) && !c.revoked_at && CERTIFIED_STATUSES.includes(c.status);

const CERT_SELECT = `
  SELECT c.*, r.id AS registration_id, r.name, r.phone, r.email, r.status, r.created_at AS registered_at,
         r.deleted_at AS registration_deleted_at, d.name_mr AS district,
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

// Counted once the file is ready: a refused (BUSY) or failed render is no download. The counter is not worth failing a
// participant's download over, so a write that fails (database busy) is only logged.
const countDownloads = (certificateIds) =>
  query("UPDATE certificates SET download_count = download_count + 1, last_downloaded_at = NOW() WHERE id = ANY($1::int[])", [certificateIds])
    .catch((err) => logger.warn({ err, certificateIds }, "Certificate download not counted"));

export async function renderPdf(cert) {
  if (!cert.photo_path) logger.warn({ registrationId: cert.registration_id }, "Certificate rendered without a photo (none on record)");
  return renderInPool(cert);
}

// A participant's download (getForDownload / downloadByToken), counted once rendered. format: "pdf" | "jpg" (2400×1712 JPEG)
export async function render(cert, format = "pdf") {
  const file = format === "jpg" ? await renderInPool(cert, { format: "image" }) : await renderPdf(cert);
  await countDownloads([cert.id]);
  return file;
}

// ---------------------------------------------------------------- public

// Why a registration has no certificate to download, in the API's error vocabulary
function unavailable(status) {
  return ["pending", "info_requested"].includes(status)
    ? conflict("This registration has not been verified yet. The certificate is generated once an admin approves it.", "NOT_VERIFIED")
    : conflict("This certificate is not available. The registration was not approved.", "NOT_AVAILABLE");
}

// The certificate to download (render() renders it and counts the download)
export async function getForDownload(registrationInput, phone) {
  const id = parseRegistrationNo(registrationInput);
  if (!id) throw notFound("No registration found for this registration number and mobile number");
  const { rows } = await query("SELECT id, status FROM registrations WHERE id = $1 AND phone = $2 AND deleted_at IS NULL", [id, phone]);
  if (!rows[0]) throw notFound("No registration found for this registration number and mobile number");
  const cert = await findValid(id);
  if (!isValid(cert)) throw unavailable(rows[0].status);
  return cert;
}

// What a participant sees about one registration: its status, the reason when it was sent back or refused, and its
// certificate once approved
function publicView(r) {
  const available = Boolean(r.certificate_no) && isValid(r);
  return {
    registration_no: formatRegistrationNo(r.id),
    name: r.name,
    district: r.district,
    status: r.status,
    submitted_at: r.created_at,
    thumb_path: r.thumb_path,
    note: ["info_requested", "rejected", "duplicate"].includes(r.status) ? r.review_note : null,
    certificate_available: available,
    certificate_no: available ? r.certificate_no : null,
    durgveer_no: available ? r.durgveer_no : null,
    token: certificateToken(r.id),
  };
}

const PUBLIC_SELECT = `
  SELECT r.id, r.name, r.status, r.review_note, r.created_at, d.name_mr AS district, p.thumb_path,
         c.certificate_no, c.durgveer_no, c.revoked_at
  FROM registrations r
  LEFT JOIN districts d ON d.id = r.district_id
  LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
  LEFT JOIN certificates c ON c.registration_id = r.id`;

// A participant link (/c/<token>): the registration's status, and its certificate once approved; 404 for a forged link
export async function linkSummary(token) {
  const id = parseCertificateToken(token);
  const { rows } = id ? await query(`${PUBLIC_SELECT} WHERE r.id = $1 AND r.deleted_at IS NULL`, [id]) : { rows: [] };
  if (!rows[0]) throw notFound("This certificate link is not valid");
  return publicView(rows[0]);
}

// The certificate behind a participant link (render() renders it and counts the download)
export async function downloadByToken(token) {
  const id = parseCertificateToken(token);
  const cert = id && (await findValid(id));
  if (!isValid(cert)) {
    const { rows } = id ? await query("SELECT status FROM registrations WHERE id = $1 AND deleted_at IS NULL", [id]) : { rows: [] };
    if (!rows[0]) throw notFound("This certificate link is not valid");
    throw unavailable(rows[0].status);
  }
  return cert;
}

// One lookup page = at most this many registrations; also the most a "download all" PDF may hold
export const LOOKUP_PAGE_SIZE = 20;

// "Download all": the valid certificates among these links (one lookup page), a page each in registration order
export async function bundleByTokens(tokens) {
  const ids = [...new Set(tokens.map(parseCertificateToken).filter(Boolean))];
  const { rows } = ids.length
    ? await query(`${CERT_SELECT} WHERE c.registration_id = ANY($1::int[]) AND r.deleted_at IS NULL ORDER BY c.registration_id`, [ids])
    : { rows: [] };
  const certs = rows.filter(isValid);
  if (!certs.length) throw notFound("No downloadable certificate among these links");
  const pdf = await renderBundleInPool(certs);
  await countDownloads(certs.map((c) => c.id));
  return { certs, pdf };
}

/**
 * Every registration made with this mobile number — any number of them — newest first, a page at a time.
 * Keyset pagination on (phone, id) (index registrations_phone_live_idx): each page is an index range read however
 * many registrations the number has. before: the last id of the previous page. total only on the first page.
 */
export async function lookupByPhone(phone, { before = null } = {}) {
  const params = [phone, LOOKUP_PAGE_SIZE + 1];
  if (before) params.push(before);
  const [{ rows }, count] = await Promise.all([
    query(`${PUBLIC_SELECT} WHERE r.phone = $1 AND r.deleted_at IS NULL ${before ? "AND r.id < $3" : ""} ORDER BY r.id DESC LIMIT $2`, params),
    before ? null : query("SELECT COUNT(*)::int AS n FROM registrations WHERE phone = $1 AND deleted_at IS NULL", [phone]),
  ]);
  const page = rows.slice(0, LOOKUP_PAGE_SIZE);
  return {
    data: page.map(publicView),
    meta: {
      next_before: rows.length > LOOKUP_PAGE_SIZE ? page[page.length - 1].id : null,
      ...(count && { total: count.rows[0].n }),
      page_size: LOOKUP_PAGE_SIZE,
    },
  };
}

export async function verifyPublic(certificateNo) {
  // Numbers are stored upper-case: compare the column as is, so the UNIQUE index answers (no scan of every certificate)
  const { rows } = await query(`${CERT_SELECT} WHERE c.certificate_no = $1`, [certificateNo.trim().toUpperCase()]);
  const c = rows[0];
  if (!c) throw notFound("No certificate exists with this number");
  return {
    certificate_no: c.certificate_no,
    durgveer_no: c.durgveer_no,
    valid: isValid(c) && !c.registration_deleted_at,
    name: c.name,
    district: c.district,
    registration_no: formatRegistrationNo(c.registration_id),
    issued_at: c.issued_at,
    revoked_at: c.revoked_at,
  };
}

// ---------------------------------------------------------------- admin

// Admin list orders by column, each read off an index: issued_at, the certificate number by the registration it is
// made from (AMRUT-DGT26-<registration>: as text, 1000000 would sort before 999999), durgveer_no (unique), r.name
export const ADMIN_SORTS = {
  issued_at: { cols: "c.issued_at, c.id", dir: "desc" },
  certificate_no: { cols: "c.registration_id", dir: "asc" },
  durgveer_no: { cols: "c.durgveer_no", dir: "asc" },
  name: { cols: "r.name, c.id", dir: "asc" },
};

const WITH_CERTIFICATE = "EXISTS (SELECT 1 FROM certificates x WHERE x.registration_id = r.id)";

/**
 * The admin search box. Number (Latin or Marathi digits): the दुर्गवीर number (unique), or part of the mobile number
 * (trigram). Text: part of the certificate number or of the name (trigram); contains-search needs 3 characters.
 * Returns null when the text can match nothing, else
 * - ids: an array of the matching certificates' registration ids, from index-backed lookups joined once (an OR across
 *   the two tables could use no index and would read every certificate). Each lookup stops at COUNT_CAP + 1
 *   certificates, so a broad term costs no more than that — a plain UNION would first collect every match. As an array
 *   it is computed once, before any certificate is read, and then looked up by registration_id (UNIQUE): as an IN
 *   (subquery) the planner may instead hash-join a scan of every certificate against it;
 * - test: the same condition on one listed row, for walking a sort index.
 */
function search(text, params) {
  const q = latinDigits(text);
  const lookups = [];
  const tests = [];
  if (/^\d+$/.test(q)) {
    if (q.length <= 9) {
      lookups.push(`SELECT registration_id AS id FROM certificates WHERE durgveer_no = ${Number(q)}`);
      tests.push(`c.durgveer_no = ${Number(q)}`);
    }
    if (q.length >= 3) {
      params.push(likeContains(q));
      lookups.push(`SELECT r.id FROM registrations r WHERE r.phone LIKE $${params.length} AND r.deleted_at IS NULL AND ${WITH_CERTIFICATE}`);
      tests.push(`r.phone LIKE $${params.length}`);
    }
  } else if (q.length >= 3) {
    params.push(likeContains(q));
    const p = `$${params.length}`;
    lookups.push(`SELECT registration_id AS id FROM certificates WHERE certificate_no ILIKE ${p}`);
    lookups.push(`SELECT r.id FROM registrations r WHERE r.name ILIKE ${p} AND r.deleted_at IS NULL AND ${WITH_CERTIFICATE}`);
    tests.push(`c.certificate_no ILIKE ${p}`, `r.name ILIKE ${p}`);
  }
  if (!lookups.length) return null;
  return { ids: `ARRAY(${lookups.map((sql) => `(${sql} LIMIT ${COUNT_CAP + 1})`).join(" UNION ")})`, test: `(${tests.join(" OR ")})` };
}

export async function adminList(f) {
  assertBrowsable(f, "certificates");
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
  const terms = f.q ? search(f.q, params) : null;
  if (f.q && !terms) where.push("FALSE");
  const filters = where.join(" AND ");
  // Counting joins the email job only when a filter reads it
  const from = `FROM certificates c JOIN registrations r ON r.id = c.registration_id${f.email_status ? " LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id" : ""}`;
  const { limit, offset } = paginate(f);
  const page = (condition) =>
    query(`${CERT_SELECT} WHERE ${condition} ORDER BY ${sortSql(ADMIN_SORTS, f, "issued_at")} LIMIT ${limit} OFFSET ${offset}`, params);

  let list;
  let count;
  if (!terms) {
    [list, count] = await Promise.all([page(filters), cappedCount(query, `${from} WHERE ${filters}`, params)]);
  } else {
    // Count first, among the certificates the lookups found. At most COUNT_CAP of them: no lookup was cut short, so
    // the count is exact, and the page reads just those and sorts them. More: the matches are dense, so walking the
    // sort index with the test on each row fills a page quickly, and counting stops at the cap.
    const { rows: [found] } = await query(
      `SELECT COUNT(*)::int AS candidates, (COUNT(*) FILTER (WHERE ${filters}))::int AS total
       ${from} WHERE c.registration_id = ANY(${terms.ids})`,
      params,
    );
    if (found.candidates <= COUNT_CAP) {
      count = { total: found.total, capped: false };
      list = await page(`${filters} AND c.registration_id = ANY(${terms.ids})`);
    } else {
      [list, count] = await Promise.all([
        page(`${filters} AND ${terms.test}`),
        found.total > COUNT_CAP ? { total: COUNT_CAP, capped: true } : cappedCount(query, `${from} WHERE ${filters} AND ${terms.test}`, params),
      ]);
    }
  }
  return {
    data: list.rows.map(({ phone, ...c }) => ({ ...c, phone, registration_no: formatRegistrationNo(c.registration_id) })),
    meta: cappedMeta(f, count),
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
       WHERE c.registration_id = $1 AND r.id = c.registration_id AND r.status = ANY($2::text[]) AND c.revoked_at IS NOT NULL`,
      [registrationId, CERTIFIED_STATUSES],
    );
    if (!rowCount) throw conflict("Only revoked certificates of verified registrations can be reinstated");
    await emailQueue.queueEmails(client, [registrationId], { reason: "verify", adminId });
  });
}

/**
 * Admin "Regenerate certificate" (SRS v2.1 §6), for an approved registration: issues its certificate if it has none,
 * makes a revoked one valid again, and renders it afresh with the current name and photo — e.g. after correcting a typo
 * in the name. The render runs here, so a missing photo is reported to the admin now.
 */
export async function regenerate(registrationId, adminId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query("SELECT status FROM registrations WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [registrationId]);
    if (!rows[0]) throw notFound("Registration not found");
    if (!CERTIFIED_STATUSES.includes(rows[0].status)) {
      throw conflict("Certificates are generated only for approved registrations. Approve the registration first.", "NOT_CERTIFIABLE");
    }
    await issueBatch(client, [registrationId], adminId);
    await client.query("UPDATE certificates SET regenerated_at = NOW(), regenerated_by = $2 WHERE registration_id = $1", [registrationId, adminId]);
    await emailQueue.queueEmails(client, [registrationId], { reason: "verify", adminId }); // only if never emailed
  });
  const cert = await adminGet(registrationId);
  try {
    await renderInPool(cert, { requirePhoto: true });
  } catch (err) {
    if (err instanceof CertificateDataError) throw conflict(`The certificate could not be generated: ${err.message}`, err.code);
    throw err;
  }
  return cert;
}

// ---------------------------------------------------------------- email delivery (admin)

// Another copy on request. Returns the delivery status ('queued', or 'processing' when one is being sent now).
export async function resend(registrationId, adminId) {
  const cert = await adminGet(registrationId);
  if (cert.revoked_at) throw conflict("A revoked certificate cannot be emailed", "CERTIFICATE_REVOKED");
  if (!CERTIFIED_STATUSES.includes(cert.status)) throw conflict("Only certificates of verified registrations can be emailed", "NOT_VERIFIED");
  if (!cert.email || emailQueue.UNDELIVERABLE_EMAIL.test(cert.email)) throw conflict("This participant has no email address", "NO_EMAIL");
  return emailQueue.queueResend(registrationId, adminId);
}

// Resolves to { done } once this run holds the lock (409 ALREADY_RUNNING while another run goes on); see the queue
export const queuePending = (adminId) => emailQueue.queuePending(adminId);
export const retryFailed = (adminId, options) => emailQueue.retryFailed(adminId, options);
export const emailQueueStats = () => emailQueue.queueStats();

export async function deliveryLog(registrationId) {
  await adminGet(registrationId);
  return emailQueue.deliveryLog(registrationId);
}
