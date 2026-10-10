import multer from "multer";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.path} not found` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE"
      ? `File must be ${env.UPLOAD_MAX_MB} MB or smaller`
      : err.message;
    return res.status(400).json({ error: { code: err.code, message } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body" } });
  }
  // Postgres constraint violations that slipped past validation
  if (err?.code === "23505") {
    return res.status(409).json({ error: { code: "DUPLICATE", message: "A record with these details already exists" } });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ error: { code: "INVALID_REFERENCE", message: "Referenced record does not exist" } });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: env.isProd ? "Something went wrong" : err.message },
  });
}
