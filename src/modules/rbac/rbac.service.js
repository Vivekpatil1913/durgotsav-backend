import { query, withTransaction } from "../../db/pool.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { paginate, pageMeta } from "../../utils/pagination.js";

// With table alias — used in SELECT queries that JOIN admins
const ROLE_FIELDS = "r.id, r.name, r.slug, r.description, r.permissions, r.is_admin, r.is_system, r.sort_order, r.created_at, r.updated_at, r.deleted_at";
// Without alias — used in INSERT/UPDATE RETURNING on the roles table alone
const ROLE_COLS   = "id, name, slug, description, permissions, is_admin, is_system, sort_order, created_at, updated_at, deleted_at";

// ---------------------------------------------------------------- roles

export async function listRoles() {
  const { rows } = await query(
    `SELECT ${ROLE_FIELDS},
            COUNT(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.is_active)::int AS user_count
     FROM roles r
     LEFT JOIN admins a ON a.role_id = r.id
     WHERE r.deleted_at IS NULL
     GROUP BY r.id
     ORDER BY r.sort_order, r.id`,
  );
  return rows;
}

export async function getRole(id) {
  const { rows } = await query(
    `SELECT ${ROLE_FIELDS},
            COUNT(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.is_active)::int AS user_count
     FROM roles r
     LEFT JOIN admins a ON a.role_id = r.id
     WHERE r.id = $1 AND r.deleted_at IS NULL
     GROUP BY r.id`,
    [id],
  );
  if (!rows[0]) throw notFound("Role not found");
  return rows[0];
}

export async function createRole({ name, slug, description, permissions, is_admin, sort_order }) {
  const existing = await query("SELECT 1 FROM roles WHERE slug = $1 AND deleted_at IS NULL", [slug]);
  if (existing.rowCount) throw conflict("A role with this slug already exists");
  const { rows } = await query(
    `INSERT INTO roles (name, slug, description, permissions, is_admin, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ROLE_COLS}`,
    [name, slug ?? slugify(name), description ?? null, permissions ?? {}, is_admin ?? false, sort_order ?? 99],
  );
  return rows[0];
}

export async function updateRole(id, { name, description, permissions, is_admin, sort_order }) {
  const role = await getRole(id);

  // Safety: last admin role cannot lose is_admin
  if (role.is_admin && is_admin === false) {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM roles WHERE is_admin = true AND deleted_at IS NULL AND id <> $1",
      [id],
    );
    if (rows[0].n === 0) throw badRequest("Cannot remove admin access from the last admin role");
  }

  const fields = {};
  if (name       !== undefined) fields.name        = name;
  if (description!== undefined) fields.description = description;
  if (permissions!== undefined) fields.permissions = permissions;
  if (is_admin   !== undefined) fields.is_admin    = is_admin;
  if (sort_order !== undefined) fields.sort_order  = sort_order;

  if (!Object.keys(fields).length) return role;

  const keys = Object.keys(fields);
  const { rows } = await query(
    `UPDATE roles SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING ${ROLE_COLS}`,
    [id, ...keys.map((k) => fields[k])],
  );
  if (!rows[0]) throw notFound("Role not found");
  return rows[0];
}

export async function deleteRole(id) {
  const role = await getRole(id);
  if (role.is_system) throw badRequest("Built-in roles cannot be deleted");
  if (role.user_count > 0) throw badRequest(`This role is assigned to ${role.user_count} admin(s) and cannot be deleted`);
  const { rowCount } = await query(
    "UPDATE roles SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  if (!rowCount) throw notFound("Role not found");
}

// ---------------------------------------------------------------- admin division assignments

export async function getAdminDivisions(adminId) {
  const { rows } = await query(
    `SELECT ad.division_id, d.name_mr, d.name_en
     FROM admin_divisions ad
     JOIN divisions d ON d.id = ad.division_id
     WHERE ad.admin_id = $1
     ORDER BY d.sort_order, d.id`,
    [adminId],
  );
  return rows;
}

// Replaces all division grants for an admin in one transaction.
export async function setAdminDivisions(adminId, divisionIds, grantedBy) {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM admin_divisions WHERE admin_id = $1", [adminId]);
    if (divisionIds.length) {
      const vals = divisionIds.map((_, i) => `($1, $${i + 2}, $${divisionIds.length + 2})`).join(", ");
      await client.query(
        `INSERT INTO admin_divisions (admin_id, division_id, granted_by) VALUES ${vals}`,
        [adminId, ...divisionIds, grantedBy],
      );
    }
  });
  return getAdminDivisions(adminId);
}

// ---------------------------------------------------------------- admin district assignments

export async function getAdminDistricts(adminId) {
  const { rows } = await query(
    `SELECT ad.district_id, d.name_mr, d.name_en, d.division_id
     FROM admin_districts ad
     JOIN districts d ON d.id = ad.district_id
     WHERE ad.admin_id = $1
     ORDER BY d.sort_order, d.id`,
    [adminId],
  );
  return rows;
}

export async function setAdminDistricts(adminId, districtIds, grantedBy) {
  await withTransaction(async (client) => {
    await client.query("DELETE FROM admin_districts WHERE admin_id = $1", [adminId]);
    if (districtIds.length) {
      const vals = districtIds.map((_, i) => `($1, $${i + 2}, $${districtIds.length + 2})`).join(", ");
      await client.query(
        `INSERT INTO admin_districts (admin_id, district_id, granted_by) VALUES ${vals}`,
        [adminId, ...districtIds, grantedBy],
      );
    }
  });
  return getAdminDistricts(adminId);
}

// ---------------------------------------------------------------- helpers

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
