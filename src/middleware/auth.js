import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { forbidden, unauthorized } from "../utils/errors.js";

export const signToken = (admin) =>
  jwt.sign({ sub: admin.id, role: admin.role }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });

// Verifies the bearer token and re-reads the admin so deactivated/deleted accounts lose access immediately.
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
      "SELECT id, name, email, role FROM admins WHERE id = $1 AND is_active AND deleted_at IS NULL",
      [payload.sub],
    );
    if (!rows[0]) throw unauthorized("Account is no longer active");
    req.admin = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// super_admin passes every check; otherwise the role must be listed.
export const authorize = (...roles) => (req, res, next) => {
  if (!req.admin) return next(unauthorized());
  if (req.admin.role === "super_admin" || roles.includes(req.admin.role)) return next();
  next(forbidden());
};
