import { env } from "../../config/env.js";
import { NUMBER_PREFIX } from "../../config/edition.js";
import { query } from "../../db/pool.js";
import { formatRegistrationNo, parseRegistrationNo } from "../../utils/format.js";
import { pageMeta } from "../../utils/pagination.js";

// The public set: the current main photo of each verified registration that an admin selected for the website.
// Only the columns the filters need — names are joined in after the page of ids is picked.
const SELECTED_PHOTOS = `
  FROM registration_photos p
  JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
  WHERE p.is_current AND p.position = 1 AND p.is_featured`;

const ITEM_COLUMNS = `p.id, p.image_path, p.thumb_path, p.width, p.height, r.name, r.participant_type,
  d.name_mr AS district, d.name_en AS district_en, f.name_mr AS fort, f.name_en AS fort_en, f.slug AS fort_slug`;

// OFFSET walks every row it skips, so it is never asked to skip more than one BLOCK: deeper pages seek from an anchor
// (below) first. A set smaller than one BLOCK needs no anchors, and its count is cheap enough to run fresh every time.
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

// A whole-set scan costs real time on a large set and a minute's lag in it is invisible, so it is shared per filter
// for CACHE_TTL; concurrent misses share one query. Small sets stay exact and uncached, so an admin's change shows at once.
const CACHE_TTL = 60_000;
const CACHE_KEYS = 1_000;
const cached = new Map();
const loading = new Map();

function shared(key, load, keep) {
  const hit = cached.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  if (loading.has(key)) return loading.get(key);
  const pending = load()
    .then((value) => {
      cached.delete(key);
      if (keep(value)) {
        if (cached.size >= CACHE_KEYS) cached.delete(cached.keys().next().value);
        cached.set(key, { at: Date.now(), value });
      }
      return value;
    })
    .finally(() => loading.delete(key));
  loading.set(key, pending);
  return pending;
}

