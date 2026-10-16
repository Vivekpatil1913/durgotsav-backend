// Evidence uploads for award nominations.
// Files are streamed to a temp folder by multer, then verified (extension + reported MIME + magic bytes),
// hashed, and moved into private storage under a random name. Nothing here is ever served statically:
// admins read files through an authenticated endpoint (see award.routes.js).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import { env } from "../../config/env.js";
import { paths } from "../../config/paths.js";
import { deleteObject, putObjectIfAbsent, s3Transport, bucket } from "../../services/s3.service.js";
import { badRequest, notFound } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { FILE_TYPES, STORED_MIME, VIDEO_FILE_TYPES } from "./award.constants.js";

const TMP = path.join(os.tmpdir(), "durgotsav-award-uploads");
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(paths.awardDocuments, { recursive: true });

const allowedTypes = (edition) => (edition.allow_video ? { ...FILE_TYPES, ...VIDEO_FILE_TYPES } : FILE_TYPES);
const extOf = (name) => path.extname(String(name || "")).slice(1).toLowerCase();

export const acceptedExtensions = (edition) => Object.keys(allowedTypes(edition));

// Builds the multer middleware for one request using the edition's configured limits.
export function nominationUpload(edition) {
  const types = allowedTypes(edition);
  return multer({
    storage: multer.diskStorage({
      destination: TMP,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
    }),
    limits: {
      fileSize: edition.max_upload_mb * 1024 * 1024,
      files: edition.max_documents,
      fields: 5,
      fieldSize: 1024 * 1024, // the JSON payload
      parts: edition.max_documents + 5,
    },
    fileFilter: (req, file, cb) => {
      if (!/^doc_\d{1,2}$/.test(file.fieldname)) return cb(badRequest("Invalid upload field", { documents: "Invalid upload" }));
      const type = types[extOf(file.originalname)];
      if (!type || !type.mimes.includes(file.mimetype)) {
        return cb(badRequest(`फक्त ${Object.keys(types).map((e) => e.toUpperCase()).join(", ")} फाइल्स स्वीकारल्या जातात`,
          { [file.fieldname]: "Unsupported file type" }));
      }
      cb(null, true);
    },
  }).any();
}

async function readHead(file, bytes = 16) {
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Magic-byte check: the content must really be what the extension claims.
function matchesSignature(kind, head) {
  switch (kind) {
    case "pdf": return head.subarray(0, 5).toString("latin1") === "%PDF-";
    case "jpeg": return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "png": return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "mp4": return head.subarray(4, 8).toString("latin1") === "ftyp";
    case "webm": return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default: return false;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("error", reject).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex")));
  });
}

// Validates every uploaded temp file; returns a map fieldname → prepared file. Throws 400 on the first bad one.
export async function inspectUploads(files, edition) {
  const types = allowedTypes(edition);
  const out = new Map();
  for (const f of files ?? []) {
    if (out.has(f.fieldname)) throw badRequest("Invalid upload", { [f.fieldname]: "Duplicate file field" });
    const ext = extOf(f.originalname);
    const type = types[ext];
    if (!type) throw badRequest("Unsupported file type", { [f.fieldname]: "Unsupported file type" });
    if (!f.size) throw badRequest("Empty file", { [f.fieldname]: "फाइल रिकामी आहे" });
    if (!matchesSignature(type.kind, await readHead(f.path))) {
      throw badRequest("फाइलचा प्रकार व मजकूर जुळत नाही. कृपया मूळ PDF / JPG / PNG फाइल निवडा.", { [f.fieldname]: "File content does not match its type" });
    }
    out.set(f.fieldname, {
      tmpPath: f.path,
      ext: type.kind === "jpeg" ? "jpg" : ext,
      mime: STORED_MIME[type.kind],
      size: f.size,
      sha256: await sha256File(f.path),
      // Keep the name the user saw, minus any path parts and control characters
      originalName: path.basename(String(f.originalname)).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255) || `file.${ext}`,
    });
  }
  return out;
}

export async function removeTempUploads(files) {
  await Promise.all((files ?? []).map((f) => fsp.rm(f.path, { force: true }).catch(() => {})));
}

// Moves one inspected file into permanent private storage. `written` collects what to undo on rollback.
export async function storeDocument(prepared, { year, reference }, written) {
  const name = `${crypto.randomUUID()}.${prepared.ext}`;
  if (env.AWARD_DOCUMENT_STORAGE === "s3") {
    const key = `shivdurg-bhushan/${year}/${reference}/${name}`;
    await putObjectIfAbsent({
      key,
      body: await fsp.readFile(prepared.tmpPath),
      contentType: prepared.mime,
      metadata: { reference, sha256: prepared.sha256 },
    });
    written.push({ storage: "s3", key });
    return { storage: "s3", storage_key: key };
  }
  const rel = path.posix.join(String(year), reference, name);
  const abs = path.join(paths.awardDocuments, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.copyFile(prepared.tmpPath, abs, fs.constants.COPYFILE_EXCL);
  written.push({ storage: "local", key: rel });
  return { storage: "local", storage_key: rel };
}

export async function undoStored(written) {
  for (const w of written) {
    try {
      if (w.storage === "s3") await deleteObject(w.key);
      else await fsp.rm(path.join(paths.awardDocuments, w.key), { force: true });
    } catch (err) {
      logger.error({ err, key: w.key }, "Could not remove award document after a failed submission");
    }
  }
}

// Readable stream for an admin preview/download. Path is resolved inside the storage root only.
export async function openDocument(doc) {
  if (doc.storage === "s3") {
    const res = await s3Transport.send(new GetObjectCommand({ Bucket: bucket(), Key: doc.storage_key }));
    return res.Body;
  }
  const root = path.resolve(paths.awardDocuments);
  const abs = path.resolve(root, doc.storage_key);
  if (!abs.startsWith(root + path.sep)) throw notFound("File not found");
  await fsp.access(abs).catch(() => { throw notFound("File not found in storage"); });
  return fs.createReadStream(abs);
}
