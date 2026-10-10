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
