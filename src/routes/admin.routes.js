import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import { z } from "zod";
import { EDITION_YEAR } from "../config/edition.js";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { admission } from "../middleware/admission.js";
import { authenticate } from "../middleware/auth.js";
import { checkExplicitPermission, checkPermission, scopeToAdminDivisions } from "../middleware/permission.js";
import { imageUpload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit, auditMany } from "../services/audit.service.js";
import { storeContentImage } from "../services/image.service.js";
import { asyncHandler, badRequest } from "../utils/errors.js";
import { formatRegistrationNo } from "../utils/format.js";
import { logger } from "../utils/logger.js";
import { assertBrowsable, cappedCount, cappedMeta, paginate, paginationSchema, sortParams, sortSql } from "../utils/pagination.js";
import { adminsRouter } from "../modules/auth/auth.module.js";
import { rbacRouter } from "../modules/rbac/rbac.module.js";
import { adminAwardRouter } from "../modules/award/award.routes.js";
import * as registrations from "../modules/registrations/registrations.service.js";
import { wakeRejectionEmails } from "../modules/registrations/rejection-emails.js";
import {
  adminListSchema, bulkReviewSchema, featureSchema, reviewSchema, updateRegistrationSchema,
} from "../modules/registrations/registrations.schemas.js";
import * as certificates from "../modules/certificates/certificates.service.js";
import { wakeCertificateWorker } from "../modules/certificates/certificate.worker.js";
import { queueCertificateSms } from "../modules/sms/sms.queue.js";
import { wakeSmsWorker } from "../modules/sms/sms.worker.js";
import * as galleryService from "../modules/gallery/gallery.service.js";
import * as stats from "../modules/stats/stats.service.js";
import { getAllSettings, registrationWindow, updateSettings } from "../modules/settings/settings.service.js";
import { settingsUpdateSchema } from "../modules/settings/settings.definitions.js";
import { forts, fortImagesRouter } from "../modules/forts/forts.module.js";
import {
  announcements, districts, divisions, enquiries, events, faqs, pages, podcasts, talukas, testimonials, videos,
} from "../modules/content/content.resources.js";

const router = Router();
router.use(authenticate);

const idParams = z.object({ id: z.coerce.number().int().positive() });

// ------------------------------------------------------------- dashboard
router.get("/stats/dashboard",
  checkPermission("dashboard", "read"),
  scopeToAdminDivisions,
  asyncHandler(async (req, res) =>
    res.json({ data: await stats.dashboard(req.allowedDivisionIds) })));

const districtStatsSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  ...sortParams(Object.keys(stats.DISTRICT_SORTS), "total"),
});

router.get("/stats/districts",
  checkPermission("dashboard", "read"),
  scopeToAdminDivisions,
  validate({ query: districtStatsSchema }),
  asyncHandler(async (req, res) =>
    res.json({ data: await stats.districtStats(req.allowedDivisionIds, req.query) })));

const divisionStatsSchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  ...sortParams(Object.keys(stats.DIVISION_SORTS), "total"),
});

router.get("/stats/divisions",
  checkPermission("dashboard", "read"),
  scopeToAdminDivisions,
  validate({ query: divisionStatsSchema }),
  asyncHandler(async (req, res) =>
    res.json({ data: await stats.divisionStats(req.allowedDivisionIds, req.query) })));

const cityStatsSchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(25),
  ...sortParams(Object.keys(stats.CITY_SORTS), "registrations"),
  district: z.string().max(120).optional(),
});

router.get("/stats/cities",
  checkPermission("dashboard", "read"),
  scopeToAdminDivisions,
  validate({ query: cityStatsSchema }),
  asyncHandler(async (req, res) =>
    res.json({ data: await stats.cityStats(req.allowedDivisionIds, req.query) })));

// ------------------------------------------------------------- registrations / moderation
const reg = Router();
reg.use(checkPermission("registrations", "read"), scopeToAdminDivisions);

reg.get("/", validate({ query: adminListSchema }),
  asyncHandler(async (req, res) =>
    res.json(await registrations.adminList(req.query, req.allowedDivisionIds))));

// An export reads every matching registration; a few at a time per process keeps them from crowding out moderation
const exportAdmission = admission({
  concurrency: 2, queue: 0, retryAfterSeconds: 60, message: "Another export is being prepared. Please try again in a minute",
});

