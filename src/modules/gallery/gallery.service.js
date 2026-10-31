import { env } from "../../config/env.js";
import { query, reportQuery, withTransaction } from "../../db/pool.js";
import { createCache } from "../../utils/cache.js";
import { formatRegistrationNo, latinDigits, likeContains, parseRegistrationNo } from "../../utils/format.js";
import { COUNT_CAP, pageMeta } from "../../utils/pagination.js";

// The public set: the current main photo of each verified registration that an admin selected for the website.
// Only the columns the filters need — names are joined in after the page of ids is picked.
const SELECTED_PHOTOS = `
  FROM registration_photos p
  JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
  WHERE p.is_current AND p.position = 1 AND p.is_featured`;

const ITEM_COLUMNS = `p.id, p.image_path, p.thumb_path, p.width, p.height, r.name, r.participant_type,
  d.name_mr AS district, d.name_en AS district_en, f.name_mr AS fort, f.name_en AS fort_en, f.slug AS fort_slug`;

// OFFSET walks every row it skips, so it is never asked to skip more than one BLOCK: deeper pages seek from an anchor
// (below) first. A set smaller than one BLOCK needs no anchors.
const BLOCK = 10_000;

function filters({ district_id, fort_id }, params) {
  let sql = "";
  if (district_id) {
    params.push(district_id);
    sql += ` AND r.district_id = $${params.length}`;
  }
  if (fort_id) {
    params.push(fort_id);
    sql += ` AND r.fort_id = $${params.length}`;
  }
  return sql;
}

// Every gallery and album view needs its set's summary, so each instance shares it per filter: concurrent misses share
// one query, and the old value is served while one refresh runs (utils/cache.js). A large set's summary is a whole-set
// scan and a minute's lag in its total is invisible (page rows are always read fresh), so it is refreshed once a minute
// and an admin's change does not drop it. A smaller set's is cheaper but asked for as often, so it is kept for 15 s and
// dropped as soon as an admin changes what the website shows (clearGalleryCache): this instance shows the change at
// once, other instances within 15 s.
const LARGE_TTL_MS = 60_000;
const SMALL_TTL_MS = 15_000;
const summaries = createCache({ ttlMs: SMALL_TTL_MS, maxEntries: 1_000, name: "gallery-summary" });
const largeSummaries = createCache({ ttlMs: LARGE_TTL_MS, maxEntries: 1_000, name: "gallery-summary-large" });
// Filters whose set has reached BLOCK photos: from then on their summaries come from largeSummaries
const largeSets = new Set();
const latestPhotos = createCache({ ttlMs: SMALL_TTL_MS, maxEntries: 10, name: "gallery-latest" });
// The Website Gallery tabs' counts per access scope (scopeStats below)
const scopeStatsCache = createCache({ ttlMs: 60_000, maxEntries: 300, name: "website-gallery-stats" });

