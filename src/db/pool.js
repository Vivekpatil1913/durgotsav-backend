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

export const pool = new pg.Pool({
  ...dbConfig(),
  max: env.DB_POOL_MAX,
  // Release idle clients after 30 s to avoid holding connections needlessly.
  idleTimeoutMillis: 30_000,
  // Fail fast when the pool is fully busy — prevents request pile-ups under spike traffic.
  connectionTimeoutMillis: 5_000,
  // Sent with the connection's startup packet (no extra SET round trip racing the first query):
  // - statement_timeout: kills any query that runs longer than 60 s, so one slow query cannot starve the pool.
  //   For a known long batch run SET LOCAL statement_timeout = 0 inside its transaction.
  // - idle_in_transaction_session_timeout: a transaction left open by a crashed request releases its locks
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 120_000,
  application_name: "durgotsav-api",
});

pool.on("error", (err) => logger.error({ err }, "Idle PostgreSQL client error"));
// A connection the server ends while it is checked out (idle-in-transaction kill, failover) emits 'error' on the client;
// without a listener that would crash the process. The failing query rejects anyway and pg-pool drops the dead client.
pool.on("connect", (client) => client.on("error", (err) => logger.warn({ err }, "PostgreSQL connection lost")));

/**
 * A small, separate pool for admin analytics (dashboard counters, district/city statistics). Those aggregate whole tables
 * and may take seconds; on their own pool they queue among themselves instead of taking the connections that public
 * registrations, downloads and admin moderation need.
 */
export const reportPool = new pg.Pool({
  ...dbConfig(),
  max: env.DB_REPORT_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 30_000,
  statement_timeout: 120_000,
  idle_in_transaction_session_timeout: 120_000,
  application_name: "durgotsav-reports",
  // Idle report connections never keep a script or test process alive
  allowExitOnIdle: true,
});
reportPool.on("error", (err) => logger.error({ err }, "Idle PostgreSQL report client error"));
reportPool.on("connect", (client) => client.on("error", (err) => logger.warn({ err }, "PostgreSQL report connection lost")));

export const query = (text, params) => pool.query(text, params);
export const reportQuery = (text, params) => reportPool.query(text, params);

export const closePools = () => Promise.all([pool.end(), reportPool.end()]);

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
export async function withTransaction(fn) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // On a broken connection ROLLBACK fails too: report the error that caused it, and discard that connection
    await client.query("ROLLBACK").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
