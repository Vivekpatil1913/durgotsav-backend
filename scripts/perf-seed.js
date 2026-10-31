// Fills a THROW-AWAY database with millions of synthetic registrations, photos, certificates, email jobs, SMS and audit
// rows, to measure the API at production scale (npm run perf:seed). It refuses any database whose name does not end in
// "_load", so it can never touch real data:
//
//   npm run db:create / db:migrate / db:seed with DB_NAME=durgotsav_2026_load, then
//   DB_NAME=durgotsav_2026_load node scripts/perf-seed.js 2000000
//
// Shape: 60 % verified (with certificate + email job + 2 SMS), 30 % pending, 5 % rejected, 3 % duplicate, 2 % info
// requested; a third have an email; 5 % of all rows belong to 50 "busy" mobile numbers (a school registering thousands
// of replicas from one phone); created over the last 30 days. Secondary indexes are dropped during the load and
// rebuilt afterwards (much faster than maintaining them row by row), then everything is VACUUM ANALYZEd.
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";

const TOTAL = Number(process.argv[2] ?? 2_000_000);
const CHUNK = 200_000;
const PHOTO = "/uploads/registrations/2026-10/muwmds93-5a219b3bbea3.webp"; // any real file: downloads render it
const THUMB = "/uploads/registrations/2026-10/muwmds93-5a219b3bbea3_t.webp";
const TABLES = ["registrations", "registration_photos", "certificates", "certificate_email_jobs", "sms_messages", "audit_logs"];

if (!/_load$/.test(env.DB_NAME)) {
  console.error(`Refusing to fill "${env.DB_NAME}": perf-seed only writes to a database whose name ends in _load.`);
  process.exit(1);
}

