// Admin → Registrations → Import Excel. Mounted at /api/admin/registrations/imports (authenticated by the admin router).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { EDITION_YEAR } from "../../config/edition.js";
import { env } from "../../config/env.js";
import { paths } from "../../config/paths.js";
import { checkExplicitPermission, checkPermission, scopeToAdminDivisions } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { csvLine } from "../award/award.export.js";
import { SHEET_TYPES } from "./import.reader.js";
import * as imports from "./import.service.js";
import { templateWorkbook } from "./import.template.js";

export const importRouter = Router();
importRouter.use(checkPermission("registrations", "read"));

const MB = 1024 * 1024;
const idParams = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });
const extOf = (name) => path.extname(String(name ?? "")).toLowerCase();

fs.mkdirSync(paths.imports, { recursive: true });

// Sheets and archives go to disk (storage/imports), never into memory: a ZIP of photos may be gigabytes
const upload = multer({
  storage: multer.diskStorage({
    destination: paths.imports,
    filename: (req, file, cb) => cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}${extOf(file.originalname)}`),
  }),
  limits: { files: 2, fields: 10, fieldSize: 1024, fileSize: Math.max(env.IMPORT_SHEET_MAX_MB, env.IMPORT_ZIP_MAX_MB) * MB },
  fileFilter: (req, file, cb) => {
    const ext = extOf(file.originalname);
    if (file.fieldname === "file" && !SHEET_TYPES[ext]) {
      return cb(badRequest(ext === ".xls"
        ? "Old .xls files are not supported. Open it in Excel and save as .xlsx (Excel Workbook) or .csv"
        : "Please choose an Excel (.xlsx) or CSV (.csv) file", { file: "Unsupported file type" }));
    }
    if (file.fieldname === "photos" && ext !== ".zip") return cb(badRequest("Photos must be uploaded as one .zip file", { photos: "Unsupported file type" }));
    cb(null, true);
  },
}).fields([{ name: "file", maxCount: 1 }, { name: "photos", maxCount: 1 }]);

const removeUploads = (req) => Object.values(req.files ?? {}).flat().forEach((f) => fs.unlink(f.path, () => {}));

// Multer's own errors in this upload's words (and nothing left behind on disk)
const receiveUpload = (req, res, next) => upload(req, res, (err) => {
  if (!err) return next();
  removeUploads(req);
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `The file is too large (sheet up to ${env.IMPORT_SHEET_MAX_MB} MB, ZIP up to ${env.IMPORT_ZIP_MAX_MB} MB). Split it into smaller batches`
      : err.code === "LIMIT_UNEXPECTED_FILE" ? `Unexpected file field "${err.field}" (use "file" and "photos")` : err.message;
    return next(badRequest(message, err.field ? { [err.field]: message } : undefined));
  }
  next(err);
});

// File signatures: .xlsx and .zip are ZIP archives ("PK")
function startsWithZipSignature(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    return head.toString("latin1") === "PK";
  } finally {
    fs.closeSync(fd);
  }
}

importRouter.get("/template.xlsx", asyncHandler(async (req, res) => {
  const body = await templateWorkbook();
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="durgotsav-${EDITION_YEAR}-registration-import-template.xlsx"`,
    "Cache-Control": "no-store",
  }).send(Buffer.from(body));
}));

importRouter.get("/", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await imports.listImports() });
}));

// Approving registrations in bulk: the same rights as the Registrations page's bulk "Verify"
importRouter.post("/",
  checkPermission("registrations", "write"),
  checkExplicitPermission("moderation_bulk"),
  scopeToAdminDivisions,
  receiveUpload,
  asyncHandler(async (req, res) => {
    const sheet = req.files?.file?.[0];
    const zip = req.files?.photos?.[0];
    try {
      if (!sheet) throw badRequest("Please choose the Excel (.xlsx) or CSV file to import", { file: "Required" });
      if (sheet.size > env.IMPORT_SHEET_MAX_MB * MB) throw badRequest(`The sheet is larger than ${env.IMPORT_SHEET_MAX_MB} MB. Split it into smaller files`, { file: "Too large" });
      const type = SHEET_TYPES[extOf(sheet.originalname)];
      if (type === "xlsx" && !startsWithZipSignature(sheet.path)) throw badRequest("This is not a valid .xlsx file. Save it from Excel as .xlsx (Excel Workbook) or .csv", { file: "Invalid file" });
      if (zip && !startsWithZipSignature(zip.path)) throw badRequest("The photos file is not a valid .zip archive", { photos: "Invalid file" });
      const created = await imports.createImport({
        sheet: { path: sheet.path, originalname: sheet.originalname, type },
        zip: zip ? { path: zip.path, originalname: zip.originalname } : null,
        sendSms: req.body?.send_sms !== "false",
        adminId: req.admin.id,
        allowedDivisionIds: req.allowedDivisionIds,
      });
      audit(req, "import", "registration_import", created.id, { file: sheet.originalname, zip: zip?.originalname ?? null, send_sms: created.send_sms });
      res.status(202).json({ data: created });
    } catch (err) {
      removeUploads(req);
      throw err;
    }
  }));

importRouter.get("/:id", validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ data: await imports.getImport(req.params.id) });
}));

// Streams CSV batches to the download (memory stays flat however many rows)
async function sendCsv(req, res, filename, header, batches, toCells) {
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  async function* csv() {
    yield "﻿" + csvLine(header);
    for await (const batch of batches) yield batch.map((r) => csvLine(toCells(r))).join("");
  }
  try {
    await pipeline(Readable.from(csv()), res);
  } catch (err) {
    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") logger.warn({ err }, "Import report download stopped");
    res.destroy();
  }
}

importRouter.get("/:id/errors.csv", validate({ params: idParams }), asyncHandler(async (req, res) => {
  await imports.assertImport(req.params.id);
  await sendCsv(req, res, `registration-import-${req.params.id}-failed-rows.csv`,
    ["Row", "Full Name", "Mobile Number", "District", "Reason"],
    imports.errorRows(req.params.id),
    (r) => [r.row_no, r.name, r.phone, r.district, r.reason]);
}));

importRouter.get("/:id/results.csv", validate({ params: idParams }), asyncHandler(async (req, res) => {
  await imports.assertImport(req.params.id);
  await sendCsv(req, res, `registration-import-${req.params.id}-approved.csv`,
    ["Registration No", "Full Name", "Mobile Number", "District", "Status", "Certificate No", "Durgveer No", "Certificate Link"],
    imports.resultRows(req.params.id),
    (r) => [r.registration_no, r.name, r.phone, r.district, r.status === "verified" ? "Approved" : r.status,
      r.certificate_no, r.durgveer_no, r.certificate_link]);
}));
