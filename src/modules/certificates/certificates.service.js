import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { emailLayout, escapeHtml, sendMail } from "../../services/mail.service.js";
import { sendSms } from "../../services/sms.service.js";
import { conflict, notFound } from "../../utils/errors.js";
import { formatCertificateNo, formatRegistrationNo, parseRegistrationNo } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { paginate, pageMeta } from "../../utils/pagination.js";
import { renderCertificatePdf } from "./certificate.renderer.js";

const CERT_SELECT = `
  SELECT c.*, r.id AS registration_id, r.name, r.phone, r.email, r.status, d.name_mr AS district,
         p.image_path AS photo_path
  FROM certificates c
  JOIN registrations r ON r.id = c.registration_id
  LEFT JOIN districts d ON d.id = r.district_id
  LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1`;

// Called inside the review transaction for a single registration.
export async function issue(client, registrationId, adminId) {
  await client.query(
    `INSERT INTO certificates (registration_id, certificate_no, issued_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (registration_id) DO UPDATE
       SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL,
           issued_at = CASE WHEN certificates.revoked_at IS NULL THEN certificates.issued_at ELSE NOW() END`,
    [registrationId, formatCertificateNo(registrationId), adminId],
  );
}

// Bulk version: one INSERT … ON CONFLICT for all ids in a batch review.
// Avoids N sequential round-trips inside the transaction for large bulk verifies.
export async function issueBatch(client, registrationIds, adminId) {
  if (!registrationIds.length) return;
  const certNos = registrationIds.map(formatCertificateNo);
  await client.query(
    `INSERT INTO certificates (registration_id, certificate_no, issued_by)
     SELECT unnested.reg_id, unnested.cert_no, $3
     FROM UNNEST($1::int[], $2::text[]) AS unnested(reg_id, cert_no)
     ON CONFLICT (registration_id) DO UPDATE
       SET revoked_at  = NULL,
           revoked_by  = NULL,
           revoke_reason = NULL,
           issued_at   = CASE WHEN certificates.revoked_at IS NULL
                              THEN certificates.issued_at
                              ELSE NOW() END`,
    [registrationIds, certNos, adminId],
  );
}

export async function revokeForRegistrations(client, registrationIds, adminId, reason) {
  if (!registrationIds.length) return;
  await client.query(
    `UPDATE certificates SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3
     WHERE registration_id = ANY($1::int[]) AND revoked_at IS NULL`,
    [registrationIds, adminId, reason?.slice(0, 300)],
  );
}

async function findValid(registrationId) {
  const { rows } = await query(`${CERT_SELECT} WHERE c.registration_id = $1 AND r.deleted_at IS NULL`, [registrationId]);
  return rows[0] ?? null;
}

export const renderPdf = (cert) => renderCertificatePdf(cert);

// ---------------------------------------------------------------- notifications (PDF §2.8)

const downloadLink = (registrationId) =>
  `${env.SITE_URL}/certificate?registration=${encodeURIComponent(formatRegistrationNo(registrationId))}`;

export async function notify(registrationId) {
  const cert = await findValid(registrationId);
  if (!cert || cert.revoked_at) return { email: false, sms: false };
  const link = downloadLink(registrationId);
  const result = { email: false, sms: false };

  if (cert.email) {
    try {
      const pdf = await renderPdf(cert);
      result.email = await sendMail({
        to: cert.email,
        subject: "अमृत दुर्गोत्सव २०२६ — आपले अभिनंदन पत्र",
        html: emailLayout(
          `<p>नमस्कार ${escapeHtml(cert.name)},</p>
           <p>दुर्गोत्सव २०२६ मध्ये सहभाग नोंदविल्याबद्दल आपले हार्दिक अभिनंदन! आपली नोंदणी व छायाचित्राची पडताळणी पूर्ण झाली असून आपले डिजिटल <b>अभिनंदन पत्र</b> सोबत जोडले आहे.</p>
           <p>नोंदणी क्रमांक: <b>${formatRegistrationNo(registrationId)}</b><br>अभिनंदन पत्र क्रमांक: <b>${escapeHtml(cert.certificate_no)}</b></p>
           <p><a href="${link}" style="display:inline-block;background:#c2641c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">अभिनंदन पत्र पुन्हा डाउनलोड करा</a></p>`,
        ),
        attachments: [{ filename: `Durgotsav-2026-${cert.certificate_no}.pdf`, content: pdf }],
      });
      if (result.email) await query("UPDATE certificates SET emailed_at = NOW() WHERE id = $1", [cert.id]);
    } catch (err) {
      logger.error({ err, registrationId }, "Certificate email failed");
    }
  }
  try {
    result.sms = await sendSms(
      cert.phone,
      `अमृत दुर्गोत्सव २०२६: आपली नोंदणी ${formatRegistrationNo(registrationId)} पडताळणी पूर्ण. अभिनंदन पत्र डाउनलोड करा: ${link}`,
    );
    if (result.sms) await query("UPDATE certificates SET sms_sent_at = NOW() WHERE id = $1", [cert.id]);
  } catch (err) {
    logger.error({ err, registrationId }, "Certificate SMS failed");
  }
  return result;
}

