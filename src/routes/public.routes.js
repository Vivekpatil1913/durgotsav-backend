import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { contactLimiter, lookupLimiter, registerLimiter } from "../middleware/rateLimit.js";
import { imageUpload, imageUploadFields } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { emailLayout, escapeHtml, sendMail } from "../services/mail.service.js";
import { env } from "../config/env.js";
import { asyncHandler, notFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import * as registrations from "../modules/registrations/registrations.service.js";
import { lookupSchema, registerSchema, resubmitSchema } from "../modules/registrations/registrations.schemas.js";
import * as certificates from "../modules/certificates/certificates.service.js";
import * as galleryService from "../modules/gallery/gallery.service.js";
import * as stats from "../modules/stats/stats.service.js";
import { getPublicSettings } from "../modules/settings/settings.service.js";
import { publicFortBySlug, publicFortList } from "../modules/forts/forts.module.js";
import { announcements, events, faqs, podcasts, testimonials, videos } from "../modules/content/content.resources.js";

const router = Router();
const optionalId = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional());
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), district_id: optionalId, fort_id: optionalId });

// Short CDN/browser caching for public read endpoints that change slowly
const cache = (seconds) => (req, res, next) => {
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
  next();
};

router.get("/health", asyncHandler(async (req, res) => {
  await query("SELECT 1");
  res.json({ status: "ok", time: new Date().toISOString() });
}));

// ------------------------------------------------------------- site data
router.get("/settings", cache(60), asyncHandler(async (req, res) => res.json({ data: await getPublicSettings() })));

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

router.get("/home", cache(60), asyncHandler(async (req, res) => {
  // One round-trip for the home page
  const [settings, counters, forts, timeline, voices, news, featured] = await Promise.all([
    getPublicSettings(),
    stats.publicStats(),
    publicFortList(),
    events.service.listPublic(),
    testimonials.service.listPublic(),
    announcements.service.listPublic({ limit: 6, extraWhere: "AND published_at <= NOW()" }),
    galleryService.gallery({ page: 1, limit: 12 }),
  ]);
  res.json({ data: { settings, stats: counters, forts, events: timeline, testimonials: voices, announcements: news, gallery: featured.data } });
}));

router.get("/forts", cache(120), asyncHandler(async (req, res) => res.json({ data: await publicFortList() })));
router.get("/forts/:slug", cache(120), validate({ params: z.object({ slug: z.string().regex(/^[a-z0-9-]{1,80}$/) }) }),
  asyncHandler(async (req, res) => res.json({ data: await publicFortBySlug(req.params.slug) })));

router.get("/events", cache(120), asyncHandler(async (req, res) => res.json({ data: await events.service.listPublic() })));
router.get("/videos", cache(120), asyncHandler(async (req, res) => res.json({ data: await videos.service.listPublic() })));
router.get("/podcasts", cache(120), asyncHandler(async (req, res) => res.json({ data: await podcasts.service.listPublic() })));
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
router.get("/gallery", cache(30), validate({ query: pageQuery.extend({ limit: z.coerce.number().int().min(1).max(60).default(24) }) }),
  asyncHandler(async (req, res) => res.json(await galleryService.gallery(req.query))));

// GET /api/images?page=N — the photo album, ALBUM_PAGE_SIZE per page
router.get("/images", cache(30), validate({ query: pageQuery }), asyncHandler(async (req, res) => res.json(await galleryService.album(req.query))));

// ------------------------------------------------------------- registration (PDF §2, §3)
router.post("/registrations", registerLimiter, imageUploadFields(["photo", "photo_2"]), validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const files = [req.files?.photo?.[0], req.files?.photo_2?.[0]];
    const { replayed, ...result } = await registrations.register(req.body, files, { ip: req.ip, userAgent: req.get("user-agent") });
    res.status(replayed ? 200 : 201).json({ data: result });
  }));

router.get("/registrations/status", lookupLimiter, validate({ query: lookupSchema }),
  asyncHandler(async (req, res) => res.json({ data: await registrations.publicStatus(req.query.registration, req.query.phone) })));

router.post("/registrations/:registration/resubmit", lookupLimiter, imageUpload("photo"), validate({ body: resubmitSchema }),
  asyncHandler(async (req, res) => res.json({ data: await registrations.resubmit(req.params.registration, req.body, req.file) })));

// ------------------------------------------------------------- certificates (PDF §2.7, §2.8, §7)
async function sendCertificate(res, registration, phone) {
  const cert = await certificates.getForDownload(registration, phone);
  const pdf = await certificates.renderPdf(cert);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="Durgotsav-2026-${cert.certificate_no}.pdf"`,
    "Cache-Control": "no-store",
  });
  res.send(pdf);
}

router.get("/certificates/download", lookupLimiter, validate({ query: lookupSchema }),
  asyncHandler(async (req, res) => sendCertificate(res, req.query.registration, req.query.phone)));

router.get("/certificates/verify/:certificateNo", lookupLimiter,
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
