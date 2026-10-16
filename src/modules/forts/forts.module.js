import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../services/audit.service.js";
import { asyncHandler, conflict, notFound } from "../../utils/errors.js";
import { slugify } from "../../utils/format.js";
import { createCrud } from "../shared/crud.factory.js";
import { bool, int, longText, num, sortOrder, text, url } from "../shared/fields.js";

const factSchema = z.object({ label: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(300) });

const schema = z.object({
  slug: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().regex(/^[a-z0-9-]{2,80}$/, "Lowercase letters, digits and - only").optional()),
  name_mr: text(120, { required: true }),
  name_en: text(120, { required: true }),
  location_mr: text(160),
  state: text(60),
  fort_type: z.enum(["hill", "hill-forest", "coastal", "island"]).default("hill"),
  elevation_m: int(),
  tagline: text(200),
  summary: longText(2000),
  history: longText(30000),
  facts: z.array(factSchema).max(20).default([]),
  latitude: num().refine((v) => v == null || (v >= -90 && v <= 90), "Invalid latitude"),
  longitude: num().refine((v) => v == null || (v >= -180 && v <= 180), "Invalid longitude"),
  cover_image: url(),
  is_unesco: bool(true),
  sort_order: sortOrder(),
  is_active: bool(true),
});

async function ensureUniqueSlug(data, id) {
  // Generated on create only, so renaming a fort never silently changes its public URL
  if (!data.slug && data.name_en && id == null) data.slug = slugify(data.name_en);
  if (!data.slug) return data;
  const { rowCount } = await query(
    "SELECT 1 FROM forts WHERE slug = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR id <> $2)",
    [data.slug, id],
  );
  if (rowCount) throw conflict(`Another fort already uses the URL "${data.slug}"`);
  return data;
}

export const forts = createCrud({
  table: "forts",
  entity: "fort",
  schema,
  searchable: ["name_mr", "name_en", "location_mr", "slug"],
  filters: { is_active: "bool", fort_type: "string" },
  jsonFields: ["facts"],
  beforeSave: ensureUniqueSlug,
});

// ------------------------------------------------------------- fort image gallery (admin)
const fortParams = z.object({ id: z.coerce.number().int().positive() });
const imageParams = fortParams.extend({ imageId: z.coerce.number().int().positive() });
const imageBody = z.object({ image_path: url().refine(Boolean, "Image is required"), caption: text(200), sort_order: sortOrder() });

export const fortImagesRouter = Router({ mergeParams: true });

fortImagesRouter.get("/", validate({ params: fortParams }), asyncHandler(async (req, res) => {
  const { rows } = await query("SELECT * FROM fort_images WHERE fort_id = $1 ORDER BY sort_order, id", [req.params.id]);
  res.json({ data: rows });
}));

fortImagesRouter.post("/", validate({ params: fortParams, body: imageBody }), asyncHandler(async (req, res) => {
  await forts.service.get(req.params.id);
  const { rows } = await query(
    "INSERT INTO fort_images (fort_id, image_path, caption, sort_order) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.params.id, req.body.image_path, req.body.caption ?? null, req.body.sort_order],
  );
  audit(req, "add_image", "fort", req.params.id, { image_id: rows[0].id });
  res.status(201).json({ data: rows[0] });
}));

fortImagesRouter.put("/:imageId", validate({ params: imageParams, body: imageBody.partial() }), asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE fort_images SET caption = COALESCE($3, caption), sort_order = COALESCE($4, sort_order)
     WHERE id = $2 AND fort_id = $1 RETURNING *`,
    [req.params.id, req.params.imageId, req.body.caption ?? null, req.body.sort_order ?? null],
  );
  if (!rows[0]) throw notFound("Image not found");
  res.json({ data: rows[0] });
}));

fortImagesRouter.delete("/:imageId", validate({ params: imageParams }), asyncHandler(async (req, res) => {
  const { rowCount } = await query("DELETE FROM fort_images WHERE id = $2 AND fort_id = $1", [req.params.id, req.params.imageId]);
  if (!rowCount) throw notFound("Image not found");
  audit(req, "remove_image", "fort", req.params.id, { image_id: req.params.imageId });
  res.status(204).end();
}));

// ------------------------------------------------------------- public
const PUBLIC_COLUMNS = `f.id, f.slug, f.name_mr, f.name_en, f.location_mr, f.state, f.fort_type, f.elevation_m, f.tagline,
  f.summary, f.latitude, f.longitude, f.cover_image, f.is_unesco, f.sort_order`;

export async function publicFortList() {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS},
            (SELECT COUNT(*)::int FROM registrations r WHERE r.fort_id = f.id AND r.status = 'verified' AND r.deleted_at IS NULL) AS replica_count
     FROM forts f WHERE f.is_active AND f.deleted_at IS NULL ORDER BY f.sort_order, f.id`,
  );
  return rows;
}

export async function publicFortBySlug(slug) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, f.history, f.facts FROM forts f WHERE f.slug = $1 AND f.is_active AND f.deleted_at IS NULL`,
    [slug],
  );
  if (!rows[0]) throw notFound("Fort not found");
  const [images, siblings, replicas] = await Promise.all([
    query("SELECT id, image_path, caption FROM fort_images WHERE fort_id = $1 ORDER BY sort_order, id", [rows[0].id]),
    query(
      `SELECT slug, name_mr, name_en, cover_image, sort_order FROM forts
       WHERE is_active AND deleted_at IS NULL ORDER BY sort_order, id`,
    ),
    query(
      `SELECT p.id, p.thumb_path, p.image_path, d.name_mr AS district, r.name
       FROM registration_photos p
       JOIN registrations r ON r.id = p.registration_id
       LEFT JOIN districts d ON d.id = r.district_id
       WHERE r.fort_id = $1 AND r.status = 'verified' AND r.deleted_at IS NULL AND p.is_current AND p.position = 1
         AND p.is_featured
       ORDER BY p.id DESC LIMIT 12`,
      [rows[0].id],
    ),
  ]);
  const list = siblings.rows;
  const index = list.findIndex((f) => f.slug === slug);
  return {
    ...rows[0],
    images: images.rows,
    replicas: replicas.rows,
    prev: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
  };
}
