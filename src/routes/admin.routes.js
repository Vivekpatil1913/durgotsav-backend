import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { imageUpload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { storeContentImage } from "../services/image.service.js";
import { asyncHandler, badRequest } from "../utils/errors.js";
import { formatRegistrationNo } from "../utils/format.js";
import { paginate, pageMeta, paginationSchema } from "../utils/pagination.js";
import { adminsRouter } from "../modules/auth/auth.module.js";
import * as registrations from "../modules/registrations/registrations.service.js";
import {
  adminListSchema, bulkReviewSchema, featureSchema, reviewSchema, updateRegistrationSchema,
} from "../modules/registrations/registrations.schemas.js";
import * as certificates from "../modules/certificates/certificates.service.js";
import * as stats from "../modules/stats/stats.service.js";
import { getAllSettings, updateSettings } from "../modules/settings/settings.service.js";
import { settingsUpdateSchema } from "../modules/settings/settings.definitions.js";
import { forts, fortImagesRouter } from "../modules/forts/forts.module.js";
import { announcements, enquiries, events, faqs, pages, testimonials, videos } from "../modules/content/content.resources.js";

const router = Router();
router.use(authenticate);

const idParams = z.object({ id: z.coerce.number().int().positive() });
const staff = authorize("admin", "moderator");

// ------------------------------------------------------------- dashboard
router.get("/stats/dashboard", staff, asyncHandler(async (req, res) => res.json({ data: await stats.dashboard() })));
router.get("/stats/districts", staff, asyncHandler(async (req, res) => res.json({ data: await stats.districtStats() })));

// ------------------------------------------------------------- registrations / moderation
const reg = Router();
reg.use(staff);

reg.get("/", validate({ query: adminListSchema }), asyncHandler(async (req, res) => res.json(await registrations.adminList(req.query))));

reg.get("/export.csv", validate({ query: adminListSchema }), asyncHandler(async (req, res) => {
  const rows = await registrations.adminExportRows(req.query);
  const cols = ["registration_no", "name", "participant_type", "organization_name", "phone", "email", "country", "district", "city", "fort", "status", "review_note", "certificate_no", "created_at"];
  // Prefix formula-like cells so spreadsheets don't execute them (CSV injection)
  const cell = (v) => {
    let s = v instanceof Date ? v.toISOString() : String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  audit(req, "export", "registration", null, { rows: rows.length });
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="durgotsav-2026-registrations.csv"' });
  res.send(`﻿${csv}`); // BOM so Excel reads Devanagari correctly
}));

reg.post("/bulk-review", validate({ body: bulkReviewSchema }), asyncHandler(async (req, res) => {
  if ((req.body.action === "reject" || req.body.action === "request_info") && !req.body.note) {
    throw badRequest("Please give the participants a reason", { note: "Required" });
  }
  const changed = await registrations.review(req.body.ids, req.body.action, req.body.note, req.admin.id);
  changed.forEach((id) => audit(req, req.body.action, "registration", id, { bulk: true, note: req.body.note }));
  if (req.body.action === "verify") certificates.notifyInBackground(changed);
  res.json({ data: { updated: changed } });
}));

reg.post("/photos/feature", validate({ body: featureSchema }), asyncHandler(async (req, res) => {
  const updated = await registrations.setFeatured(req.body.photo_ids, req.body.featured);
  audit(req, req.body.featured ? "feature" : "unfeature", "photo", null, { photo_ids: updated });
  res.json({ data: { updated, skipped: req.body.photo_ids.length - updated.length } });
}));

reg.get("/:id", validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ data: await registrations.adminDetail(req.params.id) })));

reg.put("/:id", validate({ params: idParams, body: updateRegistrationSchema }), asyncHandler(async (req, res) => {
  const data = await registrations.update(req.params.id, req.body);
  audit(req, "update", "registration", req.params.id, { fields: Object.keys(req.body) });
  res.json({ data });
}));

reg.post("/:id/review", validate({ params: idParams, body: reviewSchema }), asyncHandler(async (req, res) => {
  const changed = await registrations.review([req.params.id], req.body.action, req.body.note, req.admin.id);
  if (!changed.length) throw badRequest("Registration not found or deleted");
  audit(req, req.body.action, "registration", req.params.id, { note: req.body.note });
  if (req.body.action === "verify") certificates.notifyInBackground(changed);
  res.json({ data: await registrations.adminDetail(req.params.id) });
}));

reg.delete("/:id", authorize("admin"), validate({ params: idParams }), asyncHandler(async (req, res) => {
  await registrations.softDelete(req.params.id);
  audit(req, "delete", "registration", req.params.id);
  res.status(204).end();
}));

reg.post("/:id/restore", authorize("admin"), validate({ params: idParams }), asyncHandler(async (req, res) => {
  await registrations.restore(req.params.id);
  audit(req, "restore", "registration", req.params.id);
  res.json({ data: await registrations.adminDetail(req.params.id) });
}));

