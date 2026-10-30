-- Amrut Durgotsav 2026 — migration 031
-- Indexes for the admin tables' column-header sorting, so a sorted page reads off an index and stops at LIMIT
-- instead of sorting every row. The other sorts already have one (primary keys, unique columns, migrations 001 / 006).
-- This file runs inside migrate.js's BEGIN/COMMIT transaction (no CONCURRENTLY).
-- On a live database that already has many rows and active traffic, run instead:
--
--   node scripts/create-indexes-live.js
--
-- It creates the identical indexes CONCURRENTLY. IF NOT EXISTS makes both paths safe in any order.

-- Registrations by participant name (also the certificates list by name, via the join)
CREATE INDEX IF NOT EXISTS registrations_name_sort_idx
  ON registrations (name, id)
  WHERE deleted_at IS NULL;

-- Registrations by status, oldest / newest first within each status (one direction for all three columns)
CREATE INDEX IF NOT EXISTS registrations_status_sort_idx
  ON registrations (status, created_at, id)
  WHERE deleted_at IS NULL;

-- Audit log by action / record type (the action text_pattern_ops index serves prefix filters, not ORDER BY)
CREATE INDEX IF NOT EXISTS audit_logs_action_sort_idx ON audit_logs (action, id);
CREATE INDEX IF NOT EXISTS audit_logs_entity_sort_idx ON audit_logs (entity, id);

ANALYZE registrations;
ANALYZE audit_logs;
