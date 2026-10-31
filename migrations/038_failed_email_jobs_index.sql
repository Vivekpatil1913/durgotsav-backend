-- Amrut Durgotsav 2026 — migration 038
-- "Retry failed" (Admin → Certificates) walks the failed certificate emails in id order, 5,000 at a time. Failed jobs are
-- a small part of the queue: this index holds only them, so each batch reads one short range instead of every failed
-- job through the status index plus a sort. On a live database deploy.sh builds it CONCURRENTLY first
-- (scripts/create-indexes-live.js).
CREATE INDEX IF NOT EXISTS certificate_email_jobs_failed_idx ON certificate_email_jobs (id) WHERE status = 'failed';
