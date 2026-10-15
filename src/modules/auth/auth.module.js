import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { authenticate, signToken } from "../../middleware/auth.js";
import { checkPermission } from "../../middleware/permission.js";
import { loginLimiter } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest, conflict, forbidden, notFound, unauthorized } from "../../utils/errors.js";
import { paginate, pageMeta, paginationSchema } from "../../utils/pagination.js";
import * as rbac from "../rbac/rbac.service.js";

const password = z.string().min(10, "Use at least 10 characters").max(128)
  .regex(/[A-Za-z]/, "Include a letter").regex(/\d/, "Include a number");

const PUBLIC_FIELDS = "a.id, a.name, a.email, a.role, a.role_id, a.is_active, a.last_login_at, a.created_at, a.updated_at, a.deleted_at";
const WITH_ROLE = `${PUBLIC_FIELDS}, r.name AS role_name, r.slug AS role_slug, r.is_admin`;

// Constant work for unknown emails so response time does not reveal which exist
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

// ------------------------------------------------------------------ /api/auth
export const authRouter = Router();

authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.name, a.email, a.role, a.role_id, a.password_hash, a.is_active,
              r.name AS role_name, r.is_admin, r.permissions AS role_permissions, r.slug AS role_slug
       FROM admins a
       JOIN roles r ON r.id = a.role_id
       WHERE LOWER(a.email) = $1 AND a.deleted_at IS NULL`,
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

authRouter.get("/me", authenticate, asyncHandler(async (req, res) => {
  // Return full admin object including divisions assigned
  const divisions = req.admin.is_admin
    ? null   // super_admin: all divisions
    : await rbac.getAdminDivisions(req.admin.id);
  res.json({ admin: { ...req.admin, divisions } });
}));

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

// ------------------------------------------------------------------ /api/admin/admins
// Guarded by checkPermission("users") — replaces the old authorize("super_admin") guard.
// is_admin roles (super_admin) pass automatically; Admin-role users can also manage users
// if their role grants the "users" permission.
export const adminsRouter = Router();
adminsRouter.use(checkPermission("users", "read"));

const idParams = z.object({ id: z.coerce.number().int().positive() });
const createSchema = z.object({
  name:       z.string().trim().min(2).max(120),
  email:      z.string().trim().toLowerCase().email().max(160),
  role_id:    z.number().int().positive(),
  password,
  is_active:  z.boolean().default(true),
  // Optional: pre-assign division access on create
  division_ids: z.array(z.number().int().positive()).optional(),
});
const updateSchema = createSchema.partial().extend({ password: password.optional() });

adminsRouter.get("/",
  validate({ query: paginationSchema.extend({ q: z.string().max(100).optional(), trashed: z.enum(["true", "false"]).optional() }) }),
  asyncHandler(async (req, res) => {
    const params = [];
    const where = [req.query.trashed === "true" ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"];
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where.push(`(a.name ILIKE $1 OR a.email ILIKE $1)`);
    }
    const { limit, offset } = paginate(req.query);
    const sql = `WHERE ${where.join(" AND ")}`;
    const [list, count] = await Promise.all([
      query(
        `SELECT ${WITH_ROLE} FROM admins a JOIN roles r ON r.id = a.role_id ${sql} ORDER BY a.id LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      query(`SELECT COUNT(*)::int AS total FROM admins a ${sql}`, params),
    ]);
    res.json({ data: list.rows, meta: pageMeta(req.query, count.rows[0].total) });
  }));

adminsRouter.post("/",
  checkPermission("users", "write"),
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query("SELECT 1 FROM admins WHERE LOWER(email) = $1 AND deleted_at IS NULL", [req.body.email]);
    if (rowCount) throw conflict("An admin with this email already exists");

    // Fetch the role to get its slug (kept in admins.role for JWT compat)
    const roleRow = await query("SELECT slug, is_admin FROM roles WHERE id = $1 AND deleted_at IS NULL", [req.body.role_id]);
    if (!roleRow.rowCount) throw badRequest("Invalid role", { role_id: "Role not found" });

    const { rows } = await query(
      `INSERT INTO admins (name, email, role, role_id, password_hash, is_active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, email, role, role_id, is_active, created_at`,
      [req.body.name, req.body.email, roleRow.rows[0].slug, req.body.role_id,
        await bcrypt.hash(req.body.password, 12), req.body.is_active],
    );

    const newAdmin = rows[0];
    if (req.body.division_ids?.length) {
      await rbac.setAdminDivisions(newAdmin.id, req.body.division_ids, req.admin.id);
    }
    audit(req, "create", "admin", newAdmin.id, { role_id: newAdmin.role_id });
    res.status(201).json({ data: newAdmin });
  }));

