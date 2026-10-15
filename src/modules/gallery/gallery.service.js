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

// Curated gallery: verified photos an admin has marked as featured
export async function gallery({ page, limit, district_id, fort_id }) {
  const params = [];
  const where = `${VERIFIED_PHOTOS} AND p.is_featured ${filters({ district_id, fort_id }, params)}`;
  const [items, count] = await Promise.all([
    query(`SELECT ${ITEM_COLUMNS} ${where} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    query(`SELECT COUNT(*)::int AS total ${where}`, params),
  ]);
  return { data: items.rows, meta: pageMeta({ page, limit }, count.rows[0].total) };
}

// Photo album: every verified photo, ALBUM_PAGE_SIZE per page.
// Keeps the 2025 response keys (page, images, total_images, total_pages) and adds richer `items`.
export async function album({ page, district_id, fort_id }) {
  const limit = env.ALBUM_PAGE_SIZE;
  const params = [];
  const where = `${VERIFIED_PHOTOS} ${filters({ district_id, fort_id }, params)}`;
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
