-- Amrut Durgotsav 2026 — migration 035
-- 1. Certificates are generated only when an admin approves a registration (review "verify"), no longer at submission.
-- 2. No limit on registrations per mobile number (nothing to store: migration 033 only added an index for it).
-- 3. SMS go through a durable queue (sms_messages), sent by background workers like the certificate emails.

-- ---------------------------------------------------------------- certificates of unapproved registrations
-- Registrations that received a certificate at submission (migration 033's rule) and are not approved: withdraw it.
-- Approving the registration reinstates the same certificate with the same दुर्गवीर number (issueBatch). Emails not yet
-- sent for them are cancelled; one already sent cannot be recalled, and its certificate no longer verifies.
UPDATE certificate_email_jobs j
SET status = 'cancelled', last_error_code = 'NOT_VERIFIED', last_error = NULL, updated_at = NOW()
FROM certificates c
JOIN registrations r ON r.id = c.registration_id
WHERE j.certificate_id = c.id AND j.status = 'queued' AND r.status <> 'verified';

UPDATE certificates c
SET revoked_at = NOW(), revoke_reason = 'Awaiting admin verification'
FROM registrations r
WHERE r.id = c.registration_id AND c.revoked_at IS NULL AND r.status <> 'verified';

-- Certificate numbers are compared as stored (the verification looks them up through the UNIQUE index): keep them upper-case
UPDATE certificates SET certificate_no = UPPER(certificate_no) WHERE certificate_no <> UPPER(certificate_no);

-- ---------------------------------------------------------------- SMS queue
--   queued → processing → sent | logged (no gateway configured) | failed (attempts used up)
--   cancelled: no longer applies (registration deleted, certificate withdrawn before it went out)
--   purpose registration_ack: right after a registration; certificate_link: when an admin approves it
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_purpose_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_purpose_check CHECK (purpose IN ('registration_ack', 'certificate_link'));
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check
  CHECK (status IN ('queued', 'processing', 'sent', 'logged', 'failed', 'cancelled'));
-- set once the gateway has been tried
ALTER TABLE sms_messages ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS attempts   SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- lease: a worker that dies mid-send leaves the row 'processing'; it is retried once the lease has expired
  ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Claiming due messages and recovering expired leases read only the (small) unfinished part of the table
CREATE INDEX IF NOT EXISTS sms_messages_due_idx   ON sms_messages (run_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS sms_messages_lease_idx ON sms_messages (locked_at) WHERE status = 'processing';
