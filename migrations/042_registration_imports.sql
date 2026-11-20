-- Amrut Durgotsav 2026 — migration 042
-- Bulk registration import (Admin → Registrations → Import Excel): an admin uploads an .xlsx / .csv sheet (Full Name,
-- Mobile Number, District, Photo URL or Photo File Name) and optionally a .zip of photos. Every valid row becomes an
-- approved ("verified") registration with its certificate, exactly as if an admin had approved it after review.

-- 'import': registrations created by a bulk import
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_source_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_source_check
  CHECK (source IN ('web', 'legacy', 'admin', 'import'));

-- One uploaded sheet. Rows are processed in batches in the background by the API process that received the upload;
-- the counters move after every batch, so the admin panel can show progress.
CREATE TABLE IF NOT EXISTS registration_imports (
  id              SERIAL PRIMARY KEY,
  status          VARCHAR(12) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  file_name       VARCHAR(255) NOT NULL,
  zip_name        VARCHAR(255),
  send_sms        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Data rows found in the sheet (the header row not counted); known once the sheet has been read through
  total_rows      INTEGER NOT NULL DEFAULT 0,
  processed_rows  INTEGER NOT NULL DEFAULT 0,
  imported_rows   INTEGER NOT NULL DEFAULT 0,
  failed_rows     INTEGER NOT NULL DEFAULT 0,
  -- Why the whole import stopped (unreadable file, missing columns, server restart)
  error           VARCHAR(500),
  created_by      INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  -- Moves after every batch: a 'processing' import whose heartbeat stopped was cut off by a restart
  heartbeat_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS registration_imports_created_idx ON registration_imports (id DESC);

-- Rows that were not imported, with the reason (row_no = the row number in the sheet, header = row 1)
CREATE TABLE IF NOT EXISTS registration_import_errors (
  id         BIGSERIAL PRIMARY KEY,
  import_id  INTEGER NOT NULL REFERENCES registration_imports (id) ON DELETE CASCADE,
  row_no     INTEGER NOT NULL,
  name       VARCHAR(200),
  phone      VARCHAR(40),
  district   VARCHAR(120),
  reason     VARCHAR(300) NOT NULL
);
CREATE INDEX IF NOT EXISTS registration_import_errors_import_idx ON registration_import_errors (import_id, row_no);

-- The import that created a registration (results download). Nullable, no default and no foreign key: adding it is
-- instant on a table of millions of rows. The partial index holds only imported rows.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS import_id INTEGER;
CREATE INDEX IF NOT EXISTS registrations_import_idx ON registrations (import_id, id) WHERE import_id IS NOT NULL;
