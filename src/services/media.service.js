// The WebP copies of participant photos that browsers load: display copy and thumbnail (EXIF-free, random names).
//
// PARTICIPANT_IMAGE_STORAGE=s3     uploaded to S3 as thumbnail/registrations/YYYY-MM/<name>.webp; the database keeps the
//                                  S3 URL. Nothing is written to this server's disk.
//                           local  (development, tests) uploads/registrations/YYYY-MM/<name>.webp; the database keeps
//                                  /uploads/registrations/YYYY-MM/<name>.webp, as before
//
// The bucket is private, so API responses carry /uploads/registrations/… for both forms, exactly as they always did;
// GET /uploads serves the file from disk if it is there (photos from before S3) and otherwise streams it from S3.
// See docs/image-storage.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { paths } from "../config/paths.js";
import { logger } from "../utils/logger.js";
import { getObject, putObject } from "./s3.service.js";

const THUMBNAIL_PREFIX = "thumbnail/";
const LOCAL_PREFIX = "/uploads/";
// Where a copy may be in S3: thumbnail/ (this app), or server files copied with or without their uploads/ folder
const READ_PREFIXES = [THUMBNAIL_PREFIX, "uploads/", ""];
// Only these are ever read from S3 for the public. It keeps the originals (DD-MM-YYYY/…, with GPS positions and mobile
// numbers) and every other object in the bucket out of reach of /uploads.
const COPY = /^registrations\/\d{4}-\d{2}\/[A-Za-z0-9_-]+\.webp$/;

export const s3Enabled = () => env.PARTICIPANT_IMAGE_STORAGE === "s3";
export const newImageName = () => `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
export const thumbnailKey = (relative) => THUMBNAIL_PREFIX + relative;

const s3Origin = () => `https://${env.AWS_S3_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/`;
const localFile = (relative) => path.join(paths.uploads, ...relative.split("/"));

/** "registrations/YYYY-MM/<name>.webp" for a stored reference to a copy (S3 URL or /uploads path); null for anything else. */
export function copyPath(ref) {
  if (typeof ref !== "string") return null;
  let relative = null;
  if (ref.startsWith(LOCAL_PREFIX)) relative = ref.slice(LOCAL_PREFIX.length);
  else if (env.AWS_S3_BUCKET_NAME && ref.startsWith(s3Origin())) {
    const key = ref.slice(s3Origin().length);
    relative = key.slice(READ_PREFIXES.find((prefix) => key.startsWith(prefix)).length);
  }
  return relative !== null && COPY.test(relative) ? relative : null;
}

/** Express "json replacer": an S3 URL of a copy leaves the API as the /uploads path browsers load it from. */
export function jsonReplacer(key, value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return value;
  const relative = copyPath(value);
  return relative ? LOCAL_PREFIX + relative : value;
}

async function writeCopy(relative, body, written, storage) {
  if (storage === "s3") {
    const key = thumbnailKey(relative);
    written.keys.push(key); // before the upload: one whose reply is lost is removed too if the registration fails
    // Names are random and never reused, so browsers may keep the image for good
    await putObject({ key, body, contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    return s3Origin() + key;
  }
  const file = localFile(relative);
  written.files.push(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return LOCAL_PREFIX + relative;
}

/**
 * Stores a photo's display copy and thumbnail and returns { image_path, thumb_path } for the database. If one of them
 * cannot be stored the other stands in for it, so a hiccup costs some sharpness or speed, not the registration; only
 * when neither can be stored does it reject. `written` ({ files, keys }) lists what a failed registration must remove;
 * both writes have ended before this settles, so nothing appears after that cleanup.
 */
export async function writeCopies({ display, thumb }, written, storage = env.PARTICIPANT_IMAGE_STORAGE) {
  const base = `registrations/${new Date().toISOString().slice(0, 7)}/${newImageName()}`;
  const [image, small] = await Promise.allSettled([
    writeCopy(`${base}.webp`, display, written, storage),
    writeCopy(`${base}_t.webp`, thumb, written, storage),
  ]);
  if (image.status === "rejected" && small.status === "rejected") throw image.reason;
  for (const [what, result] of [["display copy", image], ["thumbnail", small]]) {
    if (result.status === "rejected") logger.error({ err: result.reason, photo: base }, `Photo ${what} could not be stored; the other copy is used for both`);
  }
  return { image_path: image.value ?? small.value, thumb_path: small.value ?? image.value };
}

// The S3 object of a copy, or null when there is none. A key that cannot be read (S3 answers 403, not 404, for a missing
// object when the role lacks s3:ListBucket) does not stop the next one from being tried.
async function findObject(relative) {
  let denied = null;
  for (const prefix of READ_PREFIXES) {
    try {
      const object = await getObject(prefix + relative);
      if (object) return object;
    } catch (err) {
      if (err.code !== "S3_ACCESS_DENIED") throw err;
      denied ??= err;
    }
  }
  if (denied) throw denied;
  return null;
}

/** The bytes of a copy, from this server's disk or S3; null when it is in neither. Other failures (temporary) throw. */
export async function readCopy(ref) {
  const relative = copyPath(ref);
  if (!relative) return null;
  try {
    return await fs.readFile(localFile(relative));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!s3Enabled()) return null;
  const object = await findObject(relative);
  return object ? Buffer.from(await object.Body.transformToByteArray()) : null;
}

/** An open S3 download for GET /uploads/<relative>; null when there is no such copy. */
export async function openCopy(relative) {
  if (!s3Enabled() || !COPY.test(relative)) return null;
  try {
    return await findObject(relative);
  } catch (err) {
    if (err.code === "S3_ACCESS_DENIED") return null; // most likely a missing object (see findObject); logged by s3.service
    throw err;
  }
}
