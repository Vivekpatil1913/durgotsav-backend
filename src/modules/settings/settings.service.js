import { EDITION_YEAR, fillYear } from "../../config/edition.js";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { SETTINGS } from "./settings.definitions.js";

// Small read-through cache; settings change rarely and are read on every registration.
let cache = null;
let cachedAt = 0;
const TTL_MS = 30_000;

export async function getAllSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await query("SELECT key, value, is_public, updated_at FROM site_settings ORDER BY key");
  cache = rows;
  cachedAt = Date.now();
  return rows;
}

export const invalidateSettings = () => {
  cache = null;
};

export async function getSetting(key, fallback = null) {
  const row = (await getAllSettings()).find((r) => r.key === key);
  return row ? row.value : fallback;
}

// {year} in admin text is filled in for the public site (the admin API keeps the placeholder). edition_year lets
// the website and admin console check they are built for the same edition as the API.
export async function getPublicSettings() {
  const rows = await getAllSettings();
  const out = fillYear(Object.fromEntries(rows.filter((r) => r.is_public).map((r) => [r.key, r.value])));
  out.edition_year = EDITION_YEAR;
  out.registration_status = await registrationWindow();
  return out;
}

// Upsert, so a setting added after the database was seeded is saved instead of silently dropped
export async function updateSettings(entries, adminId) {
  for (const [key, value] of Object.entries(entries)) {
    await query(
      `INSERT INTO site_settings (key, value, is_public, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), SETTINGS[key]?.public ?? false, adminId],
    );
  }
  invalidateSettings();
}

// { open, reason: 'open'|'not_started'|'closed'|'disabled', opensAt, closesAt }
export async function registrationWindow(now = new Date()) {
  const cfg = await getSetting("registration", {});
  const opensAt = cfg.opens_at ? new Date(cfg.opens_at) : null;
  const closesAt = cfg.closes_at ? new Date(cfg.closes_at) : null;
  const base = { opensAt: cfg.opens_at ?? null, closesAt: cfg.closes_at ?? null, forcedOpen: env.REGISTRATION_FORCE_OPEN };
  if (env.REGISTRATION_FORCE_OPEN) return { ...base, open: true, reason: "open" };
  if (cfg.enabled === false) return { ...base, open: false, reason: "disabled" };
  if (opensAt && now < opensAt) return { ...base, open: false, reason: "not_started" };
  if (closesAt && now > closesAt) return { ...base, open: false, reason: "closed" };
  return { ...base, open: true, reason: "open" };
}
