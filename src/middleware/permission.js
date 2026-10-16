import { query } from "../db/pool.js";
import { asyncHandler, forbidden, unauthorized } from "../utils/errors.js";
import { canDo } from "../modules/rbac/permissions.registry.js";

// Checks that the authenticated admin can perform `level` on `moduleKey`.
// Roles with is_admin = true bypass the check entirely (super-admin pass-through).
// Returns 403 if the permission is absent.
export const checkPermission = (moduleKey, level = "read") =>
  (req, res, next) => {
    if (!req.admin) return next(unauthorized());
    if (req.admin.is_admin) return next();
    if (!canDo(req.admin.role_permissions, moduleKey, level)) return next(forbidden());
    next();
  };

// Like checkPermission, but for "explicit" modules (registry alwaysEditable, e.g. moderation_bulk):
// is_admin does NOT bypass it — the role's JSONB must grant it, so it can be switched off per role.
export const checkExplicitPermission = (moduleKey, level = "read") =>
  (req, res, next) => {
    if (!req.admin) return next(unauthorized());
    if (req.admin.is_admin && req.admin.role_permissions?.[moduleKey]?.read !== false) return next();
    if (!canDo(req.admin.role_permissions, moduleKey, level)) return next(forbidden());
    next();
  };

// Resolves the authenticated admin's allowed division IDs into req.allowedDivisionIds.
//   null      → all divisions (admin has is_admin role — no scope restriction)
//   number[]  → specific division IDs the admin may access
//   []        → no division access at all (non-admin role with no grants)
//
// Insert this middleware before any handler that needs to scope data by division.
export const scopeToAdminDivisions = asyncHandler(async (req, res, next) => {
  if (!req.admin) return next(unauthorized());
  if (req.admin.is_admin) {
    req.allowedDivisionIds = null;   // unrestricted
    return next();
  }
  const { rows } = await query(
    "SELECT division_id FROM admin_divisions WHERE admin_id = $1",
    [req.admin.id],
  );
  req.allowedDivisionIds = rows.map((r) => r.division_id);
  next();
});

// Checks that `divisionId` (number) is within req.allowedDivisionIds.
// Call after scopeToAdminDivisions. Used for single-record access checks.
export function assertDivisionAccess(req, divisionId) {
  if (req.allowedDivisionIds === null) return;   // super-admin: all allowed
  if (!req.allowedDivisionIds.includes(Number(divisionId))) throw forbidden();
}
