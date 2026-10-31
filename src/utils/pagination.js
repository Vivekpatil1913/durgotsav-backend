import { z } from "zod";
import { badRequest } from "./errors.js";

export const paginationSchema = z.object({
  // The bound only keeps OFFSET inside an integer; lists stop browsing much earlier (assertBrowsable)
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginate({ page, limit }) {
  return { limit, offset: (page - 1) * limit };
}

export function pageMeta({ page, limit }, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// An exact COUNT(*) over millions of rows on every page view is the slowest part of a list, so admin lists stop counting
// here, and a deep OFFSET page re-runs every join for each skipped row, so pages past it can't be browsed: admins narrow
// the filters, search or export instead, as in any large search UI.
export const COUNT_CAP = 10_000;

export function assertBrowsable({ page, limit }, what = "matches") {
  if ((page - 1) * limit >= COUNT_CAP) {
    throw badRequest(`Only the first ${COUNT_CAP.toLocaleString("en-IN")} ${what} can be browsed. Narrow the filters or search to see more.`);
  }
}

/**
 * Counts the rows of `fromWhere` ("FROM … WHERE …", no ORDER BY) up to COUNT_CAP: { total, capped }. `db` is the pool's
 * query() or a client. Pair it with cappedMeta() — the admin Pagination shows "10,000+" when capped.
 */
export async function cappedCount(db, fromWhere, params) {
  const run = typeof db === "function" ? db : db.query.bind(db);
  const { rows } = await run(`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fromWhere} LIMIT ${COUNT_CAP + 1}) capped`, params);
  return { total: Math.min(rows[0].total, COUNT_CAP), capped: rows[0].total > COUNT_CAP };
}

export const cappedMeta = (f, count) => ({ ...pageMeta(f, count.total), capped: count.capped });

// ?sort=<key>&dir=asc|desc for an admin list (column-header sorting). Without `fallback`, sort is optional.
export const sortParams = (keys, fallback) => ({
  sort: fallback ? z.enum(keys).default(fallback) : z.enum(keys).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

/**
 * ORDER BY for `sorts[f.sort]` — { cols: "a, b, id", dir: default direction, nullsLast? }. Every column runs in the
 * one direction and the last is unique, so OFFSET pages never overlap. Keys come from a whitelist, never the request.
 */
export function sortSql(sorts, f, fallback) {
  const s = sorts[f.sort] ?? sorts[fallback];
  const dir = (f.dir ?? s.dir) === "asc" ? "ASC" : "DESC";
  return s.cols.split(", ").map((c) => `${c} ${dir}${s.nullsLast ? " NULLS LAST" : ""}`).join(", ");
}
