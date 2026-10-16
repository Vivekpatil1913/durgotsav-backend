-- Amrut Durgotsav 2026 — migration 017
-- Production-scale indexes for अमृत शिवदुर्ग भूषण पुरस्कार nominations (millions of rows).
-- This file runs inside migrate.js's BEGIN/COMMIT transaction (no CONCURRENTLY).
-- On a live database that already has many nominations and active traffic, run instead:
--
--   node scripts/create-indexes-live.js
--
-- It creates the identical indexes CONCURRENTLY. IF NOT EXISTS makes both paths safe in any order.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Free-text search (the `q` filter): ILIKE '%x%' on these columns was a full-table scan.
CREATE INDEX IF NOT EXISTS award_nominations_name_trgm  ON award_nominations USING GIN (nominee_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS award_nominations_email_trgm ON award_nominations USING GIN (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS award_nominations_ref_trgm   ON award_nominations USING GIN (reference_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS award_nominations_mobile_trgm ON award_nominations USING GIN (mobile gin_trgm_ops);
CREATE INDEX IF NOT EXISTS award_nominators_name_trgm   ON award_nominators USING GIN (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS award_nominators_mobile_trgm ON award_nominators USING GIN (mobile gin_trgm_ops);

-- Public status lookup matches upper(reference_no)
CREATE INDEX IF NOT EXISTS award_nominations_ref_upper_idx ON award_nominations (upper(reference_no));

-- Filter + sort combos: each lets the list read one page straight off the index instead of sorting every match
CREATE INDEX IF NOT EXISTS award_nominations_list_idx     ON award_nominations (edition_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS award_nominations_status_idx   ON award_nominations (edition_id, status, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS award_nominations_category_idx ON award_nominations (edition_id, category, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS award_nominations_district_idx ON award_nominations (edition_id, district_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS award_nominations_taluka_idx   ON award_nominations (edition_id, taluka_id, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS award_nominations_name_idx     ON award_nominations (edition_id, nominee_name, id);
CREATE INDEX IF NOT EXISTS award_nominations_edition_id_idx ON award_nominations (edition_id, id);

-- Superseded by the composite indexes above
DROP INDEX IF EXISTS idx_award_nominations_list;
DROP INDEX IF EXISTS idx_award_nominations_status;
DROP INDEX IF EXISTS idx_award_nominations_category;

ANALYZE award_nominations;
ANALYZE award_nominators;
