// Where an imported row's photo comes from: a public URL (S3 or any direct image link) or a file in the uploaded ZIP.
// Either way at most the configured upload limit (UPLOAD_MAX_MB) is read; the bytes are then checked and resized
// by the same code as a photo uploaded on the website (prepareParticipantPhoto).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import yauzl from "yauzl";
import { env } from "../../config/env.js";

export class PhotoError extends Error {}

const MB = 1024 * 1024;
export const photoLimitBytes = () => env.UPLOAD_MAX_MB * MB;
const tooLarge = () => new PhotoError(`Photo is larger than ${env.UPLOAD_MAX_MB} MB`);

// ---------------------------------------------------------------- URL download

const DOWNLOAD_TIMEOUT_MS = 20_000; // without a byte arriving
const DOWNLOAD_TOTAL_MS = 120_000; // for the whole photo, so a trickling server cannot hold up the import
// Google Drive answers uc?export=download with 303 → drive.usercontent.google.com, sometimes one more hop
const MAX_REDIRECTS = 5;
const USER_AGENT = "Mozilla/5.0 (compatible; AmrutDurgotsavImport/1.0; +https://amrutdurgotsav.com)";

export const DRIVE_PRIVATE = "Google Drive link is private or invalid — set file access to 'Anyone with the link'";

// ---------------------------------------------------------------- Google Drive share links

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com", "drive.usercontent.google.com"]);

/**
 * The file id of a Google Drive share link, or null for any other URL. Accepted forms:
 *   https://drive.google.com/file/d/<ID>/view?usp=sharing   (also /edit, /preview, /u/0/file/d/<ID>)
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/uc?id=<ID>&export=view|download
 *   https://drive.usercontent.google.com/download?id=<ID>
 */
export function driveFileId(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  if (!DRIVE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const fromPath = /\/file(?:\/u\/\d+)?\/d\/([^/?#]+)/.exec(url.pathname)?.[1];
  const id = fromPath ?? url.searchParams.get("id");
  return id && DRIVE_ID.test(id) ? id : null;
}

/** A Drive share link as its direct-download URL; any other URL unchanged. */
export function directPhotoUrl(rawUrl) {
  const id = driveFileId(rawUrl);
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : String(rawUrl).trim();
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, incl. the EC2 metadata service
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// DNS lookup that refuses private addresses. The connection uses the address checked here, so a host cannot resolve
// to a public address for the check and a private one for the request.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!env.IMPORT_ALLOW_PRIVATE_PHOTO_URLS && addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error("private address"), { code: "PRIVATE_ADDRESS" }));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url, {
      lookup: guardedLookup,
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.5" },
    }, resolve);
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", reject);
  });
}

function readBody(res, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers?.["content-length"]);
    if (declared > limit) {
      res.destroy();
      return reject(tooLarge());
    }
    const chunks = [];
    let size = 0;
    const deadline = setTimeout(() => {
      res.destroy();
      reject(new PhotoError("Photo took too long to download"));
    }, DOWNLOAD_TOTAL_MS);
    res.on("close", () => clearTimeout(deadline));
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy();
        reject(tooLarge());
      } else chunks.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
    res.on("aborted", () => reject(new PhotoError("Photo download was interrupted")));
  });
}

// Content types a server may give an image file without naming it: the bytes are then checked by
// prepareParticipantPhoto (S3 objects uploaded without a type are application/octet-stream; Drive sometimes says binary)
const UNTYPED = new Set(["", "application/octet-stream", "binary/octet-stream", "application/binary", "application/x-binary"]);

/**
 * The image bytes behind a photo URL (a Google Drive share link is first turned into its direct-download URL),
 * following up to 5 redirects. The response must be an image (Content-Type image/*, or untyped bytes that are then
 * checked) of at most UPLOAD_MAX_MB. Throws PhotoError with a reason for the import report.
 */
