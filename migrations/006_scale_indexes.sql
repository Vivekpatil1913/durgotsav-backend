-- Migration 006: Production-scale indexes for millions of registrations
-- This file runs inside migrate.js's BEGIN/COMMIT transaction (no CONCURRENTLY).
-- On a live database that already has millions of rows and active traffic,
-- skip this file and run instead:
--
--   node scripts/create-indexes-live.js
--
-- That script creates the identical indexes CONCURRENTLY so no table is locked.
-- IF NOT EXISTS on every statement means both paths are safe to run in any order.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Free-text search (the `q` filter): ILIKE on name/email/org was a full-table
-- scan. GIN trigram indexes reduce it from seconds to milliseconds at scale.
CREATE INDEX IF NOT EXISTS registrations_name_trgm
  ON registrations USING GIN (name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS registrations_email_trgm
  ON registrations USING GIN (email gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS registrations_org_trgm
  ON registrations USING GIN (organization_name gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Composite indexes for common admin filter combos
CREATE INDEX IF NOT EXISTS registrations_district_status_idx
  ON registrations (district_id, status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS registrations_fort_status_idx
  ON registrations (fort_id, status, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Partial index for the moderation queue (pending, oldest-first)
CREATE INDEX IF NOT EXISTS registrations_pending_oldest_idx
  ON registrations (created_at ASC, id ASC)
  WHERE deleted_at IS NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS registrations_verified_created_idx
  ON registrations (created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND status = 'verified';

-- Phone lookup with soft-delete filter
CREATE INDEX IF NOT EXISTS registrations_phone_active_idx
  ON registrations (phone)
  WHERE deleted_at IS NULL;

-- Current photo + duplicate flag (used in moderation COUNT join)
CREATE INDEX IF NOT EXISTS reg_photos_current_dup_idx
  ON registration_photos (registration_id, duplicate_of_photo_id)
  WHERE is_current = TRUE;

-- Certificate search
CREATE INDEX IF NOT EXISTS certificates_cert_no_trgm
  ON certificates USING GIN (certificate_no gin_trgm_ops);

CREATE INDEX IF NOT EXISTS certificates_pending_email_idx
  ON certificates (registration_id)
  WHERE revoked_at IS NULL AND emailed_at IS NULL;

-- Audit log action filter
CREATE INDEX IF NOT EXISTS audit_logs_action_text_idx
  ON audit_logs (action text_pattern_ops);

-- Update planner statistics immediately after index creation
ANALYZE registrations;
ANALYZE registration_photos;
ANALYZE certificates;
ANALYZE audit_logs;
