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
      ? `The photo is larger than ${env.UPLOAD_MAX_MB} MB. Please choose a photo of ${env.UPLOAD_MAX_MB} MB or less.`
      : err.message;
    // err.field names the upload field (photo / photo_2) so the form can mark the right one
    return res.status(400).json({ error: { code: err.code, message, ...(err.field && { details: { [err.field]: message } }) } });
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
  // A number or id outside its column's range (a hand-edited URL), or text where a number belongs
  if (err?.code === "22003" || err?.code === "22P02") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid value in the request" } });
  }
  // Overload, not a bug: every pooled connection busy for 5 s, a statement cut off by statement_timeout, a deadlock or
  // serialization victim, or the server out of connections. A 503 with Retry-After tells browsers and the load balancer
  // to come back shortly.
  if (err?.message === "timeout exceeded when trying to connect" || ["57014", "40P01", "40001", "53300"].includes(err?.code)) {
    logger.warn({ path: req.path, method: req.method, code: err.code ?? "POOL_TIMEOUT" }, "Database busy");
    res.set("Retry-After", "5");
    return res.status(503).json({ error: { code: "BUSY", message: "The server is busy. Please try again in a few seconds" } });
  }
  if (err instanceof AppError) {
    // A refusal for load (render pool full, a render timed out) tells the browser when to try again
    if (err.status === 503 && !res.get("Retry-After")) res.set("Retry-After", "5");
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Client errors raised by Express middleware, e.g. a missing /uploads file (serve-static) or an aborted body
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: status === 404 ? "Not found" : "Invalid request" } });
  }
  logger.error({ err, path: req.path, method: req.method }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: env.isProd ? "Something went wrong" : err.message },
  });
}
