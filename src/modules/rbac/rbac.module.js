import { Router } from "express";
import { z } from "zod";
import { checkPermission } from "../../middleware/permission.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest } from "../../utils/errors.js";
import * as rbac from "./rbac.service.js";
import { createRoleSchema, districtIdsSchema, divisionIdsSchema, updateRoleSchema } from "./rbac.schemas.js";
import { permissionCatalogue } from "./permissions.registry.js";

const idParams = z.object({ id: z.coerce.number().int().positive() });
const router = Router();

// ---------------------------------------------------------------- permission catalogue (matrix UI)
// Returns the list of all modules + their supported levels for the permission-matrix component.
router.get("/catalogue", checkPermission("roles", "read"), asyncHandler(async (_req, res) => {
  res.json({ data: permissionCatalogue() });
}));

// ---------------------------------------------------------------- role CRUD
router.get("/",
  checkPermission("roles", "read"),
  asyncHandler(async (_req, res) => {
    res.json({ data: await rbac.listRoles() });
  }),
);

router.get("/:id",
  checkPermission("roles", "read"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ data: await rbac.getRole(req.params.id) });
  }),
);

router.post("/",
  checkPermission("roles", "write"),
  validate({ body: createRoleSchema }),
  asyncHandler(async (req, res) => {
    const role = await rbac.createRole(req.body);
    audit(req, "create", "role", role.id, { name: role.name });
    res.status(201).json({ data: role });
  }),
);

router.put("/:id",
  checkPermission("roles", "write"),
  validate({ params: idParams, body: updateRoleSchema }),
  asyncHandler(async (req, res) => {
    // Non-admin users cannot edit their own role (prevents self-escalation).
    // is_admin roles are already at the top level and can edit their own role safely.
    if (!req.admin.is_admin && Number(req.params.id) === req.admin.role_id) {
      throw badRequest("You cannot edit your own role");
    }
    const role = await rbac.updateRole(req.params.id, req.body);
    audit(req, "update", "role", role.id, { fields: Object.keys(req.body) });
    res.json({ data: role });
  }),
);

router.delete("/:id",
  checkPermission("roles", "write"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    if (Number(req.params.id) === req.admin.role_id) throw badRequest("You cannot delete your own role");
    await rbac.deleteRole(req.params.id);
    audit(req, "delete", "role", req.params.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- division grants for an admin user
// GET  /roles/admins/:id/divisions  — list divisions assigned to admin
// PUT  /roles/admins/:id/divisions  — replace division list for admin
router.get("/admins/:id/divisions",
  checkPermission("users", "read"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ data: await rbac.getAdminDivisions(req.params.id) });
  }),
);

router.put("/admins/:id/divisions",
  checkPermission("users", "write"),
  validate({ params: idParams, body: divisionIdsSchema }),
  asyncHandler(async (req, res) => {
    const divisions = await rbac.setAdminDivisions(req.params.id, req.body.division_ids, req.admin.id);
    audit(req, "set_divisions", "admin", req.params.id, { division_ids: req.body.division_ids });
    res.json({ data: divisions });
  }),
);

// ---------------------------------------------------------------- district grants for an admin user
router.get("/admins/:id/districts",
  checkPermission("users", "read"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json({ data: await rbac.getAdminDistricts(req.params.id) });
  }),
);

router.put("/admins/:id/districts",
  checkPermission("users", "write"),
  validate({ params: idParams, body: districtIdsSchema }),
  asyncHandler(async (req, res) => {
    const districts = await rbac.setAdminDistricts(req.params.id, req.body.district_ids, req.admin.id);
    audit(req, "set_districts", "admin", req.params.id, { district_ids: req.body.district_ids });
    res.json({ data: districts });
  }),
);

export { router as rbacRouter };