adminsRouter.get("/:id",
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT ${WITH_ROLE} FROM admins a JOIN roles r ON r.id = a.role_id WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound("Admin not found");
    const divisions = await rbac.getAdminDivisions(req.params.id);
    res.json({ data: { ...rows[0], divisions } });
  }));

adminsRouter.put("/:id",
  checkPermission("users", "write"),
  validate({ params: idParams, body: updateSchema }),
  asyncHandler(async (req, res) => {
    const { password: newPassword, division_ids, role_id, ...fields } = req.body;

    // Self-demotion guard
    if (req.params.id === req.admin.id) {
      if (role_id && role_id !== req.admin.role_id) throw badRequest("You cannot change your own role");
      if (fields.is_active === false) throw badRequest("You cannot deactivate your own account");
    }

    // Last admin guard when changing role or deactivating
    if (role_id || fields.is_active === false) {
      const { rows: activeAdmins } = await query(
        `SELECT COUNT(*)::int AS n FROM admins a JOIN roles r ON r.id = a.role_id
         WHERE a.is_active AND a.deleted_at IS NULL AND r.is_admin = true AND a.id <> $1`,
        [req.params.id],
      );
      if (activeAdmins[0].n === 0) throw badRequest("Cannot remove the last active super-admin");
    }

    // If changing role_id, keep the legacy role slug in sync
    if (role_id) {
      const roleRow = await query("SELECT slug FROM roles WHERE id = $1 AND deleted_at IS NULL", [role_id]);
      if (!roleRow.rowCount) throw badRequest("Invalid role", { role_id: "Role not found" });
      fields.role    = roleRow.rows[0].slug;
      fields.role_id = role_id;
    }
    if (newPassword) fields.password_hash = await bcrypt.hash(newPassword, 12);

    const keys = Object.keys(fields);
    let updated;
    if (keys.length) {
      const { rows } = await query(
        `UPDATE admins SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, name, email, role, role_id, is_active, updated_at`,
        [req.params.id, ...keys.map((k) => fields[k])],
      );
      if (!rows[0]) throw notFound("Admin not found");
      updated = rows[0];
    } else {
      const { rows } = await query(
        "SELECT id, name, email, role, role_id, is_active FROM admins WHERE id = $1 AND deleted_at IS NULL",
        [req.params.id],
      );
      if (!rows[0]) throw notFound("Admin not found");
      updated = rows[0];
    }

    if (division_ids !== undefined) {
      await rbac.setAdminDivisions(req.params.id, division_ids, req.admin.id);
    }

    audit(req, "update", "admin", req.params.id, {
      fields: Object.keys(req.body).filter((k) => k !== "password"),
    });
    res.json({ data: updated });
  }));

adminsRouter.delete("/:id",
  checkPermission("users", "delete"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.admin.id) throw badRequest("You cannot delete your own account");

    // Last admin guard
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM admins a JOIN roles r ON r.id = a.role_id
       WHERE a.is_active AND a.deleted_at IS NULL AND r.is_admin = true AND a.id <> $1`,
      [req.params.id],
    );
    if (rows[0].n === 0) throw badRequest("Cannot delete the last active super-admin");

    const { rowCount } = await query(
      "UPDATE admins SET deleted_at = NOW(), is_active = FALSE WHERE id = $1 AND deleted_at IS NULL",
      [req.params.id],
    );
    if (!rowCount) throw notFound("Admin not found");
    audit(req, "delete", "admin", req.params.id);
    res.status(204).end();
  }));

adminsRouter.post("/:id/restore",
  checkPermission("users", "write"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE admins SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING id, name, email, role, role_id, is_active`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound("Admin not found in trash");
    audit(req, "restore", "admin", req.params.id);
    res.json({ data: rows[0] });
  }));
