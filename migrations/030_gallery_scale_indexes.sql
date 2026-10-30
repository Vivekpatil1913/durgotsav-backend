-- Amrut Durgotsav 2026 — migration 030
-- Production-scale indexes for the public gallery and photo album (millions of photos).
-- This file runs inside migrate.js's BEGIN/COMMIT transaction (no CONCURRENTLY).
-- On a live database that already has many photos and active traffic, run instead:
--
--   node scripts/create-indexes-live.js
--
-- It creates the identical indexes CONCURRENTLY. IF NOT EXISTS makes both paths safe in any order.

-- The admin-selected set, newest first: a page reads straight off this index and stops at LIMIT
-- instead of sorting every selected photo.
CREATE INDEX IF NOT EXISTS registration_photos_gallery_idx
  ON registration_photos (id DESC) INCLUDE (registration_id)
  WHERE is_current AND position = 1 AND is_featured;

-- The gallery's verified / district / fort checks (and its COUNT) answered from the index alone,
-- never from the wide registrations rows.
CREATE INDEX IF NOT EXISTS registrations_verified_geo_idx
  ON registrations (id) INCLUDE (district_id, fort_id)
  WHERE status = 'verified' AND deleted_at IS NULL;

-- District, fort, and district + fort filters: exactly the matching verified registrations, off the index alone,
-- so a narrow filter reads its own rows instead of walking the whole selected set.
CREATE INDEX IF NOT EXISTS registrations_verified_district_fort_idx
  ON registrations (district_id, fort_id, id)
  WHERE status = 'verified' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS registrations_verified_fort_idx
  ON registrations (fort_id, id)
  WHERE status = 'verified' AND deleted_at IS NULL;

-- From a matching registration to its selected photo without reading the photo row.
CREATE INDEX IF NOT EXISTS registration_photos_selected_reg_idx
  ON registration_photos (registration_id) INCLUDE (id)
  WHERE is_current AND position = 1 AND is_featured;

ANALYZE registrations;
ANALYZE registration_photos;
