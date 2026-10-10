import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";

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

export async function getPublicSettings() {
  const rows = await getAllSettings();
  const out = Object.fromEntries(rows.filter((r) => r.is_public).map((r) => [r.key, r.value]));
  out.registration_status = await registrationWindow();
  return out;
}

export async function updateSettings(entries, adminId) {
  for (const [key, value] of Object.entries(entries)) {
    await query(
      `UPDATE site_settings SET value = $2, updated_by = $3 WHERE key = $1`,
      [key, JSON.stringify(value), adminId],
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