// A filter's total and its anchors: every BLOCK-th id of the set, newest first — anchors[k] is the id at row
// (k + 1) * BLOCK, so a set of N photos has N / BLOCK of them, never every id. One pass gives both, so the page
// count and the anchors always describe the same moment.
function summaryFor({ district_id, fort_id }) {
  return shared(`${district_id ?? ""}:${fort_id ?? ""}`, async () => {
    const params = [];
    const where = filters({ district_id, fort_id }, params);
    params.push(BLOCK);
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(array_agg(id ORDER BY n) FILTER (WHERE n % $${params.length} = 0), '{}') AS anchors
       FROM (SELECT p.id, row_number() OVER (ORDER BY p.id DESC) AS n ${SELECTED_PHOTOS} ${where}) ranked`,
      params,
    );
    return rows[0];
  }, (summary) => summary.total >= BLOCK);
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
export async function adminListVerifiedPhotos(options, allowedDivisionIds) {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const offset = (page - 1) * limit;
  const params = [];

  let where = `
    FROM registration_photos p
    JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
    LEFT JOIN districts d ON d.id = r.district_id
    LEFT JOIN divisions div ON div.id = r.division_id
    LEFT JOIN talukas t ON t.id = r.taluka_id
    LEFT JOIN forts f ON f.id = r.fort_id
    WHERE p.is_current AND p.position = 1
  `;

  // Geographic scoping by division
  if (allowedDivisionIds !== null) {
    if (!allowedDivisionIds.length) {
      where += " AND FALSE";
    } else {
      params.push(allowedDivisionIds);
      where += ` AND r.division_id = ANY($${params.length}::int[])`;
    }
  }

  // Display status filter: 'all' | 'selected' | 'unselected'
  if (options.display_status === "selected" || options.display_status === "featured") {
    where += " AND p.is_featured = TRUE";
  } else if (options.display_status === "unselected" || options.display_status === "not_featured") {
    where += " AND p.is_featured = FALSE";
  }

  // Filters
  if (options.division_id) {
    params.push(Number(options.division_id));
    where += ` AND r.division_id = $${params.length}`;
  }
  if (options.district_id) {
    params.push(Number(options.district_id));
    where += ` AND r.district_id = $${params.length}`;
  }
  if (options.taluka_id) {
    params.push(Number(options.taluka_id));
    where += ` AND r.taluka_id = $${params.length}`;
  }
  if (options.fort_id) {
    params.push(Number(options.fort_id));
    where += ` AND r.fort_id = $${params.length}`;
  }

  // Search
  if (options.q?.trim()) {
    const term = `%${options.q.trim()}%`;
    params.push(term, `${NUMBER_PREFIX}-`);
    const pIndex = params.length - 1;
    // Registration number: partial match on the current format, or any edition's full number
    const id = parseRegistrationNo(options.q);
    where += ` AND (
      r.name ILIKE $${pIndex}
      OR r.phone ILIKE $${pIndex}
      OR r.email ILIKE $${pIndex}
      OR d.name_mr ILIKE $${pIndex}
      OR d.name_en ILIKE $${pIndex}
      OR f.name_mr ILIKE $${pIndex}
      OR f.name_en ILIKE $${pIndex}
      OR ($${pIndex + 1}::text || LPAD(r.id::text, 6, '0')) ILIKE $${pIndex}${id ? ` OR r.id = ${Number(id)}` : ""}
    )`;
  }

  // Sorting
  let orderBy = "ORDER BY p.id DESC";
  if (options.sort === "oldest") {
    orderBy = "ORDER BY p.id ASC";
  } else if (options.sort === "name") {
    orderBy = "ORDER BY r.name ASC, p.id DESC";
  } else if (options.sort === "display_first") {
    orderBy = "ORDER BY p.is_featured DESC, p.id DESC";
  } else if (options.sort === "display_last") {
    orderBy = "ORDER BY p.is_featured ASC, p.id DESC";
  }

  const selectColumns = `
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

  const scopeParams = [];
  let scopeWhere = `
    FROM registration_photos p
    JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
    WHERE p.is_current AND p.position = 1
  `;
  if (allowedDivisionIds !== null) {
    if (!allowedDivisionIds.length) {
      scopeWhere += " AND FALSE";
    } else {
      scopeParams.push(allowedDivisionIds);
      scopeWhere += ` AND r.division_id = ANY($1::int[])`;
    }
  }

  const [itemsRes, countRes, statsRes] = await Promise.all([
    query(`SELECT ${selectColumns} ${where} ${orderBy} LIMIT ${limit} OFFSET ${offset}`, params),
    query(`SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE p.is_featured)::int AS selected_in_filter,
                  COUNT(*) FILTER (WHERE NOT p.is_featured)::int AS unselected_in_filter
           ${where}`, params),
    query(`SELECT COUNT(*)::int AS total_verified,
                  COUNT(*) FILTER (WHERE p.is_featured)::int AS total_on_website,
                  COUNT(*) FILTER (WHERE NOT p.is_featured)::int AS total_off_website
           ${scopeWhere}`, scopeParams),
  ]);

  const counts = countRes.rows[0];
  const stats = statsRes.rows[0];

  return {
    data: itemsRes.rows.map((row) => ({ ...row, registration_no: formatRegistrationNo(row.registration_id) })),
    meta: pageMeta({ page, limit }, counts.total),
    counts: {
      filter_total: counts.total,
      filter_selected: counts.selected_in_filter,
      filter_unselected: counts.unselected_in_filter,
      total_verified: stats.total_verified,
      total_on_website: stats.total_on_website,
      total_off_website: stats.total_off_website,
    },
  };
}

export async function setWebsiteGalleryDisplay(photoIds, featured, allowedDivisionIds) {
  if (!photoIds || !photoIds.length) return [];
  const params = [photoIds, Boolean(featured)];
  let scopeClause = "";
  if (allowedDivisionIds !== null) {
    if (!allowedDivisionIds.length) return [];
    params.push(allowedDivisionIds);
    scopeClause = ` AND r.division_id = ANY($${params.length}::int[])`;
  }

  const { rows } = await query(
    `UPDATE registration_photos p
     SET is_featured = $2
     FROM registrations r
     WHERE p.id = ANY($1::int[])
       AND r.id = p.registration_id
       AND r.status = 'verified'
       AND r.deleted_at IS NULL
       AND p.is_current
       ${scopeClause}
     RETURNING p.id`,
    params,
  );
  return rows.map((r) => r.id);
}
