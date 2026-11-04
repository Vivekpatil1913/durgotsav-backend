-- Amrut Durgotsav 2026 — migration 041
-- Two admin lists that would otherwise read a whole table once it is large. The audit log stops browsing at COUNT_CAP
-- entries, so its date filter is how older entries are reached; the enquiries list opens newest first with no status
-- filter, which the (status, created_at) index cannot serve. On a live database deploy.sh builds both CONCURRENTLY first
-- (scripts/create-indexes-live.js).
-- Builds an index only when it is missing. A plain CREATE INDEX IF NOT EXISTS locks its table against writes even when the
-- index exists (PostgreSQL takes the lock before it looks at the name); on a live database the index was
-- built CONCURRENTLY beforehand (scripts/create-indexes-live.js), so this costs no lock at all.
CREATE OR REPLACE FUNCTION pg_temp.create_index_if_missing(index_name text, ddl text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF to_regclass(index_name) IS NULL THEN EXECUTE ddl; END IF;
END $f$;

SELECT pg_temp.create_index_if_missing('audit_logs_created_id_idx', $i$CREATE INDEX audit_logs_created_id_idx ON audit_logs (created_at, id)$i$);
SELECT pg_temp.create_index_if_missing('contact_enquiries_recent_idx', $i$CREATE INDEX contact_enquiries_recent_idx ON contact_enquiries (created_at DESC, id DESC) WHERE deleted_at IS NULL$i$);
