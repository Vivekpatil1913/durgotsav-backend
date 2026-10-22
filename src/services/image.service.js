import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { paths } from "../config/paths.js";
import { badRequest } from "../utils/errors.js";

const FOLDERS = new Set(["registrations", "forts", "content", "videos", "testimonials", "awards"]);

// 64-bit difference hash: robust to resizing / recompression, so a re-uploaded copy of the same photo
// lands within a few bits of the original (PDF §3.4, §6.5 — the same photo may not be reused).
async function dhash(buffer) {
  const pixels = await sharp(buffer).rotate().grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
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

async function readMetadata(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format)) throw new Error("format");
    return meta;
  } catch {
    // The browser-supplied MIME type said image, but the bytes are not a readable image
    throw badRequest("The uploaded file is not a valid image", { photo: "Invalid image file" });
  }
}

const name = () => `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;

const FORMAT_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Validates a participant photo from its bytes (not the browser's MIME type or file name) and builds the
 * EXIF-stripped WebP display (≤1600px) and thumbnail (≤480px) in memory. Nothing is written yet.
 */
export async function prepareParticipantPhoto(file) {
  const meta = await readMetadata(file.buffer);
  if ((meta.width || 0) < 300 || (meta.height || 0) < 300) {
    throw badRequest("Photo is too small. Please upload a clear photo (at least 300×300 px)", { photo: "Photo too small" });
  }
  let display;
  let thumb;
  try {
    const base = sharp(file.buffer, { failOn: "error" }).rotate(); // apply EXIF orientation, then metadata is dropped
    display = await base.clone().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    thumb = await base.clone().resize(480, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  } catch {
    // Header parsed but the pixel data is truncated / corrupt
    throw badRequest("The uploaded file is not a valid image", { photo: "Invalid image file" });
  }
  return {
    buffer: file.buffer,
    format: meta.format,
    ext: meta.format === "jpeg" ? "jpg" : meta.format,
    content_type: FORMAT_MIME[meta.format],
    original_name: file.originalname ? String(file.originalname).slice(0, 255) : null,
    display: display.data,
    thumb,
    width: display.info.width,
    height: display.info.height,
    size_bytes: file.size || file.buffer.length,
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
    dhash: await dhash(file.buffer),
  };
}

// Writes the public WebP copies. `files` lists the absolute paths so a failed registration can remove them.
export async function writePublicCopies(prepared) {
  const id = name();
  const month = new Date().toISOString().slice(0, 7);
  const publicDir = path.join(paths.uploads, "registrations", month);
  await fs.mkdir(publicDir, { recursive: true });
  const files = [path.join(publicDir, `${id}.webp`), path.join(publicDir, `${id}_t.webp`)];
  await Promise.all([fs.writeFile(files[0], prepared.display), fs.writeFile(files[1], prepared.thumb)]);
  return {
    image_path: `/uploads/registrations/${month}/${id}.webp`,
    thumb_path: `/uploads/registrations/${month}/${id}_t.webp`,
    files,
  };
}

// Original bytes in storage/originals (private, never served) — used when PARTICIPANT_IMAGE_STORAGE=local
export async function writeLocalOriginal(prepared) {
  const month = new Date().toISOString().slice(0, 7);
  const privateDir = path.join(paths.privateStorage, month);
  await fs.mkdir(privateDir, { recursive: true });
  const fileName = `${name()}.${prepared.ext}`;
  const file = path.join(privateDir, fileName);
  await fs.writeFile(file, prepared.buffer);
  return { original_path: `${month}/${fileName}`, file };
}

export const removeFiles = (files) => Promise.all(files.map((f) => fs.unlink(f).catch(() => {})));

/**
 * Stores a participant photo locally (legacy import):
 *  - original bytes in storage/originals (private, kept as verification evidence)
 *  - EXIF-stripped WebP display and thumbnail under /uploads/registrations
 */
export async function storeParticipantPhoto(file) {
  const prepared = await prepareParticipantPhoto(file);
  const [copies, original] = await Promise.all([writePublicCopies(prepared), writeLocalOriginal(prepared)]);
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
  const filename = `${name()}.webp`;
  const out = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
  await fs.writeFile(path.join(dir, filename), out.data);
  return { url: `/uploads/${folder}/${filename}`, width: out.info.width, height: out.info.height };
}

// pdfkit embeds only JPEG/PNG — convert any stored public image to a small JPEG buffer.
export async function loadAsJpeg(publicPath, size = 240, height = size) {
  if (!publicPath?.startsWith("/uploads/")) return null;
  const file = path.join(paths.uploads, publicPath.slice("/uploads/".length));
  if (!file.startsWith(paths.uploads)) return null; // no path traversal
  try {
    return await sharp(file).resize(size, height, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
  } catch {
    return null;
  }
}

export async function removePublicFile(publicPath) {
  if (!publicPath?.startsWith("/uploads/")) return;
  const file = path.join(paths.uploads, publicPath.slice("/uploads/".length));
  if (file.startsWith(paths.uploads)) await fs.unlink(file).catch(() => {});
}