export async function downloadPhoto(rawUrl) {
  const drive = Boolean(driveFileId(rawUrl));
  return fetchImage(directPhotoUrl(rawUrl), { drive });
}

/** fetchImage(url, { drive }): drive = the URL came from a Google Drive share link (its failures get DRIVE_PRIVATE). */
export async function fetchImage(rawUrl, { drive = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PhotoError("Photo URL is not a valid link");
  }
  for (let hop = 0; ; hop++) {
    if (!["http:", "https:"].includes(url.protocol)) throw new PhotoError("Photo URL must start with http:// or https://");
    // An IP literal skips the DNS lookup, so it is checked here
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !env.IMPORT_ALLOW_PRIVATE_PHOTO_URLS && isPrivateAddress(host)) {
      throw new PhotoError("Photo URL points to a private network address");
    }
    let res;
    try {
      res = await requestOnce(url);
    } catch (err) {
      if (err.code === "PRIVATE_ADDRESS") throw new PhotoError("Photo URL points to a private network address");
      if (err.code === "TIMEOUT") throw new PhotoError("Photo URL took too long to respond");
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") throw new PhotoError(`Photo URL host "${url.hostname}" was not found`);
      throw new PhotoError(`Photo could not be downloaded (${err.code ?? err.message})`);
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new PhotoError("Photo URL redirects too many times");
      url = new URL(res.headers.location, url);
      continue;
    }
    const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (res.statusCode !== 200) {
      res.resume();
      if (drive) throw new PhotoError(DRIVE_PRIVATE);
      throw new PhotoError(`Photo could not be downloaded (HTTP ${res.statusCode})`);
    }
    if (!type.startsWith("image/") && !UNTYPED.has(type)) {
      res.resume();
      // A Drive file still set to "Restricted" answers with Google's sign-in page
      if (drive) throw new PhotoError(DRIVE_PRIVATE);
      if (type === "text/html") throw new PhotoError("Photo URL opens a web page, not an image — use a direct link to the image file");
      throw new PhotoError(`Photo URL is not an image (Content-Type ${type})`);
    }
    return readBody(res, photoLimitBytes());
  }
}

// ---------------------------------------------------------------- ZIP archive

const zipKey = (name) => String(name).replace(/\\/g, "/").trim().toLowerCase();
const baseName = (name) => zipKey(name).split("/").pop();

/**
 * Opens the photo archive and indexes its entries by file name (case-insensitive, with or without folders; the first
 * file of a name wins). Only the archive's central directory is read here; each photo is read when its row is.
 */
export async function openPhotoZip(file) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, z) => (err ? reject(err) : resolve(z)));
  }).catch((err) => {
    throw new PhotoError(`The ZIP file could not be opened (${err.message})`);
  });
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on("entry", (entry) => {
      const name = zipKey(entry.fileName);
      if (!name.endsWith("/") && !name.startsWith("__macosx/") && !baseName(name).startsWith(".")) {
        if (!entries.has(name)) entries.set(name, entry);
        if (!entries.has(baseName(name))) entries.set(baseName(name), entry);
      }
      zip.readEntry();
    });
    zip.once("end", resolve);
    zip.once("error", reject);
    zip.readEntry();
  });
  return {
    size: entries.size,
    /** The bytes of `name` in the archive. Throws PhotoError when it is missing or too large. */
    async read(name) {
      const entry = entries.get(zipKey(name)) ?? entries.get(baseName(name));
      if (!entry) throw new PhotoError(`Photo file "${name}" is not in the ZIP`);
      if (entry.uncompressedSize > photoLimitBytes()) throw tooLarge();
      const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))))
        .catch((err) => {
          throw new PhotoError(`Photo file "${name}" could not be read from the ZIP (${err.message})`);
        });
      return readBody(stream, photoLimitBytes()).catch((err) => {
        throw err instanceof PhotoError ? err : new PhotoError(`Photo file "${name}" could not be read from the ZIP (${err.message})`);
      });
    },
    close: () => zip.close(),
  };
}
