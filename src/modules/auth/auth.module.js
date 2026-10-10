import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { authenticate, authorize, signToken } from "../../middleware/auth.js";
import { loginLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest, conflict, forbidden, notFound, unauthorized } from "../../utils/errors.js";
import { paginate, pageMeta, paginationSchema } from "../../utils/pagination.js";

const password = z.string().min(10, "Use at least 10 characters").max(128)
  .regex(/[A-Za-z]/, "Include a letter").regex(/\d/, "Include a number");
const ROLES = ["super_admin", "admin", "moderator"];
const PUBLIC_FIELDS = "id, name, email, role, is_active, last_login_at, created_at, updated_at, deleted_at";

// Constant work for unknown emails so response time does not reveal which emails exist
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

// ------------------------------------------------------------------ /api/auth
export const authRouter = Router();

authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "SELECT id, name, email, role, password_hash, is_active FROM admins WHERE LOWER(email) = $1 AND deleted_at IS NULL",
      [req.body.email],
    );
    const admin = rows[0];
    const ok = await bcrypt.compare(req.body.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !ok) throw unauthorized("Invalid email or password");
    if (!admin.is_active) throw forbidden("This account has been deactivated");
    await query("UPDATE admins SET last_login_at = NOW() WHERE id = $1", [admin.id]);
    req.admin = admin;
    audit(req, "login", "admin", admin.id);
    const { password_hash: _, ...safe } = admin;
    res.json({ token: signToken(admin), admin: safe });
  }),
);

authRouter.get("/me", authenticate, (req, res) => res.json({ admin: req.admin }));

authRouter.post(
  "/change-password",
  authenticate,
  validate({ body: z.object({ current_password: z.string().min(1), new_password: password }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query("SELECT password_hash FROM admins WHERE id = $1", [req.admin.id]);
    if (!(await bcrypt.compare(req.body.current_password, rows[0].password_hash))) {
      throw badRequest("Current password is incorrect", { current_password: "Incorrect password" });
    }
    await query("UPDATE admins SET password_hash = $2 WHERE id = $1", [req.admin.id, await bcrypt.hash(req.body.new_password, 12)]);
    audit(req, "change_password", "admin", req.admin.id);
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ /api/admin/admins (super_admin only)
export const adminsRouter = Router();
adminsRouter.use(authorize("super_admin"));

const idParams = z.object({ id: z.coerce.number().int().positive() });
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(160),
  role: z.enum(ROLES),
  password,
  is_active: z.boolean().default(true),
});
const updateSchema = createSchema.partial().extend({ password: password.optional() });

adminsRouter.get("/", validate({ query: paginationSchema.extend({ q: z.string().max(100).optional(), trashed: z.enum(["true", "false"]).optional() }) }),
  asyncHandler(async (req, res) => {
    const params = [];
    const where = [req.query.trashed === "true" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(name ILIKE $1 OR email ILIKE $1)`);
    }
    const { limit, offset } = paginate(req.query);
    const sql = `WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      query(`SELECT ${PUBLIC_FIELDS} FROM admins ${sql} ORDER BY id LIMIT ${limit} OFFSET ${offset}`, params),
      query(`SELECT COUNT(*)::int AS total FROM admins ${sql}`, params),
    ]);
    res.json({ data: list.rows, meta: pageMeta(req.query, count.rows[0].total) });
  }));

adminsRouter.post("/", validate({ body: createSchema }), asyncHandler(async (req, res) => {
  const { rowCount } = await query("SELECT 1 FROM admins WHERE LOWER(email) = $1 AND deleted_at IS NULL", [req.body.email]);
  if (rowCount) throw conflict("An admin with this email already exists");
  const { rows } = await query(
    `INSERT INTO admins (name, email, role, password_hash, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC_FIELDS}`,
    [req.body.name, req.body.email, req.body.role, await bcrypt.hash(req.body.password, 12), req.body.is_active],
  );
  audit(req, "create", "admin", rows[0].id, { role: rows[0].role });
  res.status(201).json({ data: rows[0] });
}));

adminsRouter.put("/:id", validate({ params: idParams, body: updateSchema }), asyncHandler(async (req, res) => {
  const { password: newPassword, ...fields } = req.body;
  if (req.params.id === req.admin.id && (fields.role && fields.role !== "super_admin" || fields.is_active === false)) {
    throw badRequest("You cannot demote or deactivate your own account");
  }
  if (newPassword) fields.password_hash = await bcrypt.hash(newPassword, 12);
  const keys = Object.keys(fields);
  if (!keys.length) throw badRequest("Nothing to update");
  const { rows } = await query(
    `UPDATE admins SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING ${PUBLIC_FIELDS}`,
    [req.params.id, ...keys.map((k) => fields[k])],
  );
  if (!rows[0]) throw notFound("Admin not found");
  audit(req, "update", "admin", req.params.id, { fields: Object.keys(req.body).filter((k) => k !== "password") });
  res.json({ data: rows[0] });
}));

adminsRouter.delete("/:id", validate({ params: idParams }), asyncHandler(async (req, res) => {
  if (req.params.id === req.admin.id) throw badRequest("You cannot delete your own account");
  const { rowCount } = await query("UPDATE admins SET deleted_at = NOW(), is_active = FALSE WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!rowCount) throw notFound("Admin not found");
  audit(req, "delete", "admin", req.params.id);
  res.status(204).end();
}));

adminsRouter.post("/:id/restore", validate({ params: idParams }), asyncHandler(async (req, res) => {
  const { rows } = await query(`UPDATE admins SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING ${PUBLIC_FIELDS}`, [req.params.id]);
  if (!rows[0]) throw notFound("Admin not found in trash");
  audit(req, "restore", "admin", req.params.id);
  res.json({ data: rows[0] });
}));
