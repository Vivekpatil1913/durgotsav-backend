-- Amrut Durgotsav 2026 — migration 036
-- Scale for millions of registrations: no request may read a whole large table, and no deploy step may lock one for
-- long. This file runs inside migrate.js's transaction. On a live database with millions of rows, deploy.sh first runs
-- `node scripts/create-indexes-live.js`, which builds the same indexes CONCURRENTLY (no write lock), so the
-- CREATE INDEX IF NOT EXISTS below have nothing left to do. The DROP INDEX statements come last: each needs a brief
-- exclusive lock, held only until the COMMIT that follows.

-- ---------------------------------------------------------------- near-duplicate photos (multi-index hashing)
-- Every registration looks for an earlier photo within 6 bits (Hamming distance) of its 64-bit difference hash. Comparing
-- against every stored photo grows with the table (seconds per registration at millions of photos). Instead the hash is
-- cut into four 16-bit bands: two hashes at most 7 bits apart must have one band at most 1 bit apart (4 × 2 > 7), so the
-- candidates are the photos sharing a band value with one of the 4 × 17 "band ± 1 bit" probes — a GIN lookup — and only
-- those are compared exactly. Same answer as the full comparison, from a small fraction of the rows.
-- Band i is i·65536 + value, so the four bands share one integer space without colliding. An expression index (not a
-- stored column) so adding it never rewrites the table; queries call the same function so the index matches.
CREATE OR REPLACE FUNCTION dhash_band_keys(hash bpchar) RETURNS integer[]
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN hash ~* '^[0-9a-f]{16}$' THEN ARRAY[
               ('x' || substr(hash, 1, 4))::bit(16)::int,
       65536 + ('x' || substr(hash, 5, 4))::bit(16)::int,
      131072 + ('x' || substr(hash, 9, 4))::bit(16)::int,
      196608 + ('x' || substr(hash, 13, 4))::bit(16)::int]
  END
$$;
CREATE INDEX IF NOT EXISTS registration_photos_dhash_keys_gin ON registration_photos USING GIN (dhash_band_keys(dhash));

-- ---------------------------------------------------------------- photos of one registration
-- Every registration_id index was partial (WHERE is_current), so the photo history of one registration (admin detail),
-- un-featuring on reject and the S3 photo numbering read the whole table. photo_no last: MAX(photo_no) is index-only.
CREATE INDEX IF NOT EXISTS registration_photos_registration_idx ON registration_photos (registration_id, photo_no);
-- The moderation "possible duplicates" filter: only flagged main photos (a small set) instead of every current photo
CREATE INDEX IF NOT EXISTS registration_photos_dup_main_idx ON registration_photos (registration_id)
  WHERE is_current AND position = 1 AND duplicate_of_photo_id IS NOT NULL;
-- S3 numbering looks up the highest number in an object folder (storage_key LIKE 'folder/%'). text_pattern_ops makes
-- that prefix match indexable whatever the database collation; uniqueness is unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS registration_photos_storage_key_pattern_uq
  ON registration_photos (storage_key text_pattern_ops) INCLUDE (photo_no) WHERE storage_key IS NOT NULL;

-- ---------------------------------------------------------------- registrations
-- Admin search for a mobile / WhatsApp number is a contains-search ('%98765%'); like name / email / organisation
-- (migration 006) it needs a trigram index, otherwise every search reads every registration.
CREATE INDEX IF NOT EXISTS registrations_phone_trgm
  ON registrations USING GIN (phone gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS registrations_whatsapp_trgm
  ON registrations USING GIN (whatsapp_number gin_trgm_ops) WHERE deleted_at IS NULL;
-- Moderators scoped to a division read their queue in order (and count it) from one range of this index
CREATE INDEX IF NOT EXISTS registrations_div_status_created_idx
  ON registrations (division_id, status, created_at, id) WHERE deleted_at IS NULL;
-- Trash (deleted registrations): a small set, listed newest or oldest first
CREATE INDEX IF NOT EXISTS registrations_trash_idx ON registrations (created_at, id) WHERE deleted_at IS NOT NULL;
-- division and status are correlated (a division's queue); lets the planner estimate scoped queues correctly
CREATE STATISTICS IF NOT EXISTS registrations_div_status_stx (mcv) ON division_id, status FROM registrations;

-- ---------------------------------------------------------------- certificates, email log, audit log
-- The "revoked" filter of the certificates list: a small set, read in list order
CREATE INDEX IF NOT EXISTS certificates_revoked_issued_idx ON certificates (issued_at DESC, id DESC) WHERE revoked_at IS NOT NULL;
-- Download counters and email/regeneration stamps update certificate rows; free space on each page keeps those updates
-- on the same page (HOT), without new entries in the table's indexes. Applies to pages written from now on.
ALTER TABLE certificates SET (fillfactor = 90);
-- Foreign key of the email log (ON DELETE CASCADE from its job)
CREATE INDEX IF NOT EXISTS certificate_email_log_job_idx ON certificate_email_log (job_id);
-- The audit log "by admin" filter
CREATE INDEX IF NOT EXISTS audit_logs_admin_idx ON audit_logs (admin_id, id);

-- ---------------------------------------------------------------- vacuum after inserts
-- Insert-only growth otherwise waits for 20% new rows before autovacuum sets the visibility map (index-only scans) and
-- flushes the trigram/GIN pending lists, which an inserting registration would otherwise have to flush itself.
ALTER TABLE registrations SET (autovacuum_vacuum_insert_threshold = 10000, autovacuum_vacuum_insert_scale_factor = 0);
ALTER TABLE registration_photos SET (autovacuum_vacuum_insert_threshold = 10000, autovacuum_vacuum_insert_scale_factor = 0);

-- Fresh statistics for the new expression index and extended statistics (the planner otherwise guesses)
ANALYZE registrations;
ANALYZE registration_photos;

-- ---------------------------------------------------------------- superseded and unused indexes
-- Every insert and every status change writes all of a table's indexes, so each redundant one only slows registrations
-- and reviews. Each of these repeats the leading columns and predicate of the index after the arrow, or is never used.
DROP INDEX IF EXISTS registration_photos_dhash_idx;        -- a btree on the hex text can never serve a distance search
DROP INDEX IF EXISTS registration_photos_reg_idx;          -- → registration_photos_current_slot_uq
DROP INDEX IF EXISTS reg_photos_current_dup_idx;           -- → registration_photos_dup_main_idx
DROP INDEX IF EXISTS registration_photos_storage_key_idx;  -- → registration_photos_storage_key_pattern_uq
DROP INDEX IF EXISTS idx_registrations_div_status;         -- → registrations_div_status_created_idx
DROP INDEX IF EXISTS registrations_phone_idx;              -- → registrations_phone_live_idx (every phone query skips deleted rows)
DROP INDEX IF EXISTS registrations_phone_active_idx;       -- → registrations_phone_live_idx
DROP INDEX IF EXISTS registrations_district_idx;           -- → registrations_district_status_idx
DROP INDEX IF EXISTS registrations_fort_idx;               -- → registrations_fort_status_idx
DROP INDEX IF EXISTS registrations_status_idx;             -- → registrations_status_sort_idx
DROP INDEX IF EXISTS audit_logs_created_idx;               -- the audit list sorts "When" by id
DROP INDEX IF EXISTS audit_logs_action_text_idx;           -- the action filter is equality → audit_logs_action_sort_idx
DROP INDEX IF EXISTS sms_messages_created_idx;             -- SMS history is read per registration