const client = await pool.connect();
const run = async (label, sql, params) => {
  const started = Date.now();
  const res = await client.query(sql, params);
  console.log(`  ${label}: ${res.rowCount ?? ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return res;
};

try {
  await client.query("SET statement_timeout = 0");
  // No FK / trigger checks during the bulk load (every reference is generated consistent)
  await client.query("SET session_replication_role = replica");

  // Secondary indexes (not the ones behind PRIMARY KEY / UNIQUE constraints): drop now, rebuild after the load
  const { rows: indexes } = await client.query(
    `SELECT i.indexname, i.indexdef FROM pg_indexes i
     WHERE i.schemaname = 'public' AND i.tablename = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = (quote_ident(i.indexname))::regclass)`,
    [TABLES],
  );
  console.log(`Dropping ${indexes.length} secondary indexes for the load`);
  for (const { indexname } of indexes) await client.query(`DROP INDEX IF EXISTS "${indexname}"`);

  const { rows: [{ start }] } = await client.query("SELECT COALESCE(MAX(id), 9999) + 1 AS start FROM registrations");
  console.log(`Generating ${TOTAL.toLocaleString("en-IN")} registrations from id ${start}`);
  for (let from = 0; from < TOTAL; from += CHUNK) {
    const to = Math.min(from + CHUNK, TOTAL) - 1;
    console.log(`Rows ${from.toLocaleString("en-IN")} – ${to.toLocaleString("en-IN")}`);
    await client.query("BEGIN");
    // g: 0-based row number; h: a stable pseudo-random 0..99 per row
    await run("registrations", `
      INSERT INTO registrations (name, phone, email, district_id, division_id, country, status, review_note, reviewed_at, reviewed_by,
                                 created_at, updated_at, consent_at, source, ip_address, user_agent)
      SELECT n.name, n.phone, CASE WHEN g % 3 = 0 THEN 'user' || g || '@example.org' END,
             d.id, d.division_id, 'India', s.status,
             CASE WHEN s.status IN ('rejected', 'duplicate', 'info_requested') THEN 'छायाचित्र स्पष्ट नाही' END,
             CASE WHEN s.status <> 'pending' THEN t.created_at + INTERVAL '6 hours' END,
             CASE WHEN s.status <> 'pending' THEN 1 END,
             t.created_at, t.created_at, t.created_at, 'web', '10.0.0.1', 'perf-seed'
      FROM generate_series($1::int, $2::int) g
      CROSS JOIN LATERAL (SELECT abs(hashint4(g)) % 100 AS h) x
      CROSS JOIN LATERAL (SELECT CASE WHEN x.h < 60 THEN 'verified' WHEN x.h < 90 THEN 'pending' WHEN x.h < 95 THEN 'rejected'
                                      WHEN x.h < 98 THEN 'duplicate' ELSE 'info_requested' END AS status) s
      CROSS JOIN LATERAL (SELECT NOW() - make_interval(secs => abs(hashint4(g * 7)) % 2592000) AS created_at) t
      CROSS JOIN LATERAL (SELECT
        (ARRAY['राहुल','सुनील','प्रिया','अनिता','संजय','विजय','पूजा','स्नेहा','अमोल','गणेश','सचिन','मनीषा'])[1 + g % 12] || ' ' ||
        (ARRAY['पाटील','जोशी','देशमुख','कुलकर्णी','पवार','शिंदे','जाधव','गायकवाड','मोरे','चव्हाण'])[1 + (g / 12) % 10] || ' ' || g AS name,
        CASE WHEN g % 20 = 0 THEN '98000000' || lpad((g / 20 % 50)::text, 2, '0') ELSE '9' || lpad(g::text, 9, '0') END AS phone) n
      JOIN districts d ON d.id = 1 + g % 36`, [from, to]);
    const range = [Number(start) + from, Number(start) + to];
    await run("photos", `
      INSERT INTO registration_photos (registration_id, image_path, thumb_path, width, height, size_bytes, mime_type, sha256, dhash,
                                       is_current, is_featured, position, storage, created_at)
      SELECT r.id, $3, $4, 1600, 1200, 312000, 'image/webp', md5(r.id::text) || md5((r.id * 31)::text),
             substr(md5((r.id * 17)::text), 1, 16), TRUE, r.status = 'verified' AND r.id % 20 = 0, 1, 'local', r.created_at
      FROM registrations r WHERE r.id BETWEEN $1 AND $2`, [...range, PHOTO, THUMB]);
    await run("certificates", `
      INSERT INTO certificates (registration_id, certificate_no, issued_by, issued_at, emailed_at, sms_sent_at)
      SELECT r.id, 'AMRUT-DGT26-' || lpad(r.id::text, GREATEST(6, length(r.id::text)), '0'), 1, r.reviewed_at,
             CASE WHEN r.email IS NOT NULL AND r.id % 100 <> 0 THEN r.reviewed_at + INTERVAL '5 minutes' END, r.reviewed_at
      FROM registrations r WHERE r.id BETWEEN $1 AND $2 AND r.status = 'verified' ORDER BY r.id`, range);
    await run("email jobs", `
      INSERT INTO certificate_email_jobs (certificate_id, status, reason, attempts, run_at, recipient, sent_at, sent_count, created_at, updated_at)
      SELECT c.id, CASE WHEN r.email IS NULL THEN 'skipped' WHEN c.emailed_at IS NULL THEN 'queued' ELSE 'sent' END, 'verify',
             1, c.issued_at, r.email, c.emailed_at, CASE WHEN c.emailed_at IS NULL THEN 0 ELSE 1 END, c.issued_at, c.issued_at
      FROM certificates c JOIN registrations r ON r.id = c.registration_id WHERE r.id BETWEEN $1 AND $2`, range);
    await run("sms", `
      INSERT INTO sms_messages (registration_id, phone, purpose, message, status, provider, attempts, run_at, sent_at, created_at, updated_at)
      SELECT r.id, r.phone, p.purpose, 'perf-seed', 'logged', 'log', 1, r.created_at, r.created_at, r.created_at, r.created_at
      FROM registrations r
      CROSS JOIN LATERAL (VALUES ('registration_ack'), ('certificate_link')) p(purpose)
      WHERE r.id BETWEEN $1 AND $2 AND (p.purpose = 'registration_ack' OR r.status = 'verified')`, range);
    await run("audit log", `
      INSERT INTO audit_logs (admin_id, action, entity, entity_id, meta, ip_address, created_at)
      SELECT 1, CASE WHEN r.status = 'verified' THEN 'verify' ELSE 'reject' END, 'registration', r.id::text, NULL, '10.0.0.2', r.reviewed_at
      FROM registrations r WHERE r.id BETWEEN $1 AND $2 AND r.status <> 'pending'`, range);
    await client.query("COMMIT");
  }
  await client.query("SET session_replication_role = DEFAULT");

  console.log(`Rebuilding ${indexes.length} indexes`);
  await client.query("SET maintenance_work_mem = '512MB'");
  for (const { indexname, indexdef } of indexes) await run(indexname, indexdef);
  for (const t of TABLES) await run(`vacuum analyze ${t}`, `VACUUM (ANALYZE) ${t}`);
  console.log("Done");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
