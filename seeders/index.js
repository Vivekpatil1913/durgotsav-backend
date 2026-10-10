// Idempotent seed: lookup/content rows are inserted only when missing, settings only when the key is absent,
// so re-running never overwrites edits made in the admin panel.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.js";
import { storeContentImage } from "../src/services/image.service.js";
import { SETTINGS } from "../src/modules/settings/settings.definitions.js";
import { DISTRICTS } from "./data/districts.js";
import { FORTS } from "./data/forts.js";
import { ANNOUNCEMENTS, EVENTS, FAQS, PAGES, TESTIMONIALS } from "./data/content.js";

const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const isEmpty = async (table) => (await pool.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount === 0;

async function uploadAsset(file, folder) {
  const buffer = await fs.readFile(path.join(assets, file));
  const { url } = await storeContentImage({ buffer }, folder);
  return url;
}

async function seedAdmin() {
  const { rowCount } = await pool.query("SELECT 1 FROM admins WHERE role = 'super_admin' AND deleted_at IS NULL");
  if (rowCount) return console.log("• super admin exists");
  const email = (process.env.SEED_ADMIN_EMAIL || "admin@amrutdurgotsav.com").toLowerCase();
  let password = process.env.SEED_ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = `Dgt26-${crypto.randomBytes(9).toString("base64url")}`;
  await pool.query("INSERT INTO admins (name, email, password_hash, role) VALUES ($1, $2, $3, 'super_admin')", [
    process.env.SEED_ADMIN_NAME || "Super Admin", email, await bcrypt.hash(password, 12),
  ]);
  console.log(`• super admin created: ${email}`);
  if (generated) console.log(`  generated password (shown once, change it after login): ${password}`);
}

async function seedDistricts() {
  for (const [i, [mr, en]] of DISTRICTS.entries()) {
    await pool.query("INSERT INTO districts (name_mr, name_en, sort_order) VALUES ($1,$2,$3) ON CONFLICT (name_mr) DO NOTHING", [mr, en, i + 1]);
  }
  console.log(`• districts: ${DISTRICTS.length}`);
}

async function seedForts() {
  let added = 0;
  for (const [i, f] of FORTS.entries()) {
    const exists = await pool.query("SELECT 1 FROM forts WHERE slug = $1", [f.slug]);
    if (exists.rowCount) continue;
    const cover = f.cover_image ? await uploadAsset(`${f.cover_image}.png`, "forts") : null;
    await pool.query(
      `INSERT INTO forts (slug, name_mr, name_en, location_mr, state, fort_type, tagline, summary, history, facts,
                          latitude, longitude, cover_image, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [f.slug, f.name_mr, f.name_en, f.location_mr, f.state ?? "महाराष्ट्र", f.fort_type, f.tagline, f.summary, f.history,
        JSON.stringify(f.facts), f.latitude, f.longitude, cover, i + 1],
    );
    added++;
  }
  console.log(`• forts: ${added} added`);
}

async function seedContent() {
  if (await isEmpty("events")) {
    for (const e of EVENTS) {
      await pool.query(
        "INSERT INTO events (title, description, start_date, end_date, date_label, icon, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [e.title, e.description, e.start_date ?? null, e.end_date ?? null, e.date_label, e.icon, e.sort_order],
      );
    }
    console.log(`• events: ${EVENTS.length}`);
  }
  if (await isEmpty("testimonials")) {
    for (const t of TESTIMONIALS) {
      const photo = await uploadAsset(t.photo, "testimonials");
      await pool.query("INSERT INTO testimonials (name, designation, message, photo, sort_order) VALUES ($1,$2,$3,$4,$5)",
        [t.name, t.designation, t.message, photo, t.sort_order]);
    }
    console.log(`• testimonials: ${TESTIMONIALS.length}`);
  }
  if (await isEmpty("faqs")) {
    for (const [i, [question, answer, category]] of FAQS.entries()) {
      await pool.query("INSERT INTO faqs (question, answer, category, sort_order) VALUES ($1,$2,$3,$4)", [question, answer, category, i + 1]);
    }
    console.log(`• faqs: ${FAQS.length}`);
  }
  if (await isEmpty("announcements")) {
    for (const a of ANNOUNCEMENTS) {
      await pool.query(
        "INSERT INTO announcements (title, body, link_url, link_label, published_at, is_pinned) VALUES ($1,$2,$3,$4,$5,$6)",
        [a.title, a.body, a.link_url ?? null, a.link_label ?? null, a.published_at, a.is_pinned ?? false],
      );
    }
    console.log(`• announcements: ${ANNOUNCEMENTS.length}`);
  }
  for (const p of PAGES) {
    await pool.query(
      "INSERT INTO pages (slug, title, body, meta_description) VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO NOTHING",
      [p.slug, p.title, p.body, p.meta_description],
    );
  }
  console.log(`• pages: ${PAGES.map((p) => p.slug).join(", ")}`);
}

async function seedSettings() {
  for (const [key, def] of Object.entries(SETTINGS)) {
    await pool.query(
      "INSERT INTO site_settings (key, value, is_public) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING",
      [key, JSON.stringify(def.initial), def.public],
    );
  }
  console.log(`• settings: ${Object.keys(SETTINGS).join(", ")}`);
}

try {
  await seedAdmin();
  await seedDistricts();
  await seedForts();
  await seedContent();
  await seedSettings();
  console.log("Seed complete");
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
