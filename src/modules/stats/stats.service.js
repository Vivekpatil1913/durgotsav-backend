import { reportQuery } from "../../db/pool.js";
import { createCache, sortRows } from "../../utils/cache.js";
import { STATUSES } from "../registrations/registrations.schemas.js";

// ── In-process caches ────────────────────────────────────────────────────────
// Every statistic here aggregates the whole registrations table, which is seconds of database work at millions of
// rows. Each result is cached per access scope (the admin's divisions: the same scope always sees the same numbers,
// so nothing crosses between users), served stale while one refresh runs, and computed once for concurrent callers
// (see utils/cache.js). District, division and city tables are cached whole and sorted / paged in memory.
// Every statement runs on the report pool (db/pool.js), one after another, so a refresh holds one of its few
// connections and never takes the ones public registrations, downloads and moderation need.
const DASHBOARD_TTL_MS = 30_000;
const PUBLIC_STATS_TTL_MS = 60_000;
const TABLE_TTL_MS = 60_000;
// The city table is the heaviest (a free-text GROUP BY over every registration with its photo and certificate)
const CITY_TTL_MS = 5 * 60_000;
const publicCache = createCache({ ttlMs: PUBLIC_STATS_TTL_MS, name: "public-stats" });
const dashboardCache = createCache({ ttlMs: DASHBOARD_TTL_MS, name: "dashboard" });
const tableCache = createCache({ ttlMs: TABLE_TTL_MS, maxEntries: 300, name: "stats-tables" });
const cityCache = createCache({ ttlMs: CITY_TTL_MS, maxEntries: 300, name: "stats-cities" });

// null = all divisions (super admin); [] = none; [ids] = those divisions
const scopeKey = (allowedDivisionIds) => (allowedDivisionIds === null ? "all" : [...allowedDivisionIds].map(Number).sort((a, b) => a - b).join(",") || "none");

export function invalidateStatsCache() {
  publicCache.clear();
  dashboardCache.clear();
  tableCache.clear();
  cityCache.clear();
}

const page = (rows, { page: p = 1, limit = 10 }) => ({
  items: rows.slice((p - 1) * limit, p * limit),
  meta: { page: p, limit, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / limit)) },
});

// Days are Indian days: "today" and the daily chart start at midnight IST whatever the database's time zone
const IST_TODAY = "(NOW() AT TIME ZONE 'Asia/Kolkata')::date";

// ── publicStats ──────────────────────────────────────────────────────────────

async function fetchPublicStats() {
  // participants and verified in one pass over the live registrations; districts with one index probe per district
  // (EXISTS stops at its first registration) instead of sorting every registration's district
  const { rows } = await reportQuery(`
    SELECT a.participants, a.verified,
      -- valid certificates: generated when an admin approves a registration, withdrawn when it is refused later
      (SELECT COUNT(*)::int FROM certificates c JOIN registrations r ON r.id = c.registration_id
        WHERE c.revoked_at IS NULL AND r.deleted_at IS NULL AND r.status = 'verified') AS certificates,
      (SELECT COUNT(*)::int FROM districts d WHERE EXISTS (
         SELECT 1 FROM registrations r WHERE r.district_id = d.id AND r.deleted_at IS NULL
           AND r.status NOT IN ('rejected', 'duplicate'))) AS districts,
      (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL AND is_active) AS forts
    FROM (SELECT COUNT(*) FILTER (WHERE status NOT IN ('rejected', 'duplicate'))::int AS participants,
                 COUNT(*) FILTER (WHERE status = 'verified')::int AS verified
          FROM registrations WHERE deleted_at IS NULL) a`);
  return rows[0];
}

export const publicStats = () => publicCache.get("public", fetchPublicStats);

// For a page that must never wait for (or fail on) the counters: the cached figures, or null while they are first
// computed in the background
export const cachedPublicStats = () => publicCache.peek("public", fetchPublicStats);

// ── dashboard ────────────────────────────────────────────────────────────────
// allowedDivisionIds: null = all (super-admin); [] = none; number[] = scoped.

function divisionFilter(alias, allowedDivisionIds) {
  if (allowedDivisionIds === null) return "";
  if (allowedDivisionIds.length === 0) return "AND FALSE";
  return `AND ${alias}.division_id = ANY(ARRAY[${allowedDivisionIds.map(Number).join(",")}]::int[])`;
}

