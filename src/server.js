import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { checkS3Credentials } from "./services/s3.service.js";
import { logger } from "./utils/logger.js";

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`Durgotsav 2026 API listening on ${env.API_URL} (db: ${env.DB_NAME})`);
  if (!env.mailEnabled) logger.warn("Email is OFF — set SMTP_PASSWORD (Gmail App Password) in .env to send certificates");
  if (env.REGISTRATION_FORCE_OPEN) logger.warn("REGISTRATION_FORCE_OPEN=true — registration window in settings is ignored");
  if (env.PARTICIPANT_IMAGE_STORAGE === "s3") {
    logger.info(`Participant photo originals → s3://${env.AWS_S3_BUCKET_NAME} (${env.AWS_REGION})`);
    checkS3Credentials();
  } else {
    logger.warn("PARTICIPANT_IMAGE_STORAGE=local — participant originals are kept in storage/originals, not S3");
  }
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