// A filter's total and its anchors: every BLOCK-th id of the set, newest first — anchors[k] is the id at row
// (k + 1) * BLOCK, so a set of N photos has N / BLOCK of them, never every id. One pass gives both, so the page
// count and the anchors always describe the same moment. The scan has a 20 s limit of its own: one that cannot finish
// fails alone (the cache keeps the old value) instead of holding a pooled connection for the pool's full minute.
function computeSummary({ district_id, fort_id }) {
  const params = [];
  const where = filters({ district_id, fort_id }, params);
  params.push(BLOCK);
  return withTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '20s'");
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(array_agg(id ORDER BY n) FILTER (WHERE n % $${params.length} = 0), '{}') AS anchors
       FROM (SELECT p.id, row_number() OVER (ORDER BY p.id DESC) AS n ${SELECTED_PHOTOS} ${where}) ranked`,
      params,
    );
    return rows[0];
  });
}

function summaryFor({ district_id, fort_id }) {
  const key = `${district_id ?? ""}:${fort_id ?? ""}`;
  const compute = () => computeSummary({ district_id, fort_id });
  return summaries.get(key, async () => {
    if (largeSets.has(key)) return largeSummaries.get(key, compute);
    const summary = await compute();
    if (summary.total >= BLOCK) largeSets.add(key);
    return summary;
  });
}

/**
 * Drops what this instance shares of the website's photo set after an admin changes it (shows or hides a photo,
 * approves, rejects, deletes or restores a registration): small sets' summaries and the latest photos are read fresh
 * on the next request. Large sets and the Website Gallery tab counts keep their minute (see above and scopeStats).
 */
export function clearGalleryCache() {
  summaries.clear();
  latestPhotos.clear();
}

// One page of the public set, newest first, at any depth. The inner query picks the page's ids off the indexes alone;
// only those rows are then joined to names. A page past the end is clamped to the last page.
async function selectedPage({ page, limit, district_id, fort_id }) {
  const { total, anchors } = await summaryFor({ district_id, fort_id });
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(page, totalPages);
  let offset = (current - 1) * limit;
  const params = [];
  let where = filters({ district_id, fort_id }, params);
  // Past the first block, start just after the nearest anchor at or before the offset: rows newer than it are skipped
  // by the index seek, and OFFSET only walks the rest of one block — so page 100,000 costs about what page 1,000 does.
  const k = Math.min(Math.floor(offset / BLOCK), anchors.length);
  if (k) {
    params.push(anchors[k - 1]);
    where += ` AND p.id < $${params.length}`;
    offset -= k * BLOCK;
  }
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${ITEM_COLUMNS}
     FROM (SELECT p.id ${SELECTED_PHOTOS} ${where} ORDER BY p.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}) pick
     JOIN registration_photos p ON p.id = pick.id
     JOIN registrations r ON r.id = p.registration_id
     LEFT JOIN districts d ON d.id = r.district_id
     LEFT JOIN forts f ON f.id = r.fort_id
     ORDER BY p.id DESC`,
    params,
  );
  return { rows, total, page: current, totalPages };
}

// The newest `limit` photos of the public set (the home page, the 2025 /gallery-images link): a first page needs no
// count and no anchors. Shared for 15 s like a small set's summary, and dropped with it.
export function latest(limit) {
  return latestPhotos.get(limit, async () => {
    const { rows } = await query(
      `SELECT ${ITEM_COLUMNS}
       FROM (SELECT p.id ${SELECTED_PHOTOS} ORDER BY p.id DESC LIMIT $1) pick
       JOIN registration_photos p ON p.id = pick.id
       JOIN registrations r ON r.id = p.registration_id
       LEFT JOIN districts d ON d.id = r.district_id
       LEFT JOIN forts f ON f.id = r.fort_id
       ORDER BY p.id DESC`,
      [limit],
    );
    return rows;
  });
}

// Curated gallery: verified photos an admin has selected/featured for the website
export async function gallery({ page, limit, district_id, fort_id }) {
  const result = await selectedPage({ page, limit, district_id, fort_id });
  return { data: result.rows, meta: { page: result.page, limit, total: result.total, totalPages: result.totalPages } };
}

// Photo album: only admin-selected verified photos
export async function album({ page, district_id, fort_id }) {
  const limit = env.ALBUM_PAGE_SIZE;
  const result = await selectedPage({ page, limit, district_id, fort_id });
  return {
    page: result.page,
    page_size: limit,
    images: result.rows.map((i) => i.image_path),
    items: result.rows,
    total_images: result.total,
    total_pages: result.totalPages,
  };
}

// ---------------------------------------------------------------- Admin: Website Gallery management
// Numbered pages stop here (OFFSET walks every row it skips); past it the admin narrows the filters or searches
export const WEBSITE_GALLERY_MAX_PAGE = 500;

// null = all divisions (super admin); [] = none; [ids] = those divisions
const scopeKey = (allowedDivisionIds) => (allowedDivisionIds === null ? "all" : [...allowedDivisionIds].map(Number).sort((a, b) => a - b).join(",") || "none");

// The tabs' counts of one access scope (its verified photos, on and off the website) count the whole scope, so they
// are shared per scope for a minute and run on the report pool. An admin's change does not drop them: approvals come
// every few seconds, and each page view would then wait for a report connection to recount the scope (the page adjusts
// its own toggles' counts in place). Two counts in one statement (one snapshot), each answered from an index alone:
// every current main photo from the current-slot index, those on the website from the small selected-photos index;
// the rest are off the website.
function scopeStats(allowedDivisionIds) {
  return scopeStatsCache.get(scopeKey(allowedDivisionIds), async () => {
    const photos = `
      FROM registration_photos p
      JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
      WHERE p.is_current AND p.position = 1 ${allowedDivisionIds === null ? "" : "AND r.division_id = ANY($1::int[])"}`;
    const { rows: [counts] } = await reportQuery(
      `SELECT (SELECT COUNT(*)::int ${photos}) AS total_verified,
              (SELECT COUNT(*)::int ${photos} AND p.is_featured) AS total_on_website`,
      allowedDivisionIds === null ? [] : [allowedDivisionIds],
    );
    return { ...counts, total_off_website: counts.total_verified - counts.total_on_website };
  });
}

