import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { checkPermission } from "../../middleware/permission.js";
import { lookupLimiter, nominationLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { createCrud } from "../shared/crud.factory.js";
import { bool, sortOrder, text, url } from "../shared/fields.js";
import { query } from "../../db/pool.js";
import { CATEGORIES, STATUSES } from "./award.constants.js";
import { csvWriter, responseSink, toPdf, xlsxWriter } from "./award.export.js";
import { adminListSchema, configSchema, lookupSchema, nominationSchema, remarkSchema, statusSchema } from "./award.schemas.js";
import * as award from "./award.service.js";
import { inspectUploads, nominationUpload, openDocument, removeTempUploads } from "./award.storage.js";

const idParams = z.object({ id: z.coerce.number().int().positive() });

// ================================================================ public: /api/shivdurg-award
export const publicAwardRouter = Router();

publicAwardRouter.get("/", asyncHandler(async (req, res) => {
  // Short cache: the open/closed status is derived from the current time
  res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  res.json({ data: await award.publicInfo() });
}));

const zodDetails = (error) => Object.fromEntries(error.issues.map((i) => [i.path.join(".") || "payload", i.message]));

publicAwardRouter.post("/nominations", nominationLimiter, asyncHandler(async (req, res) => {
  const edition = await award.currentEdition();
  // Reject before reading any upload when the window is closed
  if (!award.nominationWindow(edition).open) {
    req.resume();
    return res.status(403).json({ error: { code: "NOMINATIONS_CLOSED", message: "नामनिर्देशन सध्या स्वीकारले जात नाही." } });
  }
  await new Promise((resolve, reject) => nominationUpload(edition)(req, res, (err) => {
    if (!err) return resolve();
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? `प्रत्येक फाइल ${edition.max_upload_mb} MB पेक्षा लहान असावी`
        : err.code === "LIMIT_FILE_COUNT" ? `जास्तीत जास्त ${edition.max_documents} फाइल्स जोडता येतात` : err.message;
      return reject(badRequest(message, err.field ? { [err.field]: message } : undefined));
    }
    reject(err);
  }));
  try {
    let payload;
    try {
      payload = JSON.parse(req.body?.payload ?? "");
    } catch {
      throw badRequest("Malformed submission");
    }
    const parsed = nominationSchema.safeParse(payload);
    if (!parsed.success) throw badRequest("कृपया चिन्हांकित माहिती दुरुस्त करा", zodDetails(parsed.error));
    const files = await inspectUploads(req.files, edition);
    const { replayed, ...receipt } = await award.submitNomination(parsed.data, files, edition, { ip: req.ip, userAgent: req.get("user-agent") });
    res.status(replayed ? 200 : 201).json({ data: receipt });
  } finally {
    await removeTempUploads(req.files);
  }
}));

publicAwardRouter.get("/nominations/:reference", lookupLimiter,
  validate({ params: z.object({ reference: z.string().trim().regex(/^[A-Za-z0-9-]{5,30}$/) }), query: lookupSchema }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ data: await award.publicLookup(req.params.reference, req.query.mobile) });
  }));

// ================================================================ admin: /api/admin/shivdurg-award
export const adminAwardRouter = Router();
const canRead = checkPermission("shivdurg_award", "read");
const canReview = checkPermission("shivdurg_award", "write");
const canConfigure = checkPermission("shivdurg_award_config", "write");

adminAwardRouter.get("/options", canRead, asyncHandler(async (req, res) => {
  const info = await award.publicInfo();
  res.json({ data: { options: info.options } });
}));

adminAwardRouter.get("/stats", canRead,
  validate({ query: z.object({ edition_id: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()) }) }),
  asyncHandler(async (req, res) => res.json({ data: await award.stats(req.query.edition_id) })));

adminAwardRouter.get("/nominations", canRead, validate({ query: adminListSchema }),
  asyncHandler(async (req, res) => res.json(await award.adminList(req.query))));

function filterSummary(q) {
  return [
    q.category && CATEGORIES[q.category]?.en,
    q.status && STATUSES[q.status]?.en,
    q.district_id && `district #${q.district_id}`,
    q.taluka_id && `taluka #${q.taluka_id}`,
    q.work_category && `work: ${q.work_category}`,
    q.from && `from ${q.from}`,
    q.to && `to ${q.to}`,
    q.q && `search "${q.q}"`,
  ].filter(Boolean).join(", ");
}

const EXPORT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

