import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { admission } from "../middleware/admission.js";
import { cache } from "../middleware/cache.js";
import {
  contactLimiter, downloadLimiter, lookupLimiter, lookupPageLimiter, registerLimiter, verifyLimiter, visitLimiter,
} from "../middleware/rateLimit.js";
import { imageUpload, imageUploadFields } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { requireCaptcha } from "../services/captcha.service.js";
import { emailLayout, escapeHtml, sendMail } from "../services/mail.service.js";
import { env } from "../config/env.js";
import { EDITION_YEAR } from "../config/edition.js";
import { AppError, asyncHandler, notFound } from "../utils/errors.js";
import { paginationSchema } from "../utils/pagination.js";
import { logger } from "../utils/logger.js";
import * as registrations from "../modules/registrations/registrations.service.js";
import {
  bundleQuery, formatQuery, lookupSchema, mobileLookupPageSchema, mobileLookupSchema, registerSchema, resubmitSchema, tokenParams,
} from "../modules/registrations/registrations.schemas.js";
import * as certificates from "../modules/certificates/certificates.service.js";
import { lookupToken, parseLookupToken } from "../modules/certificates/certificate.links.js";
import { wakeSmsWorker } from "../modules/sms/sms.worker.js";
import * as galleryService from "../modules/gallery/gallery.service.js";
import * as stats from "../modules/stats/stats.service.js";
import * as visits from "../modules/stats/visits.service.js";
import { getPublicSettings } from "../modules/settings/settings.service.js";
import { publicFortBySlug, publicFortList } from "../modules/forts/forts.module.js";
import { announcements, events, faqs, podcasts, testimonials, videos } from "../modules/content/content.resources.js";

const router = Router();
// Pages and ids within what their columns hold (districts.id SMALLINT, forts.id INTEGER), so a hand-edited URL is a
// 400 instead of reaching SQL
const MAX_PAGE = 100_000;
const optionalId = (max) => z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().max(max).optional());
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  district_id: optionalId(32_767),
  fort_id: optionalId(2_147_483_647),
});

router.get("/health", asyncHandler(async (req, res) => {
  await query("SELECT 1");
  res.json({ status: "ok", time: new Date().toISOString() });
}));

// ------------------------------------------------------------- site data
// Not cached: registration_status changes the moment an admin opens or closes registration. Browsers still revalidate
// cheaply — the ETag turns an unchanged response into a 304 — and the server reads the settings from memory.
router.get("/settings", (req, res, next) => { res.set("Cache-Control", "no-cache"); next(); }, asyncHandler(async (req, res) => res.json({ data: await getPublicSettings() })));

router.get("/divisions", cache(3600), asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT id, name_mr, name_en, sort_order FROM divisions WHERE deleted_at IS NULL AND is_active ORDER BY sort_order",
  );
  res.json({ data: rows });
}));

router.get("/districts", cache(3600), asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT id, name_mr, name_en, division_id FROM districts WHERE deleted_at IS NULL ORDER BY sort_order, name_mr",
  );
  res.json({ data: rows });
}));

router.get("/talukas", cache(3600), asyncHandler(async (req, res) => {
  const { rows } = await query(
    "SELECT id, name_mr, name_en, district_id FROM talukas WHERE deleted_at IS NULL AND is_active ORDER BY district_id, sort_order",
  );
  res.json({ data: rows });
}));

router.get("/stats", cache(30), asyncHandler(async (req, res) => res.json({ data: await stats.publicStats() })));

// ------------------------------------------------------------- visitor counter
router.get("/visits", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await visits.visitTotals() });
}));
const visitSchema = z.object({ visitor_id: z.string().uuid().optional() });
router.post("/visits", visitLimiter, validate({ body: visitSchema }), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  const visitor = { visitorId: req.body.visitor_id, ip: req.ip, userAgent: req.get("user-agent") };
  res.json({ data: await visits.recordVisit(visitor) });
}));

router.get("/home", cache(60), asyncHandler(async (req, res) => {
  // One round-trip for what the home page renders. Each part stands alone: one that fails is sent empty, and the
  // response is then not cached, instead of failing the page. The counters never hold it up: they come from the
  // cache, null until first computed (the site then shows its fixed figures).
  const parts = await Promise.allSettled([
    publicFortList(),
    testimonials.service.listPublic(),
    galleryService.latest(12),
  ]);
  const [forts, voices, featured] = parts.map((part) => (part.status === "fulfilled" ? part.value : []));
  const failed = parts.filter((part) => part.status === "rejected");
  if (failed.length) {
    res.set("Cache-Control", "no-store");
    for (const { reason } of failed) logger.error({ err: reason }, "Home page section failed");
  }
  res.json({ data: { stats: stats.cachedPublicStats(), forts, testimonials: voices, gallery: featured } });
}));

