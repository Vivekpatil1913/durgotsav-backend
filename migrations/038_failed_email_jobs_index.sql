-- Amrut Durgotsav 2026 — migration 038
-- "Retry failed" (Admin → Certificates) walks the failed certificate emails in id order, 5,000 at a time. Failed jobs are
-- a small part of the queue: this index holds only them, so each batch reads one short range instead of every failed
-- job through the status index plus a sort. On a live database deploy.sh builds it CONCURRENTLY first
-- (scripts/create-indexes-live.js).
-- Builds an index only when it is missing. A plain CREATE INDEX IF NOT EXISTS locks its table against writes even when the
-- index exists (PostgreSQL takes the lock before it looks at the name); on a live database the index was
-- built CONCURRENTLY beforehand (scripts/create-indexes-live.js), so this costs no lock at all.
CREATE OR REPLACE FUNCTION pg_temp.create_index_if_missing(index_name text, ddl text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF to_regclass(index_name) IS NULL THEN EXECUTE ddl; END IF;
END $f$;

SELECT pg_temp.create_index_if_missing('certificate_email_jobs_failed_idx', $i$CREATE INDEX certificate_email_jobs_failed_idx ON certificate_email_jobs (id) WHERE status = 'failed'$i$);
