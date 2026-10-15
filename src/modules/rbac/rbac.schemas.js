import { z } from "zod";

const permissionLevel = z.object({
  read:   z.boolean().optional(),
  write:  z.boolean().optional(),
  delete: z.boolean().optional(),
}).strict();

// permissions is an open map of { module_key: { read, write, delete } }
const permissionsSchema = z.record(z.string().max(60), permissionLevel);

export const createRoleSchema = z.object({
  name:        z.string().trim().min(2).max(100),
  slug:        z.string().trim().min(2).max(80).regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers and underscores only").optional(),
  description: z.string().trim().max(500).optional(),
  permissions: permissionsSchema.optional(),
  is_admin:    z.boolean().optional(),
  sort_order:  z.number().int().min(0).max(9999).optional(),
});

export const updateRoleSchema = createRoleSchema.partial();

export const divisionIdsSchema = z.object({
  division_ids: z.array(z.number().int().positive()).max(50),
});

export const districtIdsSchema = z.object({
  district_ids: z.array(z.number().int().positive()).max(200),
});