router.get("/forts", cache(120), asyncHandler(async (req, res) => res.json({ data: await publicFortList() })));
router.get("/forts/:slug", cache(120), validate({ params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }) }),
  asyncHandler(async (req, res) => res.json({ data: await publicFortBySlug(req.params.slug) })));

router.get("/events", cache(120), asyncHandler(async (req, res) => res.json({ data: await events.service.listPublic() })));
router.get("/videos", cache(120), asyncHandler(async (req, res) => res.json({ data: await videos.service.listPublic() })));
// GET /api/podcasts?page=N&limit=M — paged so the playlist can grow without bound; the site fetches more as the list scrolls
const podcastQuery = paginationSchema.extend({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
router.get("/podcasts", cache(120), validate({ query: podcastQuery }),
  asyncHandler(async (req, res) => res.json(await podcasts.service.pagePublic({ ...req.query, columns: "id, youtube_id, title_mr, title_en" }))));
router.get("/testimonials", cache(300), asyncHandler(async (req, res) => res.json({ data: await testimonials.service.listPublic() })));
router.get("/faqs", cache(300), asyncHandler(async (req, res) => res.json({ data: await faqs.service.listPublic() })));
router.get("/announcements", cache(60), asyncHandler(async (req, res) =>
  res.json({ data: await announcements.service.listPublic({ limit: 50, extraWhere: "AND published_at <= NOW()" }) })));

router.get("/pages/:slug", cache(300), validate({ params: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,80}$/) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT slug, title, title_en, body, body_en, meta_description, updated_at FROM pages WHERE slug = $1 AND is_active",
      [req.params.slug],
    );
    if (!rows[0]) throw notFound("Page not found");
    res.json({ data: rows[0] });
  }));

// ------------------------------------------------------------- photos
// GET /api/gallery?page=N&limit=M&district_id=&fort_id= — filtered and paged in SQL; meta.page is clamped to the last page
router.get("/gallery", cache(30), validate({ query: pageQuery.extend({ limit: z.coerce.number().int().min(1).max(60).default(10) }) }),
  asyncHandler(async (req, res) => res.json(await galleryService.gallery(req.query))));

// GET /api/images?page=N — the photo album, ALBUM_PAGE_SIZE per page
router.get("/images", cache(30), validate({ query: pageQuery }), asyncHandler(async (req, res) => res.json(await galleryService.album(req.query))));

// ------------------------------------------------------------- registration (SRS v2.1 §2–§5)
// registrationAdmission bounds how many uploads this process holds in memory at once (the rest wait, unread).
// requireCaptcha runs after multer has read the form and before anything is validated, processed or stored.
// The registration waits for an admin's approval; the acknowledgment SMS was queued in its transaction.
const registrationAdmission = admission({
  concurrency: env.REGISTRATION_CONCURRENCY,
  queue: env.REGISTRATION_QUEUE,
  message: "Many registrations are being uploaded right now. Please try again in a few seconds",
});
router.post("/registrations", registerLimiter, registrationAdmission, imageUploadFields(["photo", "photo_2"]), requireCaptcha, validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const files = [req.files?.photo?.[0], req.files?.photo_2?.[0]];
    const { replayed, ...result } = await registrations.register(req.body, files, { ip: req.ip, userAgent: req.get("user-agent") });
    if (!replayed) wakeSmsWorker();
    res.status(replayed ? 200 : 201).json({ data: result });
  }));

router.get("/registrations/status", lookupLimiter, validate({ query: lookupSchema }),
  asyncHandler(async (req, res) => res.json({ data: await registrations.publicStatus(req.query.registration, req.query.phone) })));

// A new photo is the same work as a registration's, so it waits its turn behind the same gate
router.post("/registrations/:registration/resubmit", lookupLimiter, registrationAdmission, imageUpload("photo"), validate({ body: resubmitSchema }),
  asyncHandler(async (req, res) => res.json({ data: await registrations.resubmit(req.params.registration, req.body, req.file) })));

