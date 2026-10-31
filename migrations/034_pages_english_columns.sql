-- Amrut Durgotsav 2026 — migration 034
-- English versions of the CMS pages (rules, privacy, terms …), read by GET /api/pages/:slug and edited in Admin → Pages.
-- Earlier databases got these columns by hand and no migration created them, so a database built from the migrations
-- answered GET /api/pages/:slug with an error — the participation page lost its rules section. IF NOT EXISTS leaves
-- databases that already have the columns as they are (same types as those).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS title_en VARCHAR(200);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_en TEXT NOT NULL DEFAULT '';
