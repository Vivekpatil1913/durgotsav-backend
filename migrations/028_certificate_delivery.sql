-- Amrut Durgotsav 2026 — migration 028
-- दुर्गवीर number on every certificate, and a durable queue + log for emailing certificates.

-- ---------------------------------------------------------------- दुर्गवीर क्र.
-- 1, 2, 3 … in the order certificates are first issued. The column default takes it from the sequence when the
-- certificate row is inserted; nothing updates it afterwards, so revoke / reinstate / re-verify keep the number.
-- UNIQUE makes a repeated number impossible even if the sequence were ever reset by hand.
CREATE SEQUENCE certificates_durgveer_no_seq AS INTEGER;
ALTER TABLE certificates ADD COLUMN durgveer_no INTEGER;

WITH ordered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY issued_at, id) AS n FROM certificates)
UPDATE certificates c SET durgveer_no = o.n FROM ordered o WHERE c.id = o.id;

SELECT setval('certificates_durgveer_no_seq', COALESCE(MAX(durgveer_no), 0) + 1, false) FROM certificates;
ALTER SEQUENCE certificates_durgveer_no_seq OWNED BY certificates.durgveer_no;
ALTER TABLE certificates
  ALTER COLUMN durgveer_no SET DEFAULT nextval('certificates_durgveer_no_seq'),
  ALTER COLUMN durgveer_no SET NOT NULL,
  ADD CONSTRAINT certificates_durgveer_no_key UNIQUE (durgveer_no);

-- ---------------------------------------------------------------- email queue
-- One row per certificate (UNIQUE), so the certificate email can never be queued twice. Rows are written in the
-- same transaction that verifies the registration; the worker claims due rows with FOR UPDATE SKIP LOCKED, so
-- several workers never take the same row.
--   queued → processing → sent
--                       → queued again (retry with backoff) → … → failed (attempts used up / permanent error)
--   skipped:   no usable email address      cancelled: certificate revoked or registration no longer verified
CREATE TABLE certificate_email_jobs (
  id               BIGSERIAL PRIMARY KEY,
  certificate_id   INTEGER NOT NULL UNIQUE REFERENCES certificates (id) ON DELETE CASCADE,
  status           VARCHAR(12) NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'skipped', 'cancelled')),
  -- verify: automatic on verification; pending: "Email pending" backfill; resend: an admin asked for another copy
  reason           VARCHAR(12) NOT NULL DEFAULT 'verify' CHECK (reason IN ('verify', 'pending', 'resend', 'retry')),
  -- when this delivery was asked for: a certificate emailed after this moment needs no further email
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_by     INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  attempts         SMALLINT NOT NULL DEFAULT 0,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- lease: a worker that dies mid-job leaves the row 'processing'; it is retried once the lease has expired
  locked_at        TIMESTAMPTZ,
  locked_by        VARCHAR(100),
  recipient        VARCHAR(160),
  last_error_code  VARCHAR(40),
  last_error       VARCHAR(500),
  sent_at          TIMESTAMPTZ,
  sent_count       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX certificate_email_jobs_due_idx    ON certificate_email_jobs (run_at, id) WHERE status = 'queued';
CREATE INDEX certificate_email_jobs_lease_idx  ON certificate_email_jobs (locked_at) WHERE status = 'processing';
CREATE INDEX certificate_email_jobs_status_idx ON certificate_email_jobs (status);

-- Every attempt, with what was actually put on the certificate (number, photo, PDF hash) and what SMTP answered.
CREATE TABLE certificate_email_log (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT NOT NULL REFERENCES certificate_email_jobs (id) ON DELETE CASCADE,
  certificate_id  INTEGER NOT NULL REFERENCES certificates (id) ON DELETE CASCADE,
  attempt         SMALLINT NOT NULL,
  outcome         VARCHAR(12) NOT NULL CHECK (outcome IN ('sent', 'retry', 'failed', 'skipped', 'cancelled', 'requeued')),
  recipient       VARCHAR(160),
  certificate_no  VARCHAR(40),
  durgveer_no     INTEGER,
  photo_id        INTEGER,
  pdf_bytes       INTEGER,
  pdf_sha256      CHAR(64),
  render_ms       INTEGER,
  send_ms         INTEGER,
  message_id      VARCHAR(255),
  smtp_response   VARCHAR(300),
  error_code      VARCHAR(40),
  error           VARCHAR(500),
  worker          VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX certificate_email_log_cert_idx    ON certificate_email_log (certificate_id, id DESC);
CREATE INDEX certificate_email_log_created_idx ON certificate_email_log (created_at DESC);