// ------------------------------------------------------------- certificates (SRS v2.1 §5, §7)
const FILE_TYPES = { pdf: "application/pdf", jpg: "image/jpeg" };

async function sendCertificateFile(res, cert, format) {
  const data = await certificates.render(cert, format);
  res.set({
    "Content-Type": FILE_TYPES[format],
    "Content-Disposition": `attachment; filename="Durgotsav-${EDITION_YEAR}-${cert.certificate_no}.${format}"`,
    "Cache-Control": "no-store",
  });
  res.send(data);
}

router.get("/certificates/download", lookupLimiter, validate({ query: lookupSchema }),
  asyncHandler(async (req, res) =>
    sendCertificateFile(res, await certificates.getForDownload(req.query.registration, req.query.phone), req.query.format)));

// Every registration of one mobile number, newest first, a page at a time. The first page needs the CAPTCHA (so numbers
// cannot be scanned by a script) and returns a lookup_token that fetches the following pages for 30 minutes.
router.post("/certificates/lookup", lookupLimiter, requireCaptcha, validate({ body: mobileLookupSchema }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const page = await certificates.lookupByPhone(req.body.phone);
    res.json({ data: page.data, meta: { ...page.meta, lookup_token: lookupToken(req.body.phone) } });
  }));

router.get("/certificates/lookup", lookupPageLimiter, validate({ query: mobileLookupPageSchema }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const phone = parseLookupToken(req.query.lookup_token);
    if (!phone) throw new AppError(401, "This search has expired. Please search again", { code: "LOOKUP_EXPIRED" });
    res.json(await certificates.lookupByPhone(phone, { before: req.query.before }));
  }));

// Participant links (/c/<token> on the website: SMS, email, the pop-up after registering, the lookup list):
// the registration's status, and its certificate once approved
router.get("/certificates/link/:token", downloadLimiter, validate({ params: tokenParams }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ data: await certificates.linkSummary(req.params.token) });
  }));

router.get("/certificates/link/:token/download", downloadLimiter, validate({ params: tokenParams, query: formatQuery }),
  asyncHandler(async (req, res) => sendCertificateFile(res, await certificates.downloadByToken(req.params.token), req.query.format)));

// "Download all": one PDF, a page per certificate
router.get("/certificates/bundle", downloadLimiter, validate({ query: bundleQuery }),
  asyncHandler(async (req, res) => {
    const { pdf } = await certificates.bundleByTokens(req.query.tokens);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Durgotsav-${EDITION_YEAR}-Abhinandan-Patra.pdf"`,
      "Cache-Control": "no-store",
    });
    res.send(pdf);
  }));

router.get("/certificates/verify/:certificateNo", verifyLimiter,
  validate({ params: z.object({ certificateNo: z.string().trim().min(5).max(40) }) }),
  asyncHandler(async (req, res) => res.json({ data: await certificates.verifyPublic(req.params.certificateNo) })));

// ------------------------------------------------------------- contact (PDF §6.8 helpline)
const contactSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(150),
  email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().email("Email is invalid").max(160).optional()),
  phone: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().regex(/^\+?\d{10,13}$/, "Phone is invalid").optional()),
  subject: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().max(200).optional()),
  message: z.string().trim().min(10, "Please write at least 10 characters").max(4000),
  website: z.string().max(0).optional(), // honeypot
}).refine((v) => v.email || v.phone, { path: ["email"], message: "Please give an email or a phone number" });

router.post("/contact", contactLimiter, validate({ body: contactSchema }), asyncHandler(async (req, res) => {
  const { name, email, phone, subject, message } = req.body;
  const { rows } = await query(
    `INSERT INTO contact_enquiries (name, email, phone, subject, message, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [name, email ?? null, phone ?? null, subject ?? null, message, req.ip],
  );
  if (env.CONTACT_NOTIFY_EMAIL) {
    sendMail({
      to: env.CONTACT_NOTIFY_EMAIL,
      subject: `Durgotsav enquiry #${rows[0].id}: ${subject ?? name}`,
      html: emailLayout(`<p><b>${escapeHtml(name)}</b> (${escapeHtml(email ?? "")} ${escapeHtml(phone ?? "")})</p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`),
    }).catch((err) => logger.error({ err }, "Enquiry notification failed"));
  }
  res.status(201).json({ data: rows[0] });
}));

export default router;
