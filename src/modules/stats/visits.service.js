import crypto from "node:crypto";
import { query } from "../../db/pool.js";

// Totals are cached briefly so a busy home page doesn't SUM the table on every request.
const TTL_MS = 15_000;
let cached = null;
let cachedAt = 0;

// Who-was-counted rows are only needed for today; prune older ones at most once an hour per process.
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let prunedAt = 0;

const TODAY = "(NOW() AT TIME ZONE 'Asia/Kolkata')::date";

async function fetchTotals() {
  const { rows } = await query(`
    SELECT COALESCE(SUM(visits), 0)::bigint AS total,
           COALESCE(MAX(visits) FILTER (WHERE day = ${TODAY}), 0)::bigint AS today
    FROM site_visits`);
  return { total: Number(rows[0].total), today: Number(rows[0].today) };
}

export async function visitTotals() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  cached = await fetchTotals();
  cachedAt = now;
  return cached;
}

// The browser's random visitor id identifies the visitor. Without one (storage blocked) fall back to IP + user agent.
// Only a hash is stored, never the id or the IP.
export function visitorHash({ visitorId, ip, userAgent }) {
  const key = visitorId ? `id:${visitorId}` : `ip:${ip ?? ""}|${userAgent ?? ""}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

// Counts the visitor once per IST day: a repeat visit the same day changes nothing.
export async function recordVisit(visitor) {
  const { rowCount } = await query(
    `WITH first_today AS (
       INSERT INTO site_visitor_days (day, visitor_hash) VALUES (${TODAY}, $1)
       ON CONFLICT DO NOTHING
       RETURNING day
     )
     INSERT INTO site_visits (day, visits) SELECT day, 1 FROM first_today
     ON CONFLICT (day) DO UPDATE SET visits = site_visits.visits + 1`,
    [visitorHash(visitor)],
  );
  const counted = rowCount > 0;

  if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
    prunedAt = Date.now();
    query(`DELETE FROM site_visitor_days WHERE day < ${TODAY} - 1`).catch(() => { prunedAt = 0; });
  }

  // Count this visit in the reply even when the totals come from the cache
  if (cached && Date.now() - cachedAt < TTL_MS) {
    if (counted) cached = { total: cached.total + 1, today: cached.today + 1 };
    return { ...cached, counted };
  }
  return { ...(await visitTotals()), counted };
}
