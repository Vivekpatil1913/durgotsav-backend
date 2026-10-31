-- Amrut Durgotsav 2026 — migration 037
-- Rejection emails (the admin's reason and a link to register again) go through a durable queue, like SMS (migration
-- 035) and certificate emails: a row is written in the same transaction as the rejection and the background worker sends
-- it with retries. A bulk rejection no longer sends mail from inside the admin's request, and no notice is lost when a
-- process restarts or the mail server is briefly unreachable.
--   queued → processing → sent | failed (attempts used up), or cancelled when it no longer applies (the registration was
--   approved / reset again, deleted, or has no email address left)
CREATE TABLE IF NOT EXISTS registration_emails (
  id               BIGSERIAL PRIMARY KEY,
  registration_id  INTEGER NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
  kind             VARCHAR(20) NOT NULL DEFAULT 'rejection' CHECK (kind IN ('rejection')),
  status           VARCHAR(12) NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'cancelled')),
  attempts         SMALLINT NOT NULL DEFAULT 0,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at        TIMESTAMPTZ,
  locked_by        VARCHAR(100),
  error            VARCHAR(300),
  requested_by     INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The worker's claim (due messages, oldest first) and its lease check read only the small unfinished part
CREATE INDEX IF NOT EXISTS registration_emails_due_idx ON registration_emails (run_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS registration_emails_lease_idx ON registration_emails (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS registration_emails_registration_idx ON registration_emails (registration_id, id DESC);
