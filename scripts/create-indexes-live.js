/**
 * create-indexes-live.js
 *
 * Creates production-scale indexes CONCURRENTLY so no table is locked and
 * live traffic is not interrupted. Use this on a database that already has
 * data and active connections.
 *
 * Safe to re-run: IF NOT EXISTS skips indexes that already exist.
 * Each statement runs outside any transaction (required for CONCURRENTLY).
 *
 * Usage:
 *   node scripts/create-indexes-live.js
 */

import { pool } from "../src/db/pool.js";

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
    label: "registrations_phone_active_idx (same-phone duplicate lookup)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS registrations_phone_active_idx
          ON registrations (phone)
          WHERE deleted_at IS NULL`,
  },
  {
    label: "reg_photos_current_dup_idx (moderation count — current + duplicate join)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS reg_photos_current_dup_idx
          ON registration_photos (registration_id, duplicate_of_photo_id)
          WHERE is_current = TRUE`,
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
  {
    label: "audit_logs_action_text_idx (audit log action filter)",
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_action_text_idx
          ON audit_logs (action text_pattern_ops)`,
  },
];

const ANALYZE = [
  "ANALYZE registrations",
  "ANALYZE registration_photos",
  "ANALYZE certificates",
  "ANALYZE audit_logs",
];

const pad = (s, n) => s.padEnd(n, " ");
const tick = "✓";
const cross = "✗";

async function run() {
  console.log("\n=== Durgotsav 2026 — Live Index Creation ===\n");
  console.log("Connecting to database...");

  // Verify connection
  const { rows } = await pool.query("SELECT current_database() AS db, version() AS ver");
  console.log(`Connected: ${rows[0].db}\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const step of STEPS) {
    process.stdout.write(`  ${pad(step.label, 62)}`);
    const t = Date.now();
    try {
      // CONCURRENTLY must run outside a transaction block.
      // pool.query() uses a fresh connection that has no open transaction.
      await pool.query(step.sql);
      const ms = Date.now() - t;
      console.log(`${tick}  ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
      ok++;
    } catch (err) {
      // "already exists" should be caught by IF NOT EXISTS, but guard anyway
      if (err.code === "42P07") {
        console.log("(already exists — skipped)");
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
    await pool.query(sql).catch((err) => console.error(`  ANALYZE failed: ${err.message}`));
  }

  console.log(`\n=== Done: ${ok} created, ${skipped} skipped, ${failed} failed ===\n`);

  if (failed > 0) {
    console.error("One or more indexes failed to create. Check the output above.");
    process.exitCode = 1;
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
