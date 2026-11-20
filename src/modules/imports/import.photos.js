// Where an imported row's photo comes from: a public URL (S3 or any direct image link) or a file in the uploaded ZIP.
// Either way at most the configured upload limit (UPLOAD_MAX_MB, 5 MB) is read; the bytes are then checked and resized
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

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

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
      headers: { "User-Agent": "AmrutDurgotsavImport/1.0", Accept: "image/*,*/*;q=0.5" },
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

/** The image bytes at a public http(s) URL, following up to 3 redirects. Throws PhotoError with a reason for the report. */
export async function downloadPhoto(rawUrl) {
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
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new PhotoError("Photo URL redirects too many times");
      url = new URL(res.headers.location, url);
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new PhotoError(`Photo could not be downloaded (HTTP ${res.statusCode})`);
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
