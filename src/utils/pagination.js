import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function paginate({ page, limit }) {
  return { limit, offset: (page - 1) * limit };
}

export function pageMeta({ page, limit }, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

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