reg.get("/export.csv",
  checkPermission("reports", "write"),
  exportAdmission,
  validate({ query: adminListSchema }),
  asyncHandler(async (req, res) => {
    // The complete record (SRS v2.1 §6); columns the current form no longer asks for stay for earlier registrations
    const cols = ["registration_no", "name", "participant_type", "organization_name", "members_count", "phone", "whatsapp_number", "email",
      "country", "division", "district", "taluka", "city", "fort", "replica_notes", "status", "review_note",
      "certificate_no", "durgveer_no", "certificate_revoked_at", "source", "created_at"];
    const cell = (v) => {
      let s = v instanceof Date ? v.toISOString() : String(v ?? "");
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="durgotsav-${EDITION_YEAR}-registrations.csv"`,
      "Cache-Control": "no-store",
    });
    let rowCount = 0;
    async function* csv() {
      yield "﻿" + cols.join(",") + "\n";
      for await (const batch of registrations.adminExportStream(req.query, req.allowedDivisionIds)) {
        rowCount += batch.length;
        yield batch.map((r) => cols.map((c) => cell(r[c])).join(",")).join("\n") + "\n";
      }
    }
    // pipeline() reads the next batch only when the download has taken the last one (memory stays flat however many
    // rows), and stops reading the database as soon as the admin cancels the download
    try {
      await pipeline(Readable.from(csv()), res);
      audit(req, "export", "registration", null, { rows: rowCount });
    } catch (err) {
      if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") logger.warn({ err, rows: rowCount }, "Registration export stopped");
      res.destroy();
    }
  }));

reg.post("/bulk-review",
  checkPermission("registrations", "write"),
  checkExplicitPermission("moderation_bulk"),
  validate({ body: bulkReviewSchema }),
  asyncHandler(async (req, res) => {
    if ((req.body.action === "reject" || req.body.action === "request_info") && !req.body.note) {
      throw badRequest("Please give the participants a reason", { note: "Required" });
    }
    const changed = await registrations.review(
      req.body.ids, req.body.action, req.body.note, req.admin.id, req.allowedDivisionIds);
    auditMany(req, req.body.action, "registration", changed, { bulk: true, note: req.body.note });
    if (req.body.action === "verify") {
      wakeCertificateWorker(); // the certificate email and SMS were queued in the review transaction
      wakeSmsWorker();
    }
    if (req.body.action === "reject") wakeRejectionEmails(); // the notices were queued in the review transaction
    res.json({ data: { updated: changed } });
  }));

reg.post("/photos/feature",
  checkPermission("moderation", "write"),
  validate({ body: featureSchema }),
  asyncHandler(async (req, res) => {
    const updated = await registrations.setFeatured(req.body.photo_ids, req.body.featured, req.allowedDivisionIds);
    audit(req, req.body.featured ? "feature" : "unfeature", "photo", null, { photo_ids: updated });
    res.json({ data: { updated, skipped: req.body.photo_ids.length - updated.length } });
  }));

reg.get("/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) =>
    res.json({ data: await registrations.adminDetail(req.params.id, req.allowedDivisionIds) })));

// Previous / next record and position in a list with these filters (the review queue's Previous / Next)
reg.get("/:id/neighbors",
  validate({ params: idParams, query: adminListSchema }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ data: await registrations.neighbors(req.params.id, req.query, req.allowedDivisionIds) });
  }));

reg.get("/:id/photos/:photoId/original",
  checkPermission("registrations_photos", "read"),
  validate({ params: idParams.extend({ photoId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ data: await registrations.photoOriginalUrl(req.params.id, req.params.photoId, req.allowedDivisionIds) });
  }));

reg.put("/:id",
  checkPermission("registrations", "write"),
  validate({ params: idParams, body: updateRegistrationSchema }),
  asyncHandler(async (req, res) => {
    const data = await registrations.update(req.params.id, req.body, req.allowedDivisionIds);
    audit(req, "update", "registration", req.params.id, { fields: Object.keys(req.body) });
    res.json({ data });
  }));

reg.post("/:id/review",
  checkPermission("registrations", "write"),
  validate({ params: idParams, body: reviewSchema }),
  asyncHandler(async (req, res) => {
    const changed = await registrations.review(
      [req.params.id], req.body.action, req.body.note, req.admin.id, req.allowedDivisionIds);
    if (!changed.length) throw badRequest("Registration not found or deleted");
    audit(req, req.body.action, "registration", req.params.id, { note: req.body.note });
    if (req.body.action === "verify") {
      wakeCertificateWorker(); // the certificate email and SMS were queued in the review transaction
      wakeSmsWorker();
    }
    if (req.body.action === "reject") wakeRejectionEmails(); // the notices were queued in the review transaction
    res.json({ data: await registrations.adminDetail(req.params.id, req.allowedDivisionIds) });
  }));

// SRS v2.1 §6: re-render an approved registration's certificate (e.g. after correcting the name); issues it if missing
reg.post("/:id/certificate/regenerate",
  checkPermission("certificates", "write"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await registrations.assertRegistrationScope(req.params.id, req.allowedDivisionIds);
    const cert = await certificates.regenerate(req.params.id, req.admin.id);
    audit(req, "regenerate_certificate", "registration", req.params.id, { certificate_no: cert.certificate_no });
    wakeCertificateWorker();
    res.json({ data: await registrations.adminDetail(req.params.id, req.allowedDivisionIds) });
  }));

// SRS v2.1 §6: send the certificate link to the registered mobile again, by hand (queued; the SMS worker sends it)
reg.post("/:id/sms",
  checkPermission("registrations", "write"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await registrations.assertRegistrationScope(req.params.id, req.allowedDivisionIds);
    const sms = await queueCertificateSms(req.params.id, req.admin.id);
    audit(req, "send_sms", "registration", req.params.id, { sms_id: sms.id });
    wakeSmsWorker();
    res.json({ data: sms });
  }));

reg.delete("/:id",
  checkPermission("registrations", "delete"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await registrations.softDelete(req.params.id, req.allowedDivisionIds);
    audit(req, "delete", "registration", req.params.id);
    res.status(204).end();
  }));

reg.post("/:id/restore",
  checkPermission("registrations", "delete"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await registrations.restore(req.params.id, req.allowedDivisionIds);
    audit(req, "restore", "registration", req.params.id);
    res.json({ data: await registrations.adminDetail(req.params.id, req.allowedDivisionIds) });
  }));

router.use("/registrations", reg);

// ------------------------------------------------------------- certificates
const cert = Router();
cert.use(checkPermission("certificates", "read"));
cert.get("/", validate({
  query: paginationSchema.extend({
    q: z.string().trim().max(100).optional(),
    state: z.enum(["valid", "revoked"]).optional(),
    emailed: z.enum(["yes", "no"]).optional(),
    email_status: z.enum(["queued", "processing", "sent", "failed", "skipped", "cancelled", "none"]).optional(),
    ...sortParams(Object.keys(certificates.ADMIN_SORTS), "issued_at"),
  }),
}), asyncHandler(async (req, res) => res.json(await certificates.adminList(req.query))));

// Email queue health: counts per status, next due time, recent throughput
cert.get("/email-queue", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: { ...(await certificates.emailQueueStats()), mail_enabled: env.mailEnabled } });
}));

cert.get("/:id/pdf", validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const c = await certificates.adminGet(req.params.id);
    res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${c.certificate_no}.pdf"`, "Cache-Control": "no-store" });
    res.send(await certificates.renderPdf(c));
  }));

