-- Amrut Durgotsav 2026 — migration 024
-- Home page "Important dates" cards become editable from Admin → Settings.
-- Seeds the dates that were hard-coded on the website; a row already present is left alone.

INSERT INTO site_settings (key, value, is_public)
VALUES ('important_dates', '{
  "festival_begins": "2026-11-01",
  "upload_opens": "2026-11-05",
  "upload_closes": "2026-11-20"
}'::jsonb, TRUE)
ON CONFLICT (key) DO NOTHING;
