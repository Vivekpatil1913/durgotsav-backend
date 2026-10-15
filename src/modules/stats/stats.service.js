import { query } from "../../db/pool.js";

// ── In-process TTL cache (super-admin only; scoped queries are never cached) ──
const DASHBOARD_TTL_MS   = 30_000;
const PUBLIC_STATS_TTL_MS = 60_000;
const _cache = { dashboard: null, dashboardAt: 0, public: null, publicAt: 0 };

export function invalidateStatsCache() {
  _cache.dashboardAt = 0;
  _cache.publicAt = 0;
}

// ── publicStats ──────────────────────────────────────────────────────────────

async function fetchPublicStats() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM registrations WHERE deleted_at IS NULL AND status NOT IN ('rejected', 'duplicate')) AS participants,
      (SELECT COUNT(*)::int FROM registrations WHERE deleted_at IS NULL AND status = 'verified')  AS verified,
      (SELECT COUNT(DISTINCT district_id)::int FROM registrations WHERE deleted_at IS NULL AND status NOT IN ('rejected', 'duplicate') AND district_id IS NOT NULL) AS districts,
      (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL AND is_active) AS forts`);
  return rows[0];
}

export async function publicStats() {
  const now = Date.now();
  if (_cache.public && now - _cache.publicAt < PUBLIC_STATS_TTL_MS) return _cache.public;
  const data = await fetchPublicStats();
  _cache.public = data;
  _cache.publicAt = now;
  return data;
}

// ── dashboard ────────────────────────────────────────────────────────────────
// allowedDivisionIds: null = all (super-admin); [] = none; number[] = scoped.
// Only the unrestricted (null) path is cached — per-scope results change per user.

function divisionFilter(alias, allowedDivisionIds) {
  if (allowedDivisionIds === null) return "";
  if (allowedDivisionIds.length === 0) return "AND FALSE";
  return `AND ${alias}.division_id = ANY(ARRAY[${allowedDivisionIds.map(Number).join(",")}]::int[])`;
}

async function fetchDashboard(allowedDivisionIds) {
  const df = divisionFilter("r", allowedDivisionIds);
  const [totals, daily, byDistrict, byFort, byType, recent] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df})::int                                   AS registrations,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'pending')::int          AS pending,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'info_requested')::int   AS info_requested,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'verified')::int         AS verified,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'rejected')::int         AS rejected,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'duplicate')::int        AS duplicate,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.created_at >= CURRENT_DATE)::int  AS today,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND r.status = 'pending' AND p.duplicate_of_photo_id IS NOT NULL)::int AS pending_duplicates,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL ${df} AND p.is_featured)::int                 AS gallery_photos,
        (SELECT COUNT(*)::int FROM certificates c WHERE c.revoked_at IS NULL)                     AS certificates,
        (SELECT COUNT(*)::int FROM certificates c WHERE c.revoked_at IS NULL AND c.emailed_at IS NOT NULL) AS certificates_emailed,
        (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL)                                AS forts,
        (SELECT COUNT(*)::int FROM events WHERE deleted_at IS NULL AND is_active)                 AS events,
        (SELECT COUNT(*)::int FROM videos WHERE deleted_at IS NULL AND is_active)                 AS videos,
        (SELECT COUNT(*)::int FROM contact_enquiries WHERE deleted_at IS NULL AND status = 'new') AS new_enquiries
      FROM registrations r
      LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1`),
    query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
      FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, '1 day') AS day
      LEFT JOIN (
        SELECT created_at::date AS d, COUNT(*) AS count
        FROM registrations
        WHERE deleted_at IS NULL AND created_at >= CURRENT_DATE - 29 ${df.replace(/r\./g, "")}
        GROUP BY 1
      ) c ON c.d = day
      ORDER BY day`),
    districtStats(allowedDivisionIds),
    query(`
      SELECT f.id, f.name_mr AS name, COUNT(r.id)::int AS count
      FROM forts f
      LEFT JOIN registrations r ON r.fort_id = f.id AND r.deleted_at IS NULL AND r.status NOT IN ('rejected', 'duplicate') ${df}
      WHERE f.deleted_at IS NULL
      GROUP BY f.id ORDER BY count DESC, f.sort_order`),
    query(`
      SELECT participant_type AS type, COUNT(*)::int AS count FROM registrations
      WHERE deleted_at IS NULL ${df} GROUP BY 1 ORDER BY count DESC`),
    query(`
      SELECT l.id, l.action, l.entity, l.entity_id, l.created_at, a.name AS admin_name
      FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id
      WHERE l.action <> 'login' ORDER BY l.id DESC LIMIT 12`),
  ]);
  return {
    totals: totals.rows[0],
    daily: daily.rows,
    by_district: byDistrict.items,
    by_fort: byFort.rows,
    by_type: byType.rows,
    recent_activity: recent.rows,
  };
}

export async function dashboard(allowedDivisionIds) {
  // Cache only for unrestricted (super-admin) access to avoid cross-user data leaks
  if (allowedDivisionIds === null) {
    const now = Date.now();
    if (_cache.dashboard && now - _cache.dashboardAt < DASHBOARD_TTL_MS) return _cache.dashboard;
    const data = await fetchDashboard(null);
    _cache.dashboard = data;
    _cache.dashboardAt = now;
    return data;
  }
  return fetchDashboard(allowedDivisionIds);
}

export async function districtStats(allowedDivisionIds, { page = 1, limit = 10 } = {}) {
  const df     = divisionFilter("r", allowedDivisionIds);
  const offset = (page - 1) * limit;

  const { rows: [{ total }] } = await query(`
    SELECT COUNT(*)::int AS total FROM districts`);

  const { rows: items } = await query(`
    SELECT d.id, d.name_mr AS district, d.name_en, d.division_id,
           COUNT(r.id)::int AS total,
           COUNT(r.id) FILTER (WHERE r.status = 'verified')::int AS verified,
           COUNT(r.id) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
           COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int AS rejected
    FROM districts d
    LEFT JOIN registrations r ON r.district_id = d.id AND r.deleted_at IS NULL ${df}
    GROUP BY d.id ORDER BY total DESC, d.sort_order
    LIMIT $1 OFFSET $2`, [limit, offset]);

  return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ── divisionStats ────────────────────────────────────────────────────────────
// Returns a flat array (max ~6 rows) — no pagination needed.

export async function divisionStats(allowedDivisionIds, { page = 1, limit = 10 } = {}) {
  const df = divisionFilter("r", allowedDivisionIds);
  const divScope = allowedDivisionIds === null ? ""
    : allowedDivisionIds.length === 0 ? "AND FALSE"
    : `AND div.id = ANY(ARRAY[${allowedDivisionIds.map(Number).join(",")}]::int[])`;

  const { rows: [{ total }] } = await query(`
    SELECT COUNT(*)::int AS total FROM divisions WHERE deleted_at IS NULL ${divScope}`);

  const { rows: items } = await query(`
    SELECT div.id, div.name_mr AS division, div.name_en,
           COUNT(r.id)::int AS total,
           COUNT(r.id) FILTER (WHERE r.status = 'verified')::int AS verified,
           COUNT(r.id) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
           COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int AS rejected
    FROM divisions div
    LEFT JOIN registrations r ON r.division_id = div.id AND r.deleted_at IS NULL ${df}
    WHERE div.deleted_at IS NULL ${divScope}
    GROUP BY div.id ORDER BY total DESC, div.sort_order
    LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