adminAwardRouter.get("/nominations/export.:format", canRead, checkPermission("reports", "write"),
  validate({ params: z.object({ format: z.enum(["csv", "xlsx", "pdf"]) }), query: adminListSchema }),
  asyncHandler(async (req, res) => {
    const { format } = req.params;
    // Over-limit exports fail here as a normal JSON error, before any bytes go out
    const edition = await award.exportPrecheck(req.query, award.EXPORT_LIMITS[format]);
    const headers = {
      "Content-Type": EXPORT_TYPES[format],
      "Content-Disposition": `attachment; filename="shivdurg-bhushan-${edition.year}-nominations.${format}"`,
      "Cache-Control": "no-store",
    };
    let rowCount;

    if (format === "pdf") {
      const rows = [];
      rowCount = await award.streamExportRows(req.query, edition, async (batch) => { rows.push(...batch); });
      const body = await toPdf(rows, { title: `${edition.title} — नामनिर्देशने`, filters: filterSummary(req.query) });
      res.set(headers).send(body);
    } else {
      // CSV / Excel stream cursor batches straight to the client: memory stays flat for any number of rows
      res.set(headers);
      const writer = format === "csv" ? csvWriter(responseSink(res)) : xlsxWriter(responseSink(res), `Nominations ${edition.year}`);
      try {
        await writer.start();
        rowCount = await award.streamExportRows(req.query, edition, (batch) => writer.rows(batch));
        await writer.finish();
        res.end();
      } catch (err) {
        if (!res.headersSent) throw err;
        // Mid-stream failure: the status line is gone, so cut the connection and the download shows as failed
        if (!err.aborted) logger.error({ err }, "Nomination export failed mid-stream");
        res.destroy();
        return;
      }
    }
    audit(req, "export", "award_nomination", null, { format, rows: rowCount, filters: filterSummary(req.query) });
  }));

adminAwardRouter.get("/nominations/:id", canRead, validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const data = await award.adminDetail(req.params.id);
    audit(req, "view", "award_nomination", req.params.id);
    res.json({ data });
  }));

// Streams one evidence file. ?download=1 forces a download; otherwise inline (for preview).
adminAwardRouter.get("/nominations/:id/documents/:docId", canRead,
  validate({ params: idParams.extend({ docId: z.coerce.number().int().positive() }), query: z.object({ download: z.enum(["0", "1"]).optional() }) }),
  asyncHandler(async (req, res) => {
    const doc = await award.documentForDownload(req.params.id, req.params.docId);
    const stream = await openDocument(doc);
    const name = doc.original_name || `document-${doc.id}`;
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    res.set({
      "Content-Type": doc.mime_type || "application/octet-stream",
      "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    });
    if (doc.size_bytes) res.set("Content-Length", String(doc.size_bytes));
    audit(req, req.query.download === "1" ? "download" : "preview", "award_document", doc.id, { nomination: doc.reference_no });
    stream.on("error", (err) => res.destroy(err));
    stream.pipe(res);
  }));

adminAwardRouter.post("/nominations/:id/status", canReview, validate({ params: idParams, body: statusSchema }),
  asyncHandler(async (req, res) => {
    const change = await award.changeStatus(req.params.id, req.body.status, req.body.remarks, req.admin.id, req.ip);
    audit(req, "status_change", "award_nomination", req.params.id, { from: change.from, to: change.to, remarks: req.body.remarks });
    res.json({ data: await award.adminDetail(req.params.id) });
  }));

adminAwardRouter.post("/nominations/:id/remarks", canReview, validate({ params: idParams, body: remarkSchema }),
  asyncHandler(async (req, res) => {
    const remark = await award.addRemark(req.params.id, req.body.body, req.admin.id);
    audit(req, "remark", "award_nomination", req.params.id);
    res.status(201).json({ data: remark });
  }));

// ---------------------------------------------------------------- configuration (dates, content, limits)
adminAwardRouter.get("/config", checkPermission("shivdurg_award_config", "read"),
  asyncHandler(async (req, res) => res.json({ data: await award.adminConfig() })));

adminAwardRouter.put("/config", canConfigure, validate({ body: configSchema }),
  asyncHandler(async (req, res) => {
    const before = await award.adminConfig();
    const data = await award.updateConfig(req.body, req.admin.id);
    const changed = Object.keys(req.body).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(data[k]));
    audit(req, "update", "award_config", data.id, { fields: changed });
    res.json({ data });
  }));

// ---------------------------------------------------------------- committee members & public winners (generic CRUD)
export const awardCommittee = createCrud({
  table: "award_committee_members",
  entity: "award_committee_member",
  guard: (req, res, next) => (req.method === "GET" ? checkPermission("shivdurg_award_config", "read") : canConfigure)(req, res, next),
  searchable: ["name", "name_en", "designation"],
  filters: { is_active: "bool" },
  schema: z.object({
    name: text(160, { required: true }),
    name_en: text(160),
    designation: text(300),
    designation_en: text(300),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
  // New members join the edition shown on the website
  beforeSave: async (data, id) => {
    if (id) return data;
    const { rows } = await query("SELECT id FROM award_editions WHERE is_current LIMIT 1");
    return { ...data, edition_id: rows[0]?.id };
  },
});

export const awardWinners = createCrud({
  table: "award_winners",
  entity: "award_winner",
  guard: (req, res, next) => (req.method === "GET" ? checkPermission("shivdurg_award_config", "read") : canConfigure)(req, res, next),
  searchable: ["name", "name_en", "description"],
  filters: { is_active: "bool", category: "string" },
  order: "year DESC NULLS LAST, sort_order ASC, id ASC",
  schema: z.object({
    name: text(250, { required: true }),
    name_en: text(250),
    category: z.enum(["individual", "organization"]),
    year: z.preprocess((v) => (v === "" || v === null ? null : v), z.coerce.number().int().min(1900).max(2100).nullable().optional()),
    description: text(2000),
    description_en: text(2000),
    photo: url(),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
});

adminAwardRouter.use("/committee", awardCommittee.router);
adminAwardRouter.use("/winners", awardWinners.router);
