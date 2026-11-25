import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { paths } from "../config/paths.js";
import { badRequest } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { newImageName, readCopy, writeCopies } from "./media.service.js";

// Largest photo decoded (width × height). A JPEG is scaled down while it is decoded, so even a 108 MP phone photo costs
// little; a PNG or WebP is decoded whole, where a bigger, or forged, image would take hundreds of MB of memory.
const MAX_PIXELS = { jpeg: 120_000_000, png: 50_000_000, webp: 50_000_000 };
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

// What an image becomes: the longest side, the WebP quality tried first, and the size it is brought under.
const DISPLAY = { side: 1600, quality: 82, maxBytes: 300 * 1024 };
const THUMB = { side: 480, quality: 72, maxBytes: 100 * 1024 };
const MIN_QUALITY = 50;

const FOLDERS = new Set(["registrations", "forts", "content", "videos", "testimonials", "awards"]);

// 64-bit difference hash: robust to resizing / recompression, so a re-uploaded copy of the same photo
// lands within a few bits of the original (PDF §3.4, §6.5 — the same photo may not be reused).
async function dhash(buffer, limitInputPixels) {
  const pixels = await sharp(buffer, { limitInputPixels }).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? "1" : "0";
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

export function hammingDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

// An iPhone / Android HEIC photo, from its first bytes (ISO media "ftyp" box)
const isHeic = (buffer) => buffer.length > 12 && buffer.toString("latin1", 4, 8) === "ftyp" && HEIC_BRANDS.has(buffer.toString("latin1", 8, 12));

async function readMetadata(buffer) {
  if (isHeic(buffer)) {
    throw badRequest("HEIC photos are not supported. Please save the photo as JPG and upload it again", { photo: "HEIC not supported" });
  }
  try {
    const meta = await sharp(buffer, { limitInputPixels: false }).metadata(); // header only; the size is checked below
    if (!["jpeg", "png", "webp"].includes(meta.format)) throw new Error("format");
    return meta;
  } catch {
    // The browser-supplied MIME type said image, but the bytes are not a readable image
    throw badRequest("The uploaded file is not a valid image", { photo: "Invalid image file" });
  }
}

function assertPixels(meta) {
  if (meta.width * meta.height > MAX_PIXELS[meta.format]) {
    throw badRequest(`Photo is too large. Please upload a photo of at most ${MAX_PIXELS[meta.format] / 1_000_000} megapixels`, { photo: "Photo too large" });
  }
}

// Resizes once, then encodes at falling quality, and smaller if even that is not enough, until the WebP fits maxBytes
// (a photo full of fine detail — grass, gravel — can be several times the usual size).
async function encodeWebp(image, { side, quality, maxBytes }) {
  for (let max = side; ; max = Math.round(max * 0.8)) {
    const { data, info } = await image.clone().resize(max, max, { fit: "inside", withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    const raw = { width: info.width, height: info.height, channels: info.channels };
    for (let q = quality; ; q = Math.max(MIN_QUALITY, q - 10)) {
      const out = await sharp(data, { raw }).webp({ quality: q }).toBuffer({ resolveWithObject: true });
      if (out.data.length <= maxBytes || (q === MIN_QUALITY && max <= side / 2)) return out;
      if (q === MIN_QUALITY) break;
    }
  }
}

/** The two copies of a participant photo browsers load: EXIF orientation applied, all metadata (GPS) dropped. */
async function renderCopies(buffer, limitInputPixels) {
  const base = sharp(buffer, { failOn: "error", limitInputPixels }).rotate();
  const display = await encodeWebp(base, DISPLAY);
  // A thumbnail that cannot be made never costs the participant their registration: it is made from the finished
  // display copy instead, and if even that fails the display copy (≤ 300 KB) is its own thumbnail
  const thumb = await encodeWebp(base, THUMB)
    .catch(() => encodeWebp(sharp(display.data), THUMB))
    .catch((err) => {
      logger.error({ err }, "Thumbnail could not be made; the display copy is used instead");
      return display;
    });
  return { display: display.data, thumb: thumb.data, width: display.info.width, height: display.info.height };
}

const FORMAT_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Validates a participant photo from its bytes (not the browser's MIME type or file name) and builds the
 * EXIF-stripped WebP display (≤1600px, ≤300 KB) and thumbnail (≤480px, ≤100 KB) in memory. Nothing is written yet.
 */
export async function prepareParticipantPhoto(file) {
  const meta = await readMetadata(file.buffer);
  if ((meta.width || 0) < 300 || (meta.height || 0) < 300) {
    throw badRequest("Photo is too small. Please upload a clear photo (at least 300×300 px)", { photo: "Photo too small" });
  }
  assertPixels(meta);
  const limit = MAX_PIXELS[meta.format];
  let copies;
  try {
    copies = await renderCopies(file.buffer, limit);
  } catch (err) {
    // Header parsed but the pixel data is truncated / corrupt
    logger.warn({ err, format: meta.format, width: meta.width, height: meta.height, bytes: file.buffer.length }, "Photo could not be decoded");
    throw badRequest("The uploaded file is not a valid image", { photo: "Invalid image file" });
  }
  return {
    buffer: file.buffer,
    format: meta.format,
    ext: meta.format === "jpeg" ? "jpg" : meta.format,
    content_type: FORMAT_MIME[meta.format],
    original_name: file.originalname ? String(file.originalname).slice(0, 255) : null,
    ...copies,
    size_bytes: file.size || file.buffer.length,
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    dhash: await dhash(file.buffer, limit),
  };
}

// Original bytes in storage/originals (private, never served) — used when PARTICIPANT_IMAGE_STORAGE=local
export async function writeLocalOriginal(prepared) {
  const month = new Date().toISOString().slice(0, 7);
  const privateDir = path.join(paths.privateStorage, month);
  await fs.mkdir(privateDir, { recursive: true });
  const fileName = `${newImageName()}.${prepared.ext}`;
  const file = path.join(privateDir, fileName);
  await fs.writeFile(file, prepared.buffer);
  return { original_path: `${month}/${fileName}`, file };
}

export const removeFiles = (files) => Promise.all(files.map((f) => fs.unlink(f).catch(() => {})));

/**
 * Stores a participant photo of the 2025 database (legacy import):
 *  - original bytes in storage/originals (private, kept as verification evidence)
 *  - EXIF-stripped WebP display and thumbnail, stored like any other participant photo's (media.service.js)
 */
export async function storeParticipantPhoto(file) {
  const prepared = await prepareParticipantPhoto(file);
  const [copies, original] = await Promise.all([writeCopies(prepared, { files: [], keys: [] }), writeLocalOriginal(prepared)]);
  return {
    original_path: original.original_path,
    image_path: copies.image_path,
    thumb_path: copies.thumb_path,
    width: prepared.width,
    height: prepared.height,
    size_bytes: file.size,
    mime_type: file.mimetype,
    sha256: prepared.sha256,
    dhash: prepared.dhash,
  };
}

// CMS images (fort covers, testimonials, video thumbnails): one WebP, ≤ 2000px.
export async function storeContentImage(file, folder) {
  if (!FOLDERS.has(folder)) throw badRequest("Unknown upload folder");
  await readMetadata(file.buffer);
  const dir = path.join(paths.uploads, folder);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${newImageName()}.webp`;
  const out = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
  await fs.writeFile(path.join(dir, filename), out.data);
  return { url: `/uploads/${folder}/${filename}`, width: out.info.width, height: out.info.height };
}

// pdfkit embeds only JPEG/PNG — convert any stored public image to a small JPEG buffer.
// position: sharp crop gravity/strategy ("attention" keeps the most salient part when the frame is much wider than the photo)
// fit "contain": the whole photo, uncropped, at its own aspect ratio, fitting inside size×height
export async function loadAsJpeg(ref, size = 240, height = size, position = "centre", fit = "cover") {
  if (!ref) return null;
  let bytes;
  try {
    bytes = await readCopy(ref);
  } catch (err) {
    // A read error is temporary (I/O pressure, S3 unavailable): fail, so the email is retried instead of sent without
    // the photo.
    throw Object.assign(new Error("Photo could not be read"), { code: "PHOTO_UNREADABLE", cause: err });
  }
  if (!bytes) {
    // Nowhere to be found: the certificate prints without the photo, and says so loudly
    logger.error({ photo: ref }, "Photo file missing from uploads/ and S3");
    return null;
  }
  try {
    if (fit === "contain") {
      return await sharp(bytes).rotate().resize(size, height, { fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
    }
    return await sharp(bytes).rotate().resize(size, height, { fit: "cover", position }).jpeg({ quality: 85 }).toBuffer();
  } catch (err) {
    logger.error({ err, photo: ref }, "Photo file is not a readable image");
    return null;
  }
}