// ── cityStats ─────────────────────────────────────────────────────────────────
// Groups registrations by (city free-text, district) with pagination and sort.
// "city" is a free-text VARCHAR — null / blank entries are grouped as one bucket.

const CITY_SORT_COLS = {
  city: "city", registrations: "registrations", uploaded: "uploaded",
  verified: "verified", pending: "pending", rejected: "rejected", certificates: "certificates",
};

export async function cityStats(allowedDivisionIds, { page = 1, limit = 25, sort = "registrations", dir = "desc", district } = {}) {
  const df      = divisionFilter("r", allowedDivisionIds);
  const sortCol = CITY_SORT_COLS[sort] ?? "registrations";
  const sortDir = dir === "asc" ? "ASC" : "DESC";

  // Build optional district filter (by Marathi name from the districts table)
  const params = [];
  let districtClause = "";
  if (district) {
    params.push(district);
    districtClause = `AND d.name_mr = $${params.length}`;
  }

  // COUNT of distinct (city, district) groups for pagination total
  const { rows: [{ total }] } = await query(`
    SELECT COUNT(*)::int AS total FROM (
      SELECT 1 FROM registrations r
      LEFT JOIN districts d ON d.id = r.district_id
      WHERE r.deleted_at IS NULL ${df} ${districtClause}
      GROUP BY NULLIF(TRIM(r.city), ''), d.id
    ) _cnt`, params);

  const lp = params.length + 1;  // $N for LIMIT
  const op = params.length + 2;  // $N+1 for OFFSET

  const { rows: items } = await query(`
    SELECT
      COALESCE(NULLIF(TRIM(r.city), ''), '(Unknown city)') AS city,
      d.name_mr AS district,
      d.name_en AS district_en,
      d.id      AS district_id,
      COUNT(r.id)::int                                                    AS registrations,
      COUNT(p.id)::int                                                    AS uploaded,
      COUNT(r.id) FILTER (WHERE r.status = 'verified')::int               AS verified,
      COUNT(r.id) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
      COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int               AS rejected,
      COUNT(cert.id)::int                                                 AS certificates
    FROM registrations r
    LEFT JOIN districts d       ON d.id = r.district_id
    LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
    LEFT JOIN certificates cert ON cert.registration_id = r.id AND cert.revoked_at IS NULL
    WHERE r.deleted_at IS NULL ${df} ${districtClause}
    GROUP BY NULLIF(TRIM(r.city), ''), d.id, d.name_mr, d.name_en
    ORDER BY ${sortCol} ${sortDir} NULLS LAST
    LIMIT $${lp} OFFSET $${op}`,
    [...params, limit, (page - 1) * limit]);

  return { items, meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}