const ADMIN_COLUMNS = `
  p.id AS photo_id,
  p.image_path,
  p.thumb_path,
  p.width,
  p.height,
  p.is_featured,
  p.created_at AS photo_created_at,
  r.id AS registration_id,
  r.name AS participant_name,
  r.participant_type,
  r.organization_name,
  r.phone,
  r.email,
  r.city,
  r.status,
  r.created_at AS submitted_at,
  r.reviewed_at,
  d.id AS district_id,
  d.name_mr AS district_name,
  d.name_en AS district_name_en,
  div.id AS division_id,
  div.name_mr AS division_name,
  t.id AS taluka_id,
  t.name_mr AS taluka_name,
  f.id AS fort_id,
  f.name_mr AS fort_name,
  f.name_en AS fort_name_en,
  f.slug AS fort_slug
`;

const ADMIN_ORDER = {
  newest: "p.id DESC",
  oldest: "p.id ASC",
  name: "r.name ASC, p.id DESC",
  display_first: "p.is_featured DESC, p.id DESC",
  display_last: "p.is_featured ASC, p.id DESC",
};

/**
 * One page of the verified photos an admin may curate, with the counts the page shows. Without filters or search the
 * list is a whole tab, so its counts come from the scope's shared tab counts and nothing is counted per request.
 * A filtered list is counted up to COUNT_CAP (filter_total_capped; on and off counts are then null): a narrow one
 * (under the cap) is collected first and only its rows are sorted — the OFFSET 0 fence keeps the planner from walking
 * the whole photo index hoping to meet matches — while a broad one is dense enough that its sort order finds a page
 * at once.
 */
