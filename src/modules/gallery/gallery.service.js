import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { pageMeta } from "../../utils/pagination.js";

const VERIFIED_PHOTOS = `
  FROM registration_photos p
  JOIN registrations r ON r.id = p.registration_id AND r.status = 'verified' AND r.deleted_at IS NULL
  LEFT JOIN districts d ON d.id = r.district_id
  LEFT JOIN forts f ON f.id = r.fort_id
  WHERE p.is_current AND p.position = 1`;

const ITEM_COLUMNS = `p.id, p.image_path, p.thumb_path, p.width, p.height, r.name, r.participant_type,
  d.name_mr AS district, f.name_mr AS fort, f.slug AS fort_slug`;

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

// Curated gallery: verified photos an admin has selected/featured for the website
export async function gallery({ page, limit, district_id, fort_id }) {
  const params = [];
  const where = `${VERIFIED_PHOTOS} AND p.is_featured ${filters({ district_id, fort_id }, params)}`;
  const [items, count] = await Promise.all([
    query(`SELECT ${ITEM_COLUMNS} ${where} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT COUNT(*)::int AS total ${where}`, params),
  ]);
  return { data: items.rows, meta: pageMeta({ page, limit }, count.rows[0].total) };
}

// Photo album: only admin-selected verified photos
export async function album({ page, district_id, fort_id }) {
  const limit = env.ALBUM_PAGE_SIZE;
  const params = [];
  const where = `${VERIFIED_PHOTOS} AND p.is_featured ${filters({ district_id, fort_id }, params)}`;
  const [items, count] = await Promise.all([
    query(`SELECT ${ITEM_COLUMNS} ${where} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT COUNT(*)::int AS total ${where}`, params),
  ]);
  const total = count.rows[0].total;
  return {
    page,
    page_size: limit,
    images: items.rows.map((i) => i.image_path),
    items: items.rows,
    total_images: total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
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
    params.push(term);
    const pIndex = params.length;
    where += ` AND (
      r.name ILIKE $${pIndex}
      OR r.phone ILIKE $${pIndex}
      OR r.email ILIKE $${pIndex}
      OR d.name_mr ILIKE $${pIndex}
      OR d.name_en ILIKE $${pIndex}
      OR f.name_mr ILIKE $${pIndex}
      OR f.name_en ILIKE $${pIndex}
      OR ('DGT26-' || LPAD(r.id::text, 6, '0')) ILIKE $${pIndex}
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
    ('DGT26-' || LPAD(r.id::text, 6, '0')) AS registration_no,
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
    data: itemsRes.rows,
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
