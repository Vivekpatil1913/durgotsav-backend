import multer from "multer";
import { env } from "../config/env.js";
import { badRequest } from "../utils/errors.js";

// image/jpg and image/pjpeg: what some Android apps and old browsers call a JPEG
const ALLOWED = new Set(["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp"]);
const typeMessage = (file) => (/hei[cf]/i.test(file.mimetype)
  ? "HEIC photos are not supported. Please save the photo as JPG and upload it again"
  : "Only JPG, PNG or WebP images are allowed");
// Text fields of a photo form are short (names, notes ≤ 500 characters): 16 KB each instead of busboy's 1 MB default,
// so a request cannot park megabytes of text in memory next to its photo
const FIELD_BYTES = 16 * 1024;

// Files are kept in memory: sharp re-encodes them (which also proves they really are images)
// before anything touches the disk. See services/image.service.js.
export const imageUpload = (field, { maxMb = env.UPLOAD_MAX_MB } = {}) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 30, fieldSize: FIELD_BYTES },
    fileFilter: (req, file, cb) =>
      ALLOWED.has(file.mimetype)
        ? cb(null, true)
        : cb(badRequest(typeMessage(file), { [field]: "Unsupported file type" })),
  }).single(field);

// Several named single-file fields in one request, e.g. imageUploadFields(["photo", "photo_2"]).
// Each lands in req.files[name][0]; a field can be sent at most once.
export const imageUploadFields = (fields, { maxMb = env.UPLOAD_MAX_MB } = {}) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024, files: fields.length, fields: 30, fieldSize: FIELD_BYTES },
    fileFilter: (req, file, cb) =>
      ALLOWED.has(file.mimetype)
        ? cb(null, true)
        : cb(badRequest(typeMessage(file), { [file.fieldname]: "Unsupported file type" })),
  }).fields(fields.map((name) => ({ name, maxCount: 1 })));