export async function adminListVerifiedPhotos(options, allowedDivisionIds) {
  const page = Math.min(WEBSITE_GALLERY_MAX_PAGE, Math.max(1, Number(options.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const offset = (page - 1) * limit;
  const params = [];

  // The current main photo of each live verified registration in the admin's divisions (names are joined in for the
  // page's rows only)
  let where = `
    FROM registration_photos p
    JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
    WHERE p.is_current AND p.position = 1`;
  if (allowedDivisionIds !== null) {
    params.push(allowedDivisionIds);
    where += ` AND r.division_id = ANY($${params.length}::int[])`;
  }

  // Display status filter: 'all' | 'selected' | 'unselected' (featured / not_featured are older names)
  const display = { featured: "selected", not_featured: "unselected" }[options.display_status] ?? options.display_status ?? "all";
  if (display === "selected") where += " AND p.is_featured";
  else if (display === "unselected") where += " AND NOT p.is_featured";

  let narrowed = false;
  for (const column of ["division_id", "district_id", "taluka_id", "fort_id"]) {
    if (!options[column]) continue;
    params.push(Number(options[column]));
    where += ` AND r.${column} = $${params.length}`;
    narrowed = true;
  }

  // Search, as in the registrations list: every branch must be index-backed or the whole OR scans every registration.
  // A number searches the mobile and WhatsApp numbers, text the name, email and organisation (trigram indexes), either
  // one the registration number. Contains-search needs 3 characters; shorter input only matches a registration number.
  const q = latinDigits(options.q ?? "");
  if (q) {
    narrowed = true;
    const id = parseRegistrationNo(q);
    const idClause = id ? `r.id = ${Number(id)}` : null;
    if (q.length < 3) {
      where += ` AND ${idClause ?? "FALSE"}`;
    } else {
      params.push(likeContains(q));
      const like = `$${params.length}`;
      const branches = /^\d+$/.test(q)
        ? [`r.phone LIKE ${like}`, `r.whatsapp_number LIKE ${like}`]
        : [`r.name ILIKE ${like}`, `r.email ILIKE ${like}`, `r.organization_name ILIKE ${like}`];
      where += ` AND (${[...branches, idClause].filter(Boolean).join(" OR ")})`;
    }
  }

  const order = ADMIN_ORDER[options.sort] ?? ADMIN_ORDER.newest;
  let pick = `SELECT p.id ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
  let filtered = null;
  if (narrowed) {
    const { rows: [count] } = await query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_featured)::int AS selected
       FROM (SELECT p.is_featured ${where} LIMIT ${COUNT_CAP + 1}) capped`,
      params,
    );
    filtered = count.total > COUNT_CAP
      ? { total: COUNT_CAP, selected: null, capped: true }
      : { total: count.total, selected: count.selected, capped: false };
    if (!filtered.capped) {
      pick = `SELECT p.id FROM registration_photos p JOIN registrations r ON r.id = p.registration_id
              WHERE p.id IN (SELECT p.id ${where} OFFSET 0) ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
    }
  }

  const [{ rows }, stats] = await Promise.all([
    query(
      `SELECT ${ADMIN_COLUMNS}
       FROM (${pick}) pick
       JOIN registration_photos p ON p.id = pick.id
       JOIN registrations r ON r.id = p.registration_id
       LEFT JOIN districts d ON d.id = r.district_id
       LEFT JOIN divisions div ON div.id = r.division_id
       LEFT JOIN talukas t ON t.id = r.taluka_id
       LEFT JOIN forts f ON f.id = r.fort_id
       ORDER BY ${order}`,
      params,
    ),
    scopeStats(allowedDivisionIds),
  ]);

  // A filtered list was counted above; a whole tab takes the scope's counts
  const set = filtered
    ?? (display === "selected" ? { total: stats.total_on_website, selected: stats.total_on_website, capped: false }
      : display === "unselected" ? { total: stats.total_off_website, selected: 0, capped: false }
      : { total: stats.total_verified, selected: stats.total_on_website, capped: false });

  return {
    data: rows.map((row) => ({ ...row, registration_no: formatRegistrationNo(row.registration_id) })),
    meta: {
      ...pageMeta({ page, limit }, set.total),
      totalPages: Math.min(WEBSITE_GALLERY_MAX_PAGE, Math.max(1, Math.ceil(set.total / limit))),
      capped: set.capped,
    },
    counts: {
      filter_total: set.total,
      filter_selected: set.selected,
      filter_unselected: set.selected === null ? null : set.total - set.selected,
      filter_total_capped: set.capped,
      total_verified: stats.total_verified,
      total_on_website: stats.total_on_website,
      total_off_website: stats.total_off_website,
    },
  };
}

/**
 * Shows or hides photos on the website; returns the ids changed. A photo is shown only for a live, approved
 * registration inside the admin's divisions. Those registrations are locked first (FOR SHARE, in id order, as review()
 * locks them), so a photo cannot be shown while its registration is being rejected or deleted: that change waits, or
 * this one sees it. Hiding needs no status check.
 */
export async function setWebsiteGalleryDisplay(photoIds, featured, allowedDivisionIds) {
  if (!photoIds?.length) return [];
  if (allowedDivisionIds !== null && !allowedDivisionIds.length) return [];
  const scope = allowedDivisionIds === null ? "" : "AND r.division_id = ANY($2::int[])";
  const scopeParams = allowedDivisionIds === null ? [] : [allowedDivisionIds];

  let rows;
  if (featured) {
    rows = await withTransaction(async (client) => {
      const { rows: approved } = await client.query(
        `SELECT r.id FROM registrations r
         WHERE r.id IN (SELECT registration_id FROM registration_photos WHERE id = ANY($1::int[]))
           AND r.status = 'verified' AND r.deleted_at IS NULL ${scope}
         ORDER BY r.id FOR SHARE OF r`,
        [photoIds, ...scopeParams],
      );
      if (!approved.length) return [];
      const { rows: shown } = await client.query(
        `UPDATE registration_photos SET is_featured = TRUE
         WHERE id = ANY($1::int[]) AND is_current AND registration_id = ANY($2::int[])
         RETURNING id`,
        [photoIds, approved.map((r) => r.id)],
      );
      return shown;
    });
  } else {
    ({ rows } = await query(
      `UPDATE registration_photos p SET is_featured = FALSE
       FROM registrations r
       WHERE p.id = ANY($1::int[]) AND r.id = p.registration_id AND p.is_current ${scope}
       RETURNING p.id`,
      [photoIds, ...scopeParams],
    ));
  }
  if (rows.length) clearGalleryCache();
  return rows.map((r) => r.id);
}