// Every delivery attempt for one certificate (what was sent, to whom, SMTP's answer or the error)
cert.get("/:id/email-log", validate({ params: idParams }),
  asyncHandler(async (req, res) => res.json({ data: await certificates.deliveryLog(req.params.id) })));

cert.post("/:id/resend", validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const status = await certificates.resend(req.params.id, req.admin.id);
    audit(req, "resend", "certificate", req.params.id, { status });
    wakeCertificateWorker();
    res.json({ data: { status } });
  }));

cert.post("/send-pending",
  checkPermission("certificates", "write"),
  asyncHandler(async (req, res) => {
    const queued = await certificates.queuePending(req.admin.id);
    audit(req, "send_pending", "certificate", null, { count: queued });
    wakeCertificateWorker();
    res.json({ data: { queued } });
  }));

cert.post("/retry-failed",
  checkPermission("certificates", "write"),
  asyncHandler(async (req, res) => {
    const queued = await certificates.retryFailed(req.admin.id);
    audit(req, "retry_failed", "certificate", null, { count: queued });
    wakeCertificateWorker();
    res.json({ data: { queued } });
  }));

cert.post("/:id/revoke",
  checkPermission("certificates", "write"),
  validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  asyncHandler(async (req, res) => {
    await certificates.revoke(req.params.id, req.admin.id, req.body.reason);
    audit(req, "revoke", "certificate", req.params.id, { reason: req.body.reason });
    res.json({ ok: true });
  }));

