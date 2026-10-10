import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { lookupLimiter } from "../middleware/rateLimit.js";
import { asyncHandler } from "../utils/errors.js";
import * as galleryService from "../modules/gallery/gallery.service.js";
import * as stats from "../modules/stats/stats.service.js";

// Read-only aliases for the 2025 URLs, so old links / bookmarks / the 2025 album page keep working.
// Admin-side 2025 endpoints (/admin/*, /set-gallery-view) are intentionally NOT kept: they were unauthenticated.
const router = Router();

router.get("/images", validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1) }) }),
  asyncHandler(async (req, res) => res.json(await galleryService.album(req.query))));

router.get("/gallery-images", asyncHandler(async (req, res) => {
  const { data } = await galleryService.gallery({ page: 1, limit: 60 });
  res.json({ images: data.map((i) => ({ image_id: i.id, image_path: i.image_path, district: i.district })) });
}));

router.get("/admin-stats", asyncHandler(async (req, res) => {
  const s = await stats.publicStats();
  res.json({ total_durgaveers: s.participants });
}));

// 2025 certificate link: /certificate/:id?phone=
router.get("/certificate/:id", lookupLimiter, (req, res) => {
  const q = new URLSearchParams({ registration: req.params.id, phone: String(req.query.phone ?? "") });
  res.redirect(308, `/api/certificates/download?${q}`);
});

export default router;
