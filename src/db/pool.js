import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// Return DATE columns as plain "YYYY-MM-DD" strings instead of shifting them through local time zones
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> JS number (lat/lng, scores); values here are well inside double precision
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// COUNT(*) bigint -> number
pg.types.setTypeParser(20, (v) => Number(v));

export function dbConfig(database = env.DB_NAME) {
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database,
  };
}

export const pool = new pg.Pool({ ...dbConfig(), max: env.DB_POOL_MAX });

pool.on("error", (err) => logger.error({ err }, "Idle PostgreSQL client error"));

export const query = (text, params) => pool.query(text, params);

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