cert.post("/:id/reinstate",
  checkPermission("certificates", "write"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    await certificates.reinstate(req.params.id, req.admin.id);
    audit(req, "reinstate", "certificate", req.params.id);
    wakeCertificateWorker();
    res.json({ ok: true });
  }));
router.use("/certificates", cert);

// ------------------------------------------------------------- website gallery
const websiteGallery = Router();
websiteGallery.use(scopeToAdminDivisions);

const websiteGalleryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  display_status: z.enum(["all", "selected", "unselected", "featured", "not_featured"]).default("all"),
  division_id: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  district_id: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  taluka_id: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  fort_id: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  sort: z.enum(["newest", "oldest", "name", "display_first", "display_last"]).default("newest"),
  q: z.string().trim().max(100).optional(),
});

websiteGallery.get("/",
  checkPermission("website_gallery", "read"),
  validate({ query: websiteGalleryQuerySchema }),
  asyncHandler(async (req, res) => {
    res.json({ data: await galleryService.adminListVerifiedPhotos(req.query, req.allowedDivisionIds) });
  }));

websiteGallery.post("/toggle",
  checkPermission("website_gallery", "write"),
  validate({
    body: z.object({
      photo_id: z.coerce.number().int().positive(),
      featured: z.boolean(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const updated = await galleryService.setWebsiteGalleryDisplay(
      [req.body.photo_id], req.body.featured, req.allowedDivisionIds,
    );
    audit(req, req.body.featured ? "website_gallery_add" : "website_gallery_remove", "photo", req.body.photo_id, {
      featured: req.body.featured,
    });
    res.json({ data: { updated: updated.length > 0, photo_id: req.body.photo_id, featured: req.body.featured } });
  }));

websiteGallery.post("/bulk",
  checkPermission("website_gallery", "write"),
  checkExplicitPermission("website_gallery_bulk"),
  validate({
    body: z.object({
      photo_ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
      featured: z.boolean(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const updated = await galleryService.setWebsiteGalleryDisplay(
      req.body.photo_ids, req.body.featured, req.allowedDivisionIds,
    );
    audit(req, req.body.featured ? "website_gallery_bulk_add" : "website_gallery_bulk_remove", "photo", null, {
      count: updated.length,
      featured: req.body.featured,
      photo_ids: updated,
    });
    res.json({ data: { updated, count: updated.length, skipped: req.body.photo_ids.length - updated.length } });
  }));

router.use("/website-gallery", websiteGallery);

// ------------------------------------------------------------- शिवदुर्ग भूषण पुरस्कार
router.use("/shivdurg-award", adminAwardRouter);

// ------------------------------------------------------------- RBAC (roles + division grants)
router.use("/rbac", rbacRouter);

// ------------------------------------------------------------- CMS resources
router.use("/forts/:id/images", checkPermission("forts", "write"), fortImagesRouter);
router.use("/forts", forts.router);
router.use("/events",        events.router);
router.use("/videos",        videos.router);
router.use("/podcasts",      podcasts.router);
router.use("/announcements", announcements.router);
router.use("/testimonials",  testimonials.router);
router.use("/faqs",          faqs.router);
router.use("/pages",         pages.router);
router.use("/enquiries",     enquiries.router);
router.use("/divisions",     divisions.router);
router.use("/districts",     districts.router);
router.use("/talukas",       talukas.router);
router.use("/admins",        adminsRouter);

// Generic CMS image upload
router.post("/uploads",
  // Award photos are uploaded by award staff, who may not have the forts permission
  (req, res, next) => (req.query.folder === "awards" ? checkPermission("shivdurg_award_config", "write") : checkPermission("forts", "write"))(req, res, next),
  validate({ query: z.object({ folder: z.enum(["forts", "content", "videos", "testimonials", "awards"]) }) }),
  imageUpload("file", { maxMb: 10 }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No file uploaded", { file: "Required" });
    const result = await storeContentImage(req.file, req.query.folder);
    audit(req, "upload", "file", null, { url: result.url });
    res.status(201).json({ data: result });
  }));

// ------------------------------------------------------------- settings
// meta: whether the registration form is open right now, and whether .env forces it open (the admin switch can't close it then)
async function settingsResponse() {
  const rows = await getAllSettings();
  return {
    data: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    meta: { registration_status: await registrationWindow(), registration_force_open_env: env.REGISTRATION_FORCE_OPEN },
  };
}

router.get("/settings",  checkPermission("settings", "read"),  asyncHandler(async (req, res) => {
  res.json(await settingsResponse());
}));

router.put("/settings",  checkPermission("settings", "write"), validate({ body: settingsUpdateSchema }),
  asyncHandler(async (req, res) => {
    await updateSettings(req.body, req.admin.id);
    // The force-open switch is recorded with its new value, so the audit log shows who opened or closed registration
    audit(req, "update", "settings", null, { keys: Object.keys(req.body), ...("registration_force_open" in req.body && { registration_force_open: req.body.registration_force_open }) });
    res.json(await settingsResponse());
  }));

// ------------------------------------------------------------- audit logs
// ids rise with created_at, so "When" sorts on the primary key; action / entity have (column, id) indexes (migration 031)
const AUDIT_SORTS = {
  created_at: { cols: "l.id", dir: "desc" },
  action: { cols: "l.action, l.id", dir: "asc" },
  entity: { cols: "l.entity, l.id", dir: "asc" },
};

router.get("/audit-logs", checkPermission("audit_logs", "read"), validate({
  query: paginationSchema.extend({
    entity:   z.string().max(60).optional(),
    action:   z.string().max(60).optional(),
    admin_id: z.coerce.number().int().positive().optional(),
    ...sortParams(Object.keys(AUDIT_SORTS), "created_at"),
  }),
}), asyncHandler(async (req, res) => {
  const where = [];
  const params = [];
  for (const key of ["entity", "action", "admin_id"]) {
    if (req.query[key] === undefined) continue;
    params.push(req.query[key]);
    where.push(`l.${key} = $${params.length}`);
  }
  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // The log grows with every admin action: counting stops at COUNT_CAP and older pages are reached through the filters
  assertBrowsable(req.query, "entries");
  const { limit, offset } = paginate(req.query);
  const [list, count] = await Promise.all([
    query(
      `SELECT l.*, a.name AS admin_name, a.email AS admin_email FROM audit_logs l
       LEFT JOIN admins a ON a.id = l.admin_id ${sqlWhere} ORDER BY ${sortSql(AUDIT_SORTS, req.query, "created_at")} LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    cappedCount(query, `FROM audit_logs l ${sqlWhere}`, params),
  ]);
  res.json({
    data: list.rows.map((r) =>
      r.entity === "registration" && r.entity_id ? { ...r, entity_label: formatRegistrationNo(r.entity_id) } : r),
    meta: cappedMeta(req.query, count),
  });
}));

// Lookups for filter dropdowns — scope divisions list to the admin's access
router.get("/lookups",
  checkPermission("dashboard", "read"),
  scopeToAdminDivisions,
  asyncHandler(async (req, res) => {
    const divFilter = req.allowedDivisionIds === null
      ? ""
      : `AND d.division_id = ANY(ARRAY[${req.allowedDivisionIds.map(Number).join(",")}]::int[])`;
    const [distList, fortList, divList, talukaList] = await Promise.all([
      query(`SELECT id, name_mr, name_en, division_id FROM districts
             WHERE deleted_at IS NULL ${divFilter} ORDER BY sort_order`),
      query("SELECT id, name_mr, name_en FROM forts WHERE deleted_at IS NULL ORDER BY sort_order, id"),
      query(`SELECT id, name_mr, name_en FROM divisions WHERE deleted_at IS NULL
             ${req.allowedDivisionIds !== null
               ? `AND id = ANY(ARRAY[${req.allowedDivisionIds.map(Number).join(",")}]::int[])`
               : ""} ORDER BY sort_order`),
      query(`SELECT t.id, t.name_mr, t.name_en, t.district_id FROM talukas t
             JOIN districts d ON d.id = t.district_id
             WHERE t.deleted_at IS NULL ${divFilter} ORDER BY t.district_id, t.sort_order`),
    ]);
    res.json({ data: { districts: distList.rows, forts: fortList.rows, divisions: divList.rows, talukas: talukaList.rows } });
  }));

export default router;
