import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { forbidden, unauthorized } from "../utils/errors.js";

export const signToken = (admin) =>
  jwt.sign({ sub: admin.id, role: admin.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });

// Verifies the bearer token and re-reads the admin from DB on every request.
// This catches deactivated accounts immediately and loads the current role + permissions
// so revoking a permission takes effect on the next request without forcing a re-login.
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      throw unauthorized("Session expired, please log in again");
    }
    const { rows } = await query(
      `SELECT a.id, a.name, a.email, a.role, a.role_id,
              r.name  AS role_name,
              r.slug  AS role_slug,
              r.is_admin,
              r.permissions AS role_permissions
       FROM   admins a
       JOIN   roles  r ON r.id = a.role_id
       WHERE  a.id = $1 AND a.is_active AND a.deleted_at IS NULL AND r.deleted_at IS NULL`,
      [payload.sub],
    );
    if (!rows[0]) throw unauthorized("Account is no longer active");
    req.admin = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// Legacy guard: super_admin passes; otherwise role must be in the list.
// Kept for existing routes; new routes should prefer checkPermission() from permission.js.
export const authorize = (...roles) => (req, res, next) => {
  if (!req.admin) return next(unauthorized());
  if (req.admin.is_admin || roles.includes(req.admin.role)) return next();
  next(forbidden());
};
