import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { authorize } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, badRequest, notFound } from "../../utils/errors.js";
import { paginate, pageMeta, paginationSchema } from "../../utils/pagination.js";

const idParams = z.object({ id: z.coerce.number().int().positive() });
const boolish = z.enum(["true", "false"]).transform((v) => v === "true").optional();

/**
 * Builds a service + admin router for a simple CMS table.
 *
 * Column names used in SQL come only from `schema`'s keys and the config below — never from the
 * request — so building identifiers into SQL strings is safe; every value is a bound parameter.
 *
 * @param {object} cfg
 * @param {string} cfg.table
 * @param {string} cfg.entity              audit-log entity name
 * @param {import('zod').ZodObject} cfg.schema  create schema; update uses schema.partial()
 * @param {import('zod').ZodObject} [cfg.updateSchema]
 * @param {string[]} [cfg.searchable]       columns matched with ILIKE by ?q=
 * @param {Record<string,'bool'|'string'>} [cfg.filters]  extra ?column= filters
 * @param {string} [cfg.order]              admin ORDER BY
 * @param {string[]} [cfg.jsonFields]       JSONB columns (must be stringified for pg)
 * @param {boolean} [cfg.softDelete=true]
 * @param {boolean} [cfg.hasSortOrder=true]
 * @param {string[]} [cfg.actions]          subset of list,get,create,update,toggle,delete,restore,reorder
 * @param {string[]} [cfg.roles]            roles allowed (super_admin always allowed)
 * @param {Function} [cfg.guard]            access middleware used instead of the legacy role check (e.g. checkPermission)
 * @param {(data:object)=>object|Promise<object>} [cfg.beforeSave]
 */
