import { Router } from "express";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { asyncHandler } from "../utils/errors.js";

const router = Router();

const STATIC_ROUTES = [
  ["/", "daily", "1.0"],
  ["/about", "monthly", "0.8"],
  ["/forts", "weekly", "0.9"],
  ["/participate", "weekly", "0.9"],
  ["/shivdurg-bhushan-puraskar-2026", "weekly", "0.9"],
  ["/certificate", "monthly", "0.7"],
  ["/gallery", "daily", "0.8"],
  ["/album", "daily", "0.7"],
  ["/videos", "weekly", "0.5"],
  ["/updates", "weekly", "0.6"],
  ["/faq", "monthly", "0.5"],
  ["/contact", "yearly", "0.5"],
  ["/privacy", "yearly", "0.2"],
  ["/terms", "yearly", "0.2"],
];

// Served by the API; in production the web server proxies https://www.amrutdurgotsav.com/sitemap.xml here.
router.get("/sitemap.xml", asyncHandler(async (req, res) => {
  const { rows } = await query("SELECT slug, updated_at FROM forts WHERE is_active AND deleted_at IS NULL ORDER BY sort_order");
  const urls = [
    ...STATIC_ROUTES.map(([loc, freq, prio]) => `<url><loc>${env.SITE_URL}${loc}</loc><changefreq>${freq}</changefreq><priority>${prio}</priority></url>`),
    ...rows.map((f) => `<url><loc>${env.SITE_URL}/forts/${f.slug}</loc><lastmod>${new Date(f.updated_at).toISOString().slice(0, 10)}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`),
  ];
  res.type("application/xml").set("Cache-Control", "public, max-age=3600")
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`);
}));

export default router;
