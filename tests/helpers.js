// Test bootstrap: points the app at a throw-away database, rebuilt from migrations + seeders on every run.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";
import sharp from "sharp";

process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.TEST_DB_NAME || "durgotsav_2026_test";
process.env.REGISTRATION_FORCE_OPEN = "true";
process.env.SEED_ADMIN_EMAIL = "admin@test.local";
process.env.SEED_ADMIN_PASSWORD = "TestPassword123";
process.env.SMTP_PASSWORD = ""; // never send real mail from tests
process.env.PARTICIPANT_IMAGE_STORAGE = "local"; // never reach AWS; s3-storage.test.js switches to a fake S3

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resetDatabase() {
  const admin = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: "postgres",
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${process.env.DB_NAME}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${process.env.DB_NAME}" ENCODING 'UTF8' TEMPLATE template0`);
  await admin.end();
  for (const script of ["scripts/migrate.js", "seeders/index.js"]) {
    execFileSync(process.execPath, [script], { cwd: root, env: process.env, stdio: "pipe" });
  }
}

// A random 6×5 grid of colour blocks scaled up to photo size: structured like a real photo (so its
// perceptual hash survives recompression) yet different on every call.
export async function makePhoto({ width = 800, height = 600 } = {}) {
  const grid = sharp(crypto.randomBytes(6 * 5 * 3), { raw: { width: 6, height: 5, channels: 3 } });
  return grid.resize(width, height, { kernel: "nearest" }).jpeg({ quality: 85 }).toBuffer();
}

export const ADMIN = { email: "admin@test.local", password: "TestPassword123" };
