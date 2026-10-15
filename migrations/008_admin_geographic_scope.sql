-- Amrut Durgotsav 2026 — migration 008
-- Division/district access grants for admin users + denormalized division_id
-- on registrations for efficient scope-filtered queries.

-- ---------------------------------------------------------------- admin_divisions
-- Each row grants an admin access to one division.
-- Admins with is_admin=true on their role bypass this table entirely.
-- No rows for an admin (with a non-admin role) = no division access.
CREATE TABLE admin_divisions (
  id          SERIAL    PRIMARY KEY,
  admin_id    INTEGER   NOT NULL REFERENCES admins(id)    ON DELETE CASCADE,
  division_id SMALLINT  NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  granted_by  INTEGER            REFERENCES admins(id)    ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admin_id, division_id)
);
CREATE INDEX idx_admin_divisions_admin ON admin_divisions(admin_id);

-- ---------------------------------------------------------------- admin_districts
-- Optional finer-grained district access (used when division-level is too broad).
-- When this table has rows for an admin, only those districts are visible —
-- even within a division the admin is granted.
CREATE TABLE admin_districts (
  id          SERIAL    PRIMARY KEY,
  admin_id    INTEGER   NOT NULL REFERENCES admins(id)    ON DELETE CASCADE,
  district_id SMALLINT  NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  granted_by  INTEGER            REFERENCES admins(id)    ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (admin_id, district_id)
);
CREATE INDEX idx_admin_districts_admin ON admin_districts(admin_id);

-- ---------------------------------------------------------------- registrations.division_id
-- Denormalized for efficient scope queries. Maintained by the application on INSERT.
ALTER TABLE registrations ADD COLUMN division_id SMALLINT REFERENCES divisions(id);

-- Backfill from the existing district→division hierarchy
UPDATE registrations r
SET    division_id = d.division_id
FROM   districts d
WHERE  d.id = r.district_id;

-- Composite indexes tuned to the division-scoped admin queries
CREATE INDEX idx_registrations_division_id      ON registrations(division_id);
CREATE INDEX idx_registrations_div_status       ON registrations(division_id, status)       WHERE deleted_at IS NULL;
CREATE INDEX idx_registrations_div_created      ON registrations(division_id, created_at DESC) WHERE deleted_at IS NULL;
