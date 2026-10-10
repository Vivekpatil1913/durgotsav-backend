import { query } from "../../db/pool.js";

export async function publicStats() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM registrations WHERE deleted_at IS NULL AND status <> 'rejected') AS participants,
      (SELECT COUNT(*)::int FROM registrations WHERE deleted_at IS NULL AND status = 'verified')  AS verified,
      (SELECT COUNT(DISTINCT district_id)::int FROM registrations WHERE deleted_at IS NULL AND status <> 'rejected' AND district_id IS NOT NULL) AS districts,
      (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL AND is_active) AS forts`);
  return rows[0];
}

export async function dashboard() {
  const [totals, daily, byDistrict, byFort, byType, recent] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL)::int                                   AS registrations,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.status = 'pending')::int          AS pending,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.status = 'info_requested')::int   AS info_requested,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.status = 'verified')::int         AS verified,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.status = 'rejected')::int         AS rejected,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.created_at >= CURRENT_DATE)::int  AS today,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND r.status = 'pending' AND p.duplicate_of_photo_id IS NOT NULL)::int AS pending_duplicates,
        COUNT(*) FILTER (WHERE r.deleted_at IS NULL AND p.is_featured)::int                 AS gallery_photos,
        (SELECT COUNT(*)::int FROM certificates c WHERE c.revoked_at IS NULL)               AS certificates,
        (SELECT COUNT(*)::int FROM certificates c WHERE c.revoked_at IS NULL AND c.emailed_at IS NOT NULL) AS certificates_emailed,
        (SELECT COUNT(*)::int FROM forts WHERE deleted_at IS NULL)                          AS forts,
        (SELECT COUNT(*)::int FROM events WHERE deleted_at IS NULL AND is_active)           AS events,
        (SELECT COUNT(*)::int FROM videos WHERE deleted_at IS NULL AND is_active)           AS videos,
        (SELECT COUNT(*)::int FROM contact_enquiries WHERE deleted_at IS NULL AND status = 'new') AS new_enquiries
      FROM registrations r
      LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current`),
    query(`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
      FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, '1 day') AS day
      LEFT JOIN (SELECT created_at::date AS d, COUNT(*) AS count FROM registrations
                 WHERE deleted_at IS NULL AND created_at >= CURRENT_DATE - 29 GROUP BY 1) c ON c.d = day
      ORDER BY day`),
    districtStats(),
    query(`
      SELECT f.id, f.name_mr AS name, COUNT(r.id)::int AS count
      FROM forts f LEFT JOIN registrations r ON r.fort_id = f.id AND r.deleted_at IS NULL AND r.status <> 'rejected'
      WHERE f.deleted_at IS NULL GROUP BY f.id ORDER BY count DESC, f.sort_order`),
    query(`
      SELECT participant_type AS type, COUNT(*)::int AS count FROM registrations
      WHERE deleted_at IS NULL GROUP BY 1 ORDER BY count DESC`),
    query(`
      SELECT l.id, l.action, l.entity, l.entity_id, l.created_at, a.name AS admin_name
      FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id
      WHERE l.action <> 'login' ORDER BY l.id DESC LIMIT 12`),
  ]);
  return {
    totals: totals.rows[0],
    daily: daily.rows,
    by_district: byDistrict,
    by_fort: byFort.rows,
    by_type: byType.rows,
    recent_activity: recent.rows,
  };
}

export async function districtStats() {
  const { rows } = await query(`
    SELECT d.id, d.name_mr AS district, d.name_en,
           COUNT(r.id)::int AS total,
           COUNT(r.id) FILTER (WHERE r.status = 'verified')::int AS verified,
           COUNT(r.id) FILTER (WHERE r.status IN ('pending','info_requested'))::int AS pending,
           COUNT(r.id) FILTER (WHERE r.status = 'rejected')::int AS rejected
    FROM districts d
    LEFT JOIN registrations r ON r.district_id = d.id AND r.deleted_at IS NULL
    GROUP BY d.id ORDER BY total DESC, d.sort_order`);
  return rows;
}