async function fetchDashboard(allowedDivisionIds) {
  const df = divisionFilter("r", allowedDivisionIds);

  // Registrations per status in one GROUP BY. The scope is part of the WHERE, so a scoped admin's count reads only
  // their divisions' index entries.
  const { rows: statusRows } = await reportQuery(`
    SELECT r.status, COUNT(*)::int AS count FROM registrations r WHERE r.deleted_at IS NULL ${df} GROUP BY r.status`);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of statusRows) byStatus[row.status] = row.count;

  // The last 30 IST days, today last (that bucket is "today"): only rows created since the first day's midnight are read
  const { rows: daily } = await reportQuery(`
    SELECT to_char(days.day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
    FROM (SELECT ${IST_TODAY} - n AS day FROM generate_series(0, 29) AS n) days
    LEFT JOIN (
      SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, COUNT(*) AS count
      FROM registrations r
      WHERE r.deleted_at IS NULL AND r.created_at >= (${IST_TODAY} - 29)::timestamp AT TIME ZONE 'Asia/Kolkata' ${df}
      GROUP BY 1
    ) c ON c.day = days.day
    ORDER BY days.day`);

  // Certificates in one scan (a scoped admin's: those of their divisions' live registrations). Flagged duplicates and
  // gallery photos start from their small partial photo indexes; the rest are small tables.
  const certificates = allowedDivisionIds === null
    ? "FROM certificates c WHERE c.revoked_at IS NULL"
    : `FROM certificates c JOIN registrations r ON r.id = c.registration_id WHERE c.revoked_at IS NULL AND r.deleted_at IS NULL ${df}`;
  const { rows: [counts] } = await reportQuery(`
    SELECT cert.certificates, cert.certificates_emailed,
      (SELECT COUNT(*)::int FROM registration_photos p JOIN registrations r ON r.id = p.registration_id
        WHERE p.is_current AND p.position = 1 AND p.duplicate_of_photo_id IS NOT NULL
          AND r.status = 'pending' AND r.deleted_at IS NULL ${df}) AS pending_duplicates,
      -- the photos the website shows
      (SELECT COUNT(*)::int FROM registration_photos p JOIN registrations r ON r.id = p.registration_id
        WHERE p.is_current AND p.position = 1 AND p.is_featured
          AND r.status = 'verified' AND r.deleted_at IS NULL ${df}) AS gallery_photos,
      (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL)                                AS forts,
      (SELECT COUNT(*)::int FROM events WHERE deleted_at IS NULL AND is_active)                 AS events,
      (SELECT COUNT(*)::int FROM videos WHERE deleted_at IS NULL AND is_active)                 AS videos,
      (SELECT COUNT(*)::int FROM contact_enquiries WHERE deleted_at IS NULL AND status = 'new') AS new_enquiries
    FROM (SELECT COUNT(*)::int AS certificates, COUNT(c.emailed_at)::int AS certificates_emailed ${certificates}) cert`);

  const byDistrict = await districtStats(allowedDivisionIds);
  const { rows: byFort } = await reportQuery(`
    SELECT f.id, f.name_mr AS name, COUNT(r.id)::int AS count
    FROM forts f
    LEFT JOIN registrations r ON r.fort_id = f.id AND r.deleted_at IS NULL AND r.status NOT IN ('rejected', 'duplicate') ${df}
    WHERE f.deleted_at IS NULL
    GROUP BY f.id ORDER BY count DESC, f.sort_order`);
  const { rows: recent } = await reportQuery(`
    SELECT l.id, l.action, l.entity, l.entity_id, l.created_at, a.name AS admin_name
    FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id
    WHERE l.action <> 'login' ORDER BY l.id DESC LIMIT 12`);

  return {
    totals: {
      registrations: statusRows.reduce((sum, row) => sum + row.count, 0),
      ...byStatus,
      today: daily.at(-1)?.count ?? 0,
      ...counts,
    },
    daily,
    by_district: byDistrict.items,
    by_fort: byFort,
    recent_activity: recent,
  };
}

export const dashboard = (allowedDivisionIds) =>
  dashboardCache.get(scopeKey(allowedDivisionIds), () => fetchDashboard(allowedDivisionIds));

// Orders by output column (one row per district / division, so no index is involved); id breaks ties
const countSorts = (id) => ({
  total:    { cols: `total, ${id}`,    dir: "desc" },
  verified: { cols: `verified, ${id}`, dir: "desc" },
  pending:  { cols: `pending, ${id}`,  dir: "desc" },
  rejected: { cols: `rejected, ${id}`, dir: "desc" },
});
export const DISTRICT_SORTS = { district: { cols: "district, d.id", dir: "asc" }, ...countSorts("d.id") };
export const DIVISION_SORTS = { division: { cols: "division, div.id", dir: "asc" }, ...countSorts("div.id") };

// Every district with its counts (one aggregation per scope, cached); sorted and paged in memory.
// COUNT(r.status), not COUNT(r.id): the same numbers (status is never null), read from the (district_id, status) index
// alone instead of every registration row.
const allDistricts = (allowedDivisionIds) => tableCache.get(`districts:${scopeKey(allowedDivisionIds)}`, async () => {
  const df = divisionFilter("r", allowedDivisionIds);
  const { rows } = await reportQuery(`
    SELECT d.id, d.name_mr AS district, d.name_en, d.division_id,
           COUNT(r.status)::int AS total,
           COUNT(r.status) FILTER (WHERE r.status = 'verified')::int AS verified,
           COUNT(r.status) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
           COUNT(r.status) FILTER (WHERE r.status = 'rejected')::int AS rejected
    FROM districts d
    LEFT JOIN registrations r ON r.district_id = d.id AND r.deleted_at IS NULL ${df}
    GROUP BY d.id`);
  return rows;
});

