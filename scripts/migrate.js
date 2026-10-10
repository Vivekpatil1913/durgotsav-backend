// Applies every migrations/NNN_*.sql not yet recorded in schema_migrations, each in its own transaction.
import fs from "node:fs";
import path from "node:path";
import { pool } from "../src/db/pool.js";
import { paths } from "../src/config/paths.js";

await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

const { rows } = await pool.query("SELECT name FROM schema_migrations");
const applied = new Set(rows.map((r) => r.name));
const files = fs.readdirSync(paths.migrations).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(paths.migrations, file), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`Applied ${file}`);
    count++;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`Migration ${file} failed: ${err.message}`);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}
if (!count && !process.exitCode) console.log("Database is up to date");
await pool.end();
