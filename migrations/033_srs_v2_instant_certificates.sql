-- Amrut Durgotsav 2026 — migration 033
-- SRS v2.1: single-page registration form, certificate issued instantly on submission, up to 4 registrations per
-- mobile number, mobile-number certificate lookup, SMS with the certificate link, admin certificate regeneration.

-- ---------------------------------------------------------------- registrations
-- The form no longer asks "participating as": one name field says "पूर्ण नाव / संस्था / कुटुंब / सोसायटी".
-- New registrations leave participant_type NULL (not asked); earlier ones keep their type. division_id (derived from
-- the district, used for admin division scope), taluka_id, fort_id and replica_notes stay for earlier registrations.
ALTER TABLE registrations ALTER COLUMN participant_type DROP NOT NULL;

-- Mobile-number lookup and the 4-per-mobile check read a mobile number's live registrations
CREATE INDEX IF NOT EXISTS registrations_phone_live_idx ON registrations (phone, id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- certificates
-- Issued by the system at submission (issued_by NULL). An admin may regenerate one, e.g. after correcting the name.
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS regenerated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS regenerated_by INTEGER REFERENCES admins (id) ON DELETE SET NULL;

-- 'register': the certificate email queued at submission
ALTER TABLE certificate_email_jobs DROP CONSTRAINT IF EXISTS certificate_email_jobs_reason_check;
ALTER TABLE certificate_email_jobs ADD CONSTRAINT certificate_email_jobs_reason_check
  CHECK (reason IN ('register', 'verify', 'pending', 'resend', 'retry'));

-- ---------------------------------------------------------------- SMS log
-- Every SMS with a certificate link: the automatic one at submission and any an admin sends by hand.
--   sent: the gateway accepted it   logged: no gateway configured (SMS_DRIVER=log)   failed: the gateway refused / was unreachable
CREATE TABLE IF NOT EXISTS sms_messages (
  id               BIGSERIAL PRIMARY KEY,
  registration_id  INTEGER NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
  phone            VARCHAR(10) NOT NULL,
  purpose          VARCHAR(20) NOT NULL DEFAULT 'certificate_link' CHECK (purpose IN ('certificate_link')),
  message          VARCHAR(500) NOT NULL,
  status           VARCHAR(10) NOT NULL CHECK (status IN ('sent', 'logged', 'failed')),
  provider         VARCHAR(20) NOT NULL,
  response         VARCHAR(500),
  error            VARCHAR(300),
  -- NULL: sent automatically at submission
  requested_by     INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sms_messages_registration_idx ON sms_messages (registration_id, id DESC);
