// Test bootstrap: points the app at a throw-away database, rebuilt from migrations + seeders on every run.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
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
process.env.AWARD_DOCUMENTS_DIR = path.join(os.tmpdir(), "durgotsav-award-test-documents"); // never mix test files with real evidence
// Images the tests upload stay out of the project: uploads/ is committed, so files written there end up in commits
process.env.UPLOADS_DIR = path.join(os.tmpdir(), "durgotsav-test-uploads");
process.env.ORIGINALS_DIR = path.join(os.tmpdir(), "durgotsav-test-originals");
process.env.PARTICIPANT_IMAGE_STORAGE = "local"; // never reach AWS; s3-storage.test.js switches to a fake S3
process.env.AWARD_DOCUMENT_STORAGE = "local"; // never reach AWS; award.test.js switches to a fake S3 where it needs one
process.env.CAPTCHA_PROVIDER = "off"; // srs-v2.test.js switches it on against a stubbed provider
process.env.SMS_DRIVER = "log"; // never reach an SMS gateway

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
