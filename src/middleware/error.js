import multer from "multer";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// Overload or the database briefly away (restart, failover): pool full or slow to connect, connection lost, statement
// cut off, deadlock or serialization victim, out of connections, server shutting down / starting up (57P0x), any
// connection exception (SQLSTATE class 08), or the database port refusing connections
const BUSY_MESSAGES = new Set([
  "timeout exceeded when trying to connect", "Connection terminated due to connection timeout", "Connection terminated unexpectedly",
]);
const BUSY_CODES = ["57014", "40P01", "40001", "53300", "57P01", "57P02", "57P03"];
const isBusy = (err) => BUSY_MESSAGES.has(err?.message) || BUSY_CODES.includes(err?.code) || /^08/.test(err?.code ?? "")
  || (err?.code === "ECONNREFUSED" && err?.port === env.DB_PORT);

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
  // A multipart body cut off, garbled or abandoned on the way (busboy's and multer's plain errors): the client's request,
  // not a server error — nothing to log
  if (/^(Unexpected end of form|Malformed part header|Multipart: Boundary not found|Malformed urlencoded form|Request aborted|Request closed)/.test(err?.message ?? "")
    || (err?.code === "ECONNRESET" && req.destroyed)) {
    return res.status(400).json({ error: { code: "BAD_UPLOAD", message: "The upload was incomplete or malformed. Please try again" } });
  }
  // Postgres constraint violations that slipped past validation
  if (err?.code === "23505") {
    return res.status(409).json({ error: { code: "DUPLICATE", message: "A record with these details already exists" } });
  }
  if (err?.code === "23503") {
    return res.status(400).json({ error: { code: "INVALID_REFERENCE", message: "Referenced record does not exist" } });
  }
  // A number or id outside its column's range (a hand-edited URL), text where a number belongs, or text longer than its
  // column allows: the request's fault, not a server error
  if (err?.code === "22003" || err?.code === "22P02" || err?.code === "22001") {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid value in the request" } });
  }
  // Overload, not a bug (isBusy): a 503 with Retry-After tells browsers and the load balancer to come back shortly
  if (isBusy(err)) {
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
