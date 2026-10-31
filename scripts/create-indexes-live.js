/**
 * create-indexes-live.js
 *
 * Creates production-scale indexes CONCURRENTLY so no table is locked and
 * live traffic is not interrupted. Use this on a database that already has
 * data and active connections.
 *
 * Safe to re-run: IF NOT EXISTS skips indexes that already exist, and an index left INVALID by an interrupted
 * build is dropped and built again. Each statement runs outside any transaction (required for CONCURRENTLY), on one
 * dedicated connection with no statement timeout (a build over millions of rows takes minutes; the API pool's 60 s limit
 * would cancel it). deploy.sh runs it BEFORE migrate.js, so the migrations' plain CREATE INDEX IF NOT EXISTS (which
 * block writes while they build) find every large index already there. A step whose table or column a pending
 * migration has yet to create is skipped; that migration builds it (on a new, small table).
 *
 * Usage:
 *   node scripts/create-indexes-live.js
 */

import pg from "pg";
import { EDITION_YEAR } from "../src/config/edition.js";
import { dbConfig } from "../src/db/pool.js";

const STEPS = [
  {
    label: "pg_trgm extension",
    sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    transaction: true, // extensions CAN run inside a transaction
  },
  {
    label: "registrations_name_trgm (GIN — name ILIKE search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_name_trgm
          ON registrations USING GIN (name gin_trgm_ops)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_email_trgm (GIN — email ILIKE search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_email_trgm
          ON registrations USING GIN (email gin_trgm_ops)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_org_trgm (GIN — organisation ILIKE search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_org_trgm
          ON registrations USING GIN (organization_name gin_trgm_ops)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_district_status_idx (district + status filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_district_status_idx
          ON registrations (district_id, status, created_at DESC, id DESC)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_fort_status_idx (fort + status filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_fort_status_idx
          ON registrations (fort_id, status, created_at DESC, id DESC)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_pending_oldest_idx (moderation queue — pending, oldest first)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_pending_oldest_idx
          ON registrations (created_at ASC, id ASC)
          WHERE deleted_at IS NULL AND status = 'pending'`,
  },
  {
    label: "registrations_verified_created_idx (verified listing)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_verified_created_idx
          ON registrations (created_at DESC, id DESC)
          WHERE deleted_at IS NULL AND status = 'verified'`,
  },
  {
    label: "certificates_cert_no_trgm (GIN — certificate number search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS certificates_cert_no_trgm
          ON certificates USING GIN (certificate_no gin_trgm_ops)`,
  },
  {
    label: "certificates_pending_email_idx (pending email filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS certificates_pending_email_idx
          ON certificates (registration_id)
          WHERE revoked_at IS NULL AND emailed_at IS NULL`,
  },
  // अमृत शिवदुर्ग भूषण पुरस्कार nominations — mirrors migrations/017_award_scale_indexes.sql
  ...[
    ["award_nominations_name_trgm", "award_nominations USING GIN (nominee_name gin_trgm_ops)", "nominee search"],
    ["award_nominations_email_trgm", "award_nominations USING GIN (email gin_trgm_ops)", "email search"],
    ["award_nominations_ref_trgm", "award_nominations USING GIN (reference_no gin_trgm_ops)", "reference search"],
    ["award_nominations_mobile_trgm", "award_nominations USING GIN (mobile gin_trgm_ops)", "mobile search"],
    ["award_nominators_name_trgm", "award_nominators USING GIN (full_name gin_trgm_ops)", "nominator search"],
    ["award_nominators_mobile_trgm", "award_nominators USING GIN (mobile gin_trgm_ops)", "nominator mobile search"],
    ["award_nominations_ref_upper_idx", "award_nominations (upper(reference_no))", "public status lookup"],
    ["award_nominations_list_idx", "award_nominations (edition_id, submitted_at DESC, id DESC)", "list, newest first"],
    ["award_nominations_status_idx", "award_nominations (edition_id, status, submitted_at DESC, id DESC)", "status filter"],
    ["award_nominations_category_idx", "award_nominations (edition_id, category, submitted_at DESC, id DESC)", "category filter"],
    ["award_nominations_district_idx", "award_nominations (edition_id, district_id, submitted_at DESC, id DESC)", "district filter"],
    ["award_nominations_taluka_idx", "award_nominations (edition_id, taluka_id, submitted_at DESC, id DESC)", "taluka filter"],
    ["award_nominations_name_idx", "award_nominations (edition_id, nominee_name, id)", "sort by name"],
    ["award_nominations_edition_id_idx", "award_nominations (edition_id, id)", "sort by reference"],
  ].map(([name, on, what]) => ({
    label: `${name} (award — ${what})`,
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${on}`,
  })),
  ...["idx_award_nominations_list", "idx_award_nominations_status", "idx_award_nominations_category"].map((name) => ({
    label: `drop ${name} (superseded)`,
    sql: `DROP INDEX CONCURRENTLY IF EXISTS ${name}`,
  })),
  // Public gallery / photo album — mirrors migrations/030_gallery_scale_indexes.sql
  {
    label: "registration_photos_gallery_idx (gallery — selected photos, newest first)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_gallery_idx
          ON registration_photos (id DESC) INCLUDE (registration_id)
          WHERE is_current AND position = 1 AND is_featured`,
  },
  {
    label: "registrations_verified_geo_idx (gallery — verified + district/fort filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_verified_geo_idx
          ON registrations (id) INCLUDE (district_id, fort_id)
          WHERE status = 'verified' AND deleted_at IS NULL`,
  },
  {
    label: "registrations_verified_district_fort_idx (gallery — district / district + fort)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_verified_district_fort_idx
          ON registrations (district_id, fort_id, id)
          WHERE status = 'verified' AND deleted_at IS NULL`,
  },
  {
    label: "registrations_verified_fort_idx (gallery — fort filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_verified_fort_idx
          ON registrations (fort_id, id)
          WHERE status = 'verified' AND deleted_at IS NULL`,
  },
  {
    label: "registration_photos_selected_reg_idx (gallery — registration → selected photo)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_selected_reg_idx
          ON registration_photos (registration_id) INCLUDE (id)
          WHERE is_current AND position = 1 AND is_featured`,
  },
  // Admin column-header sorting — mirrors migrations/031_admin_sort_indexes.sql
  {
    label: "registrations_name_sort_idx (admin — sort by name)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_name_sort_idx
          ON registrations (name, id)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_status_sort_idx (admin — sort by status)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_status_sort_idx
          ON registrations (status, created_at, id)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "audit_logs_action_sort_idx (audit log — sort by action)",
    sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_action_sort_idx ON audit_logs (action, id)",
  },
  {
    label: "audit_logs_entity_sort_idx (audit log — sort by record type)",
    sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_entity_sort_idx ON audit_logs (entity, id)",
  },
  // SRS v2.1 mobile lookup and SMS queue — mirrors migrations/033 and 035
  {
    label: "registrations_phone_live_idx (mobile lookup, same-mobile list)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_phone_live_idx
          ON registrations (phone, id) WHERE deleted_at IS NULL`,
  },
  {
    label: "sms_messages_due_idx (SMS queue — due messages)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_due_idx
          ON sms_messages (run_at, id) WHERE status = 'queued'`,
  },
  {
    label: "sms_messages_lease_idx (SMS queue — expired leases)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_messages_lease_idx
          ON sms_messages (locked_at) WHERE status = 'processing'`,
  },
  // Millions of registrations — mirrors migrations/036_scale_millions.sql (its DROP INDEX statements run in the migration)
  {
    label: "dhash_band_keys() (near-duplicate band keys)",
    sql: `CREATE OR REPLACE FUNCTION dhash_band_keys(hash bpchar) RETURNS integer[]
          LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
          SELECT CASE WHEN hash ~* '^[0-9a-f]{16}$' THEN ARRAY[
                       ('x' || substr(hash, 1, 4))::bit(16)::int,
               65536 + ('x' || substr(hash, 5, 4))::bit(16)::int,
              131072 + ('x' || substr(hash, 9, 4))::bit(16)::int,
              196608 + ('x' || substr(hash, 13, 4))::bit(16)::int]
          END $$`,
  },
  {
    label: "registration_photos_dhash_keys_gin (near-duplicate photo probes)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_dhash_keys_gin
          ON registration_photos USING GIN (dhash_band_keys(dhash))`,
  },
  {
    label: "registration_photos_registration_idx (all photos of a registration)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_registration_idx
          ON registration_photos (registration_id, photo_no)`,
  },
  {
    label: "registration_photos_dup_main_idx (moderation — possible duplicates)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_dup_main_idx
          ON registration_photos (registration_id)
          WHERE is_current AND position = 1 AND duplicate_of_photo_id IS NOT NULL`,
  },
  {
    label: "registration_photos_storage_key_pattern_uq (S3 numbering by folder)",
    sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS registration_photos_storage_key_pattern_uq
          ON registration_photos (storage_key text_pattern_ops) INCLUDE (photo_no) WHERE storage_key IS NOT NULL`,
  },
  {
    label: "registrations_phone_trgm (GIN — mobile number search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_phone_trgm
          ON registrations USING GIN (phone gin_trgm_ops) WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_whatsapp_trgm (GIN — WhatsApp number search)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_whatsapp_trgm
          ON registrations USING GIN (whatsapp_number gin_trgm_ops) WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_div_status_created_idx (division-scoped queues)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_div_status_created_idx
          ON registrations (division_id, status, created_at, id) WHERE deleted_at IS NULL`,
  },
  {
    label: "registrations_trash_idx (deleted registrations)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_trash_idx
          ON registrations (created_at, id) WHERE deleted_at IS NOT NULL`,
  },
  {
    label: "certificates_revoked_issued_idx (certificates — revoked filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS certificates_revoked_issued_idx
          ON certificates (issued_at DESC, id DESC) WHERE revoked_at IS NOT NULL`,
  },
  {
    label: "certificate_email_log_job_idx (email log → job)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS certificate_email_log_job_idx ON certificate_email_log (job_id)`,
  },
  {
    label: "audit_logs_admin_idx (audit log — by admin)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_admin_idx ON audit_logs (admin_id, id)`,
  },
];

const ANALYZE = [
  "ANALYZE registrations",
  "ANALYZE registration_photos",
  "ANALYZE certificates",
  "ANALYZE audit_logs",
  "ANALYZE award_nominations",
  "ANALYZE award_nominators",
];

const pad = (s, n) => s.padEnd(n, " ");
const tick = "✓";
const cross = "✗";

async function run() {
  console.log(`\n=== Durgotsav ${EDITION_YEAR} — Live Index Creation ===\n`);
  console.log("Connecting to database...");

  // One dedicated connection: no statement timeout (builds take minutes on millions of rows) and no lock timeout
  // (CONCURRENTLY waits for transactions already running on the table, then builds without blocking anyone).
  const client = new pg.Client({ ...dbConfig(), application_name: "durgotsav-create-indexes" });
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET lock_timeout = 0");
  const { rows } = await client.query("SELECT current_database() AS db, version() AS ver");
  console.log(`Connected: ${rows[0].db}\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const step of STEPS) {
    process.stdout.write(`  ${pad(step.label, 62)}`);
    const t = Date.now();
    try {
      // A cancelled or failed CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS would skip forever
      const name = step.sql.match(/IF NOT EXISTS (\w+)/)?.[1];
      if (name) {
        const invalid = await client.query(
          "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid", [name]);
        if (invalid.rowCount) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      }
      // CONCURRENTLY must run outside a transaction block; this connection never opens one.
      await client.query(step.sql);
      const ms = Date.now() - t;
      console.log(`${tick}  ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
      ok++;
    } catch (err) {
      // "already exists" should be caught by IF NOT EXISTS, but guard anyway
      if (err.code === "42P07") {
        console.log("(already exists — skipped)");
        skipped++;
      } else if (err.code === "42P01" || err.code === "42703" || err.code === "42883") {
        // undefined table / column / function: a pending migration creates it, together with this index
        console.log("(not in this database yet — the migration builds it)");
        skipped++;
      } else {
        console.log(`${cross}  FAILED: ${err.message}`);
        failed++;
        // Continue with remaining indexes; one failure is not fatal
      }
    }
  }

  console.log("\n  Running ANALYZE on affected tables...");
  for (const sql of ANALYZE) {
    await client.query(sql).catch((err) => console.error(`  ANALYZE failed: ${err.message}`));
  }

  console.log(`\n=== Done: ${ok} created, ${skipped} skipped, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error("One or more indexes failed to create. Check the output above.");
    process.exitCode = 1;
  }

  await client.end();
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