router.use("/registrations", reg);

// ------------------------------------------------------------- certificates
const cert = Router();
cert.use(staff);
cert.get("/", validate({
  query: paginationSchema.extend({
    q: z.string().trim().max(100).optional(),
    state: z.enum(["valid", "revoked"]).optional(),
    emailed: z.enum(["yes", "no"]).optional(),
  }),
}), asyncHandler(async (req, res) => res.json(await certificates.adminList(req.query))));

cert.get("/:id/pdf", validate({ params: idParams }), asyncHandler(async (req, res) => {
  const c = await certificates.adminGet(req.params.id);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${c.certificate_no}.pdf"`, "Cache-Control": "no-store" });
  res.send(await certificates.renderPdf(c));
}));

cert.post("/:id/resend", validate({ params: idParams }), asyncHandler(async (req, res) => {
  const result = await certificates.notify(req.params.id);
  audit(req, "resend", "certificate", req.params.id, result);
  res.json({ data: result });
}));

cert.post("/send-pending", authorize("admin"), asyncHandler(async (req, res) => {
  const ids = await certificates.pendingEmailIds();
  certificates.notifyInBackground(ids);
  audit(req, "send_pending", "certificate", null, { count: ids.length });
  res.json({ data: { queued: ids.length } });
}));

cert.post("/:id/revoke", authorize("admin"), validate({ params: idParams, body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  asyncHandler(async (req, res) => {
    await certificates.revoke(req.params.id, req.admin.id, req.body.reason);
    audit(req, "revoke", "certificate", req.params.id, { reason: req.body.reason });
    res.json({ ok: true });
  }));

cert.post("/:id/reinstate", authorize("admin"), validate({ params: idParams }), asyncHandler(async (req, res) => {
  await certificates.reinstate(req.params.id);
  audit(req, "reinstate", "certificate", req.params.id);
  res.json({ ok: true });
}));
router.use("/certificates", cert);

// ------------------------------------------------------------- CMS resources
router.use("/forts/:id/images", authorize("admin"), fortImagesRouter);
router.use("/forts", forts.router);
router.use("/events", events.router);
router.use("/videos", videos.router);
router.use("/announcements", announcements.router);
router.use("/testimonials", testimonials.router);
router.use("/faqs", faqs.router);
router.use("/pages", pages.router);
router.use("/enquiries", enquiries.router);
router.use("/admins", adminsRouter);

// Generic image upload for CMS forms; returns the public URL to store in the record
router.post("/uploads", authorize("admin"), validate({ query: z.object({ folder: z.enum(["forts", "content", "videos", "testimonials"]) }) }),
  imageUpload("file", { maxMb: 10 }), asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest("No file uploaded", { file: "Required" });
    const result = await storeContentImage(req.file, req.query.folder);
    audit(req, "upload", "file", null, { url: result.url });
    res.status(201).json({ data: result });
  }));

// ------------------------------------------------------------- settings
router.get("/settings", authorize("admin"), asyncHandler(async (req, res) => {
  const rows = await getAllSettings();
  res.json({ data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));

router.put("/settings", authorize("admin"), validate({ body: settingsUpdateSchema }), asyncHandler(async (req, res) => {
  await updateSettings(req.body, req.admin.id);
  audit(req, "update", "settings", null, { keys: Object.keys(req.body) });
  const rows = await getAllSettings();
  res.json({ data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));

// ------------------------------------------------------------- audit logs
router.get("/audit-logs", authorize("admin"), validate({
  query: paginationSchema.extend({
    entity: z.string().max(60).optional(),
    action: z.string().max(60).optional(),
    admin_id: z.coerce.number().int().positive().optional(),
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
  const { limit, offset } = paginate(req.query);
  const [list, count] = await Promise.all([
    query(`SELECT l.*, a.name AS admin_name, a.email AS admin_email FROM audit_logs l
           LEFT JOIN admins a ON a.id = l.admin_id ${sqlWhere} ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total FROM audit_logs l ${sqlWhere}`, params),
  ]);
  res.json({
    data: list.rows.map((r) => (r.entity === "registration" && r.entity_id ? { ...r, entity_label: formatRegistrationNo(r.entity_id) } : r)),
    meta: pageMeta(req.query, count.rows[0].total),
  });
}));

// Lookups for admin filter dropdowns
router.get("/lookups", staff, asyncHandler(async (req, res) => {
  const [districts, fortList] = await Promise.all([
    query("SELECT id, name_mr, name_en FROM districts ORDER BY sort_order"),
    query("SELECT id, name_mr, name_en FROM forts WHERE deleted_at IS NULL ORDER BY sort_order, id"),
  ]);
  res.json({ data: { districts: districts.rows, forts: fortList.rows } });
}));

export default router;