export async function districtStats(allowedDivisionIds, { page: p = 1, limit = 10, ...sort } = {}) {
  return page(sortRows(await allDistricts(allowedDivisionIds), DISTRICT_SORTS, sort, "total"), { page: p, limit });
}

// ── divisionStats ────────────────────────────────────────────────────────────
// A handful of rows per scope — cached whole, paged in memory. COUNT(r.status) as above: index-only on the
// (division_id, status, …) index.

const allDivisions = (allowedDivisionIds) => tableCache.get(`divisions:${scopeKey(allowedDivisionIds)}`, async () => {
  const df = divisionFilter("r", allowedDivisionIds);
  const divScope = allowedDivisionIds === null ? ""
    : allowedDivisionIds.length === 0 ? "AND FALSE"
    : `AND div.id = ANY(ARRAY[${allowedDivisionIds.map(Number).join(",")}]::int[])`;
  const { rows } = await reportQuery(`
    SELECT div.id, div.name_mr AS division, div.name_en,
           COUNT(r.status)::int AS total,
           COUNT(r.status) FILTER (WHERE r.status = 'verified')::int AS verified,
           COUNT(r.status) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
           COUNT(r.status) FILTER (WHERE r.status = 'rejected')::int AS rejected
    FROM divisions div
    LEFT JOIN registrations r ON r.division_id = div.id AND r.deleted_at IS NULL ${df}
    WHERE div.deleted_at IS NULL ${divScope}
    GROUP BY div.id`);
  return rows;
});

export async function divisionStats(allowedDivisionIds, { page: p = 1, limit = 10, ...sort } = {}) {
  return page(sortRows(await allDivisions(allowedDivisionIds), DIVISION_SORTS, sort, "total"), { page: p, limit });
}

// ── cityStats ─────────────────────────────────────────────────────────────────
// Groups registrations by (city free-text, district). "city" is a free-text VARCHAR — null / blank entries are grouped
// as one bucket. All groups of a scope (and district filter) are computed once and cached for CITY_TTL_MS; sorted /
// paged in memory.

// (city, district_id) is unique per row, so it breaks ties and pages never overlap. Outside Maharashtra the district
// is NULL: those rows go last either way.
const citySort = (col, dir) => ({ cols: `${col}, city, district_id`, dir, nullsLast: true });
export const CITY_SORTS = {
  city:          { cols: "city, district_id", dir: "asc", nullsLast: true },
  district:      citySort("district", "asc"),
  registrations: citySort("registrations", "desc"),
  uploaded:      citySort("uploaded", "desc"),
  verified:      citySort("verified", "desc"),
  pending:       citySort("pending", "desc"),
  rejected:      citySort("rejected", "desc"),
  certificates:  citySort("certificates", "desc"),
};

// "uploaded" counts p.registration_id (the same numbers as p.id): the photo side is then read from the current-slot
// index (registration_id, position) alone, not from the photo rows
const allCities = (allowedDivisionIds, district) => cityCache.get(`cities:${scopeKey(allowedDivisionIds)}:${district ?? ""}`, async () => {
  const df = divisionFilter("r", allowedDivisionIds);
  const params = [];
  let districtClause = "";
  if (district) {
    params.push(district);
    districtClause = `AND d.name_mr = $${params.length}`;
  }
  const { rows } = await reportQuery(`
    SELECT
      COALESCE(NULLIF(TRIM(r.city), ''), '(Unknown city)') AS city,
      d.name_mr AS district,
      d.name_en AS district_en,
      d.id      AS district_id,
      COUNT(r.id)::int                                                    AS registrations,
      COUNT(p.registration_id)::int                                       AS uploaded,
      COUNT(r.id) FILTER (WHERE r.status = 'verified')::int               AS verified,
      COUNT(r.id) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
      COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int               AS rejected,
      COUNT(cert.id)::int                                                 AS certificates
    FROM registrations r
    LEFT JOIN districts d       ON d.id = r.district_id
    LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
    LEFT JOIN certificates cert ON cert.registration_id = r.id AND cert.revoked_at IS NULL
    WHERE r.deleted_at IS NULL ${df} ${districtClause}
    GROUP BY NULLIF(TRIM(r.city), ''), d.id, d.name_mr, d.name_en`, params);
  return rows;
});

export async function cityStats(allowedDivisionIds, { page: p = 1, limit = 25, district, ...sort } = {}) {
  return page(sortRows(await allCities(allowedDivisionIds, district), CITY_SORTS, sort, "registrations"), { page: p, limit });
}