// Sends notifications in the background so admin requests return immediately.
// Runs CONCURRENCY notifications at a time to balance throughput against SMTP
// connection limits. Sequential processing of 1000s of IDs would take hours;
// fully parallel would hammer the mail server — batched concurrent is the sweet spot.
const NOTIFY_CONCURRENCY = 5;

export function notifyInBackground(registrationIds) {
  if (!registrationIds.length || env.isTest) return;
  (async () => {
    for (let i = 0; i < registrationIds.length; i += NOTIFY_CONCURRENCY) {
      await Promise.allSettled(
        registrationIds.slice(i, i + NOTIFY_CONCURRENCY).map(notify),
      );
    }
  })().catch((err) => logger.error({ err }, "Background certificate notifications failed"));
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
    valid: !c.revoked_at && c.status === "verified",
    name: c.name,
    district: c.district,
    registration_no: formatRegistrationNo(c.registration_id),
    issued_at: c.issued_at,
    revoked_at: c.revoked_at,
  };
}

// ---------------------------------------------------------------- admin

export async function adminList(f) {
  const where = ["r.deleted_at IS NULL"];
  const params = [];
  if (f.state === "valid") where.push("c.revoked_at IS NULL");
  if (f.state === "revoked") where.push("c.revoked_at IS NOT NULL");
  if (f.emailed === "yes") where.push("c.emailed_at IS NOT NULL");
  if (f.emailed === "no") where.push("c.emailed_at IS NULL AND r.email IS NOT NULL");
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(r.name ILIKE $${params.length} OR c.certificate_no ILIKE $${params.length} OR r.phone LIKE $${params.length})`);
  }
  const { limit, offset } = paginate(f);
  const sqlWhere = `WHERE ${where.join(" AND ")}`;
  const [list, count] = await Promise.all([
    query(`${CERT_SELECT} ${sqlWhere} ORDER BY c.issued_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM certificates c JOIN registrations r ON r.id = c.registration_id ${sqlWhere}`, params),
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
  const { rowCount } = await query(
    "UPDATE certificates SET revoked_at = NOW(), revoked_by = $2, revoke_reason = $3 WHERE registration_id = $1 AND revoked_at IS NULL",
    [registrationId, adminId, reason],
  );
  if (!rowCount) throw notFound("No active certificate for this registration");
}

export async function reinstate(registrationId) {
  const { rowCount } = await query(
    `UPDATE certificates c SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
     FROM registrations r
     WHERE c.registration_id = $1 AND r.id = c.registration_id AND r.status = 'verified' AND c.revoked_at IS NOT NULL`,
    [registrationId],
  );
  if (!rowCount) throw conflict("Only revoked certificates of verified registrations can be reinstated");
}

export async function pendingEmailIds() {
  const { rows } = await query(
    `SELECT c.registration_id FROM certificates c JOIN registrations r ON r.id = c.registration_id
     WHERE c.revoked_at IS NULL AND c.emailed_at IS NULL AND r.email IS NOT NULL AND r.deleted_at IS NULL
       AND r.status = 'verified' AND r.email !~* '@example\\.(com|net|org)$'
     ORDER BY c.registration_id`,
  );
  return rows.map((r) => r.registration_id);
}
