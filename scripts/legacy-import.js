// Imports registrations + photos from the 2025 database (LEGACY_DB_NAME, default "durgotsav") into this one.
// Safe to re-run: rows already imported (registrations.legacy_id) are skipped. The legacy DB is only read.
//
// Mapping: a 2025 photo published to the gallery => registration "verified" + certificate + featured photo
// (2025 certificate_emailed_at is copied so nobody is emailed twice); anything else => "pending".
// The 2025 AI confidence becomes photo.ai_score (informational only).
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { dbConfig, pool, withTransaction } from "../src/db/pool.js";
import { storeParticipantPhoto } from "../src/services/image.service.js";
import { issue } from "../src/modules/certificates/certificates.service.js";

const LEGACY_DB = process.env.LEGACY_DB_NAME || "durgotsav";
const UPLOADS_DIR = process.env.LEGACY_UPLOADS_DIR || "D:/utsav/Durgotsav/backend/uploads";
const DIST_DIR = process.env.LEGACY_DIST_DIR || "D:/utsav/Durgotsav/dist";
const DISTRICT_ALIASES = { "औरंगाबाद (छत्रपती संभाजीनगर)": "छत्रपती संभाजीनगर", "उस्मानाबाद": "धाराशिव", "अहमदनगर": "अहिल्यानगर" };

function legacyFile(imagePath) {
  const upload = /\/uploads\/([^/?#]+)$/.exec(imagePath || "");
  if (upload) return path.join(UPLOADS_DIR, decodeURIComponent(upload[1]));
  if (imagePath?.startsWith("/")) return path.join(DIST_DIR, decodeURIComponent(imagePath));
  return null;
}

const legacy = new pg.Client(dbConfig(LEGACY_DB));
await legacy.connect();

const districts = new Map((await pool.query("SELECT id, name_mr FROM districts")).rows.map((d) => [d.name_mr, d.id]));
const { rows: done } = await pool.query("SELECT legacy_id FROM registrations WHERE legacy_id IS NOT NULL");
const imported = new Set(done.map((r) => r.legacy_id));

const { rows: regs } = await legacy.query("SELECT * FROM registrations ORDER BY id");
const { rows: images } = await legacy.query("SELECT * FROM fort_images WHERE registration_id IS NOT NULL ORDER BY image_id");
const imagesByReg = Map.groupBy ? Map.groupBy(images, (i) => i.registration_id) : images.reduce((m, i) => m.set(i.registration_id, [...(m.get(i.registration_id) ?? []), i]), new Map());

const summary = { imported: 0, skipped: 0, verified: 0, missingPhoto: 0, warnings: [] };

for (const r of regs) {
  if (imported.has(r.id)) {
    summary.skipped++;
    continue;
  }
  const phone = String(r.phone ?? "").replace(/\D/g, "").slice(-10);
  if (!/^\d{10}$/.test(phone)) {
    summary.warnings.push(`#${r.id}: invalid phone "${r.phone}", skipped`);
    continue;
  }
  const districtName = DISTRICT_ALIASES[r.district] ?? r.district;
  const districtId = districts.get(districtName) ?? null;
  if (r.district && !districtId) summary.warnings.push(`#${r.id}: unknown district "${r.district}" (left empty)`);

  const regImages = imagesByReg.get(r.id) ?? [];
  const published = regImages.find((i) => i.in_gallery);
  const chosen = published ?? regImages[0];
  let photo = null;
  if (chosen) {
    try {
      photo = await storeParticipantPhoto({ buffer: await fs.readFile(legacyFile(chosen.image_path)), size: 0, mimetype: "image/jpeg" });
    } catch (err) {
      summary.warnings.push(`#${r.id}: photo ${chosen.image_path} not imported (${err.message})`);
    }
  }
  if (!photo) summary.missingPhoto++;

  await withTransaction(async (client) => {
    const status = published && photo ? "verified" : "pending";
    const { rows } = await client.query(
      `INSERT INTO registrations (name, phone, email, city, district_id, status, source, legacy_id, created_at, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'legacy',$7,$8,$9) RETURNING id`,
      [r.name, phone, r.email || null, r.city || null, districtId, status, r.id, r.created_at, status === "verified" ? r.created_at : null],
    );
    const id = rows[0].id;
    if (photo) {
      await client.query(
        `INSERT INTO registration_photos (registration_id, original_path, image_path, thumb_path, width, height, size_bytes,
                                          mime_type, sha256, dhash, ai_score, is_featured)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, photo.original_path, photo.image_path, photo.thumb_path, photo.width, photo.height, photo.size_bytes,
          photo.mime_type, photo.sha256, photo.dhash, chosen.confidence ?? null, Boolean(published)],
      );
    }
    if (status === "verified") {
      await issue(client, id, null);
      if (r.certificate_emailed_at) await client.query("UPDATE certificates SET emailed_at = $2 WHERE registration_id = $1", [id, r.certificate_emailed_at]);
      summary.verified++;
    }
  });
  summary.imported++;
}

console.log(`Legacy import from "${LEGACY_DB}": ${summary.imported} imported (${summary.verified} verified), ${summary.skipped} already imported, ${summary.missingPhoto} without photo`);
summary.warnings.forEach((w) => console.warn(`  ! ${w}`));
await legacy.end();
await pool.end();
