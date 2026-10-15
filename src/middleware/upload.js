import multer from "multer";
import { env } from "../config/env.js";
import { badRequest } from "../utils/errors.js";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

// Files are kept in memory: sharp re-encodes them (which also proves they really are images)
// before anything touches the disk. See services/image.service.js.
export const imageUpload = (field, { maxMb = env.UPLOAD_MAX_MB } = {}) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 30 },
    fileFilter: (req, file, cb) =>
      ALLOWED.has(file.mimetype)
        ? cb(null, true)
        : cb(badRequest("Only JPG, PNG or WebP images are allowed", { [field]: "Unsupported file type" })),
  }).single(field);

// Several named single-file fields in one request, e.g. imageUploadFields(["photo", "photo_2"]).
// Each lands in req.files[name][0]; a field can be sent at most once.
export const imageUploadFields = (fields, { maxMb = env.UPLOAD_MAX_MB } = {}) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: fields.length, fields: 30 },
    fileFilter: (req, file, cb) =>
      ALLOWED.has(file.mimetype)
        ? cb(null, true)
        : cb(badRequest("Only JPG, PNG or WebP images are allowed", { [file.fieldname]: "Unsupported file type" })),
  }).fields(fields.map((name) => ({ name, maxCount: 1 })));