export function createCrud(cfg) {
  const {
    table, entity, schema, searchable = [], filters = {}, jsonFields = [], softDelete = true, hasSortOrder = true,
    order = hasSortOrder ? "sort_order ASC, id DESC" : "id DESC", roles = ["admin"], beforeSave = (d) => d,
    actions = ["list", "get", "create", "update", "toggle", "delete", "restore", "reorder"],
  } = cfg;
  const updateSchema = cfg.updateSchema ?? schema.partial();
  const live = softDelete ? "deleted_at IS NULL" : "TRUE";

  const listSchema = paginationSchema.extend({
    q: z.string().trim().max(100).optional(),
    trashed: boolish,
    ...Object.fromEntries(Object.entries(filters).map(([k, t]) => [k, t === "bool" ? boolish : z.string().max(60).optional()])),
  });

  const serialize = (data) =>
    Object.fromEntries(Object.entries(data).map(([k, v]) => [k, jsonFields.includes(k) && v !== null ? JSON.stringify(v) : v]));

  const service = {
    async list(f) {
      const where = [softDelete ? (f.trashed ? "deleted_at IS NOT NULL" : "deleted_at IS NULL") : "TRUE"];
      const params = [];
      for (const key of Object.keys(filters)) {
        if (f[key] === undefined) continue;
        params.push(f[key]);
        where.push(`${key} = $${params.length}`);
      }
      if (f.q && searchable.length) {
        params.push(`%${f.q}%`);
        where.push(`(${searchable.map((c) => `${c}::text ILIKE $${params.length}`).join(" OR ")})`);
      }
      const { limit, offset } = paginate(f);
      const sqlWhere = `WHERE ${where.join(" AND ")}`;
      const [rows, count] = await Promise.all([
        query(`SELECT * FROM ${table} ${sqlWhere} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
        query(`SELECT COUNT(*)::int AS total FROM ${table} ${sqlWhere}`, params),
      ]);
      return { data: rows.rows, meta: pageMeta(f, count.rows[0].total) };
    },

    async get(id) {
      const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound(`${entity} not found`);
      return rows[0];
    },

    async create(input) {
      const data = serialize(await beforeSave(input, null));
      const keys = Object.keys(data);
      const { rows } = await query(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        keys.map((k) => data[k]),
      );
      return rows[0];
    },

    async update(id, input) {
      const data = serialize(await beforeSave(input, id));
      const keys = Object.keys(data);
      if (!keys.length) return service.get(id);
      const { rows } = await query(
        `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 AND ${live} RETURNING *`,
        [id, ...keys.map((k) => data[k])],
      );
      if (!rows[0]) throw notFound(`${entity} not found`);
      return rows[0];
    },

    async toggle(id) {
      const { rows } = await query(`UPDATE ${table} SET is_active = NOT is_active WHERE id = $1 AND ${live} RETURNING *`, [id]);
      if (!rows[0]) throw notFound(`${entity} not found`);
      return rows[0];
    },

    async remove(id) {
      const sql = softDelete
        ? `UPDATE ${table} SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`
        : `DELETE FROM ${table} WHERE id = $1`;
      const { rowCount } = await query(sql, [id]);
      if (!rowCount) throw notFound(`${entity} not found`);
    },

    async restore(id) {
      const { rows } = await query(`UPDATE ${table} SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *`, [id]);
      if (!rows[0]) throw notFound(`${entity} not found in trash`);
      return rows[0];
    },

    async reorder(items) {
      await Promise.all(items.map(({ id, sort_order }) => query(`UPDATE ${table} SET sort_order = $2 WHERE id = $1`, [id, sort_order])));
    },

    // Public listing: active, not deleted
    async listPublic({ limit = 200, extraWhere = "", params = [], orderBy = order } = {}) {
      const { rows } = await query(
        `SELECT * FROM ${table} WHERE ${live} AND is_active ${extraWhere} ORDER BY ${orderBy} LIMIT ${Number(limit)}`,
        params,
      );
      return rows;
    },
  };

  const router = Router();
  const can = (a) => actions.includes(a);
  router.use(cfg.guard ?? authorize(...roles));

  if (can("list")) {
    router.get("/", validate({ query: listSchema }), asyncHandler(async (req, res) => res.json(await service.list(req.query))));
  }
  if (can("reorder") && hasSortOrder) {
    const reorderSchema = z.object({
      items: z.array(z.object({ id: z.number().int().positive(), sort_order: z.number().int() })).min(1).max(500),
    });
    router.put("/reorder", validate({ body: reorderSchema }), asyncHandler(async (req, res) => {
      await service.reorder(req.body.items);
      audit(req, "reorder", entity, null, { count: req.body.items.length });
      res.json({ ok: true });
    }));
  }
  if (can("get")) {
    router.get("/:id", validate({ params: idParams }), asyncHandler(async (req, res) => res.json({ data: await service.get(req.params.id) })));
  }
  if (can("create")) {
    router.post("/", validate({ body: schema }), asyncHandler(async (req, res) => {
      const row = await service.create(req.body);
      audit(req, "create", entity, row.id);
      res.status(201).json({ data: row });
    }));
  }
  if (can("update")) {
    router.put("/:id", validate({ params: idParams, body: updateSchema }), asyncHandler(async (req, res) => {
      if (!Object.keys(req.body).length) throw badRequest("Nothing to update");
      const row = await service.update(req.params.id, req.body);
      audit(req, "update", entity, row.id, { fields: Object.keys(req.body) });
      res.json({ data: row });
    }));
  }
  if (can("toggle")) {
    router.patch("/:id/toggle", validate({ params: idParams }), asyncHandler(async (req, res) => {
      const row = await service.toggle(req.params.id);
      audit(req, row.is_active ? "activate" : "deactivate", entity, row.id);
      res.json({ data: row });
    }));
  }
  if (can("delete")) {
    router.delete("/:id", validate({ params: idParams }), asyncHandler(async (req, res) => {
      await service.remove(req.params.id);
      audit(req, "delete", entity, req.params.id);
      res.status(204).end();
    }));
  }
  if (can("restore") && softDelete) {
    router.post("/:id/restore", validate({ params: idParams }), asyncHandler(async (req, res) => {
      const row = await service.restore(req.params.id);
      audit(req, "restore", entity, row.id);
      res.json({ data: row });
    }));
  }

  return { service, router };
}
