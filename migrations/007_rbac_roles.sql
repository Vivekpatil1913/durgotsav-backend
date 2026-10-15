-- Amrut Durgotsav 2026 — migration 007
-- Adds a proper roles table with JSONB permissions and links admins to it.
-- Follows the Sumago RBAC pattern: roles are rows, not code constants;
-- permissions are re-read from DB on every request via the roles JOIN in authenticate.

-- ---------------------------------------------------------------- roles table
CREATE TABLE roles (
  id          SERIAL      PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(80)  NOT NULL UNIQUE,
  description TEXT,
  -- Map of { module_key: { read, write, delete } }. A missing key = NO access.
  -- is_admin = true bypasses this map entirely (equivalent to super_admin).
  permissions JSONB        NOT NULL DEFAULT '{}',
  is_admin    BOOLEAN      NOT NULL DEFAULT false,
  is_system   BOOLEAN      NOT NULL DEFAULT false,  -- built-in, cannot be deleted
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_roles_active ON roles(sort_order) WHERE deleted_at IS NULL;

CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- seed built-in roles
INSERT INTO roles (name, slug, description, permissions, is_admin, is_system, sort_order) VALUES

-- Super Admin: full access; is_admin bypasses permission checks
(
  'Super Admin',
  'super_admin',
  'Full system access — bypasses all permission checks.',
  '{}',
  true,
  true,
  1
),

-- Admin: all content + geography + user management
(
  'Admin',
  'admin',
  'Manages content, users, geography, settings and registrations.',
  '{
    "dashboard":          {"read": true},
    "registrations":      {"read": true, "write": true, "delete": true},
    "registrations_photos": {"read": true},
    "moderation":         {"read": true, "write": true},
    "certificates":       {"read": true, "write": true},
    "reports":            {"read": true, "write": true},
    "geography":          {"read": true, "write": true, "delete": true},
    "forts":              {"read": true, "write": true, "delete": true},
    "content":            {"read": true, "write": true, "delete": true},
    "users":              {"read": true, "write": true, "delete": true},
    "roles":              {"read": true, "write": true},
    "settings":           {"read": true, "write": true},
    "audit_logs":         {"read": true}
  }',
  false,
  true,
  2
),

-- Moderator: photo review + registration management only
(
  'Moderator',
  'moderator',
  'Reviews photos and manages registration status.',
  '{
    "dashboard":            {"read": true},
    "registrations":        {"read": true, "write": true},
    "registrations_photos": {"read": true},
    "moderation":           {"read": true, "write": true},
    "certificates":         {"read": true}
  }',
  false,
  true,
  3
);

-- ---------------------------------------------------------------- link admins → roles
-- Add nullable role_id first so we can backfill before adding NOT NULL.
ALTER TABLE admins ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT;

-- Backfill role_id from the existing hardcoded role slug column.
UPDATE admins a
SET    role_id = r.id
FROM   roles r
WHERE  r.slug = a.role;

-- Now all rows have a role_id; make it mandatory.
ALTER TABLE admins ALTER COLUMN role_id SET NOT NULL;

-- Drop the old CHECK constraint so future custom role slugs are not rejected.
-- The role column is kept for backward compatibility and JWT payload use.
ALTER TABLE admins DROP CONSTRAINT admins_role_check;

CREATE INDEX idx_admins_role_id ON admins(role_id);
