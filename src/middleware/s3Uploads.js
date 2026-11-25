import { pipeline } from "node:stream/promises";
import { openCopy } from "../services/media.service.js";
import { asyncHandler, notFound } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * GET /uploads/registrations/… for photo copies that are not on this server's disk: streamed from the private bucket.
 * A missing image must not be cached as missing, since it may be uploaded later.
 */
export const s3Uploads = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(req.method)) throw notFound();
  const object = await openCopy(req.path.slice(1));
  if (!object) throw notFound();
  res.set({
    "Cache-Control": "public, max-age=2592000, immutable",
    "Content-Type": object.ContentType ?? "image/webp",
    ...(object.ETag && { ETag: object.ETag }),
  });
  if (req.method === "HEAD" || req.fresh) {
    object.Body.destroy();
    return res.status(req.fresh ? 304 : 200).end();
  }
  if (object.ContentLength !== undefined) res.set("Content-Length", String(object.ContentLength));
  try {
    await pipeline(object.Body, res);
  } catch (err) {
    // The visitor left, or S3 broke off mid-way: the response has been cut, there is nothing more to send
    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") logger.warn({ err, path: req.path }, "Image stream from S3 ended early");
  }
});
