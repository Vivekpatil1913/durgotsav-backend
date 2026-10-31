import { createApp } from "./app.js";
import { EDITION_YEAR } from "./config/edition.js";
import { env } from "./config/env.js";
import { closePools } from "./db/pool.js";
import { startCertificateWorker, stopCertificateWorker } from "./modules/certificates/certificate.worker.js";
import { startRejectionEmailWorker, stopRejectionEmailWorker } from "./modules/registrations/rejection-emails.js";
import { startSmsWorker, stopSmsWorker } from "./modules/sms/sms.worker.js";
import * as galleryService from "./modules/gallery/gallery.service.js";
import * as stats from "./modules/stats/stats.service.js";
import { checkS3Credentials } from "./services/s3.service.js";
import { logger } from "./utils/logger.js";

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info(`Durgotsav ${EDITION_YEAR} API listening on ${env.API_URL} (db: ${env.DB_NAME})`);
  // Fill the public caches now (whole-table counts, the gallery's page index), so the first visitors after a restart
  // do not wait for them
  Promise.allSettled([stats.publicStats(), galleryService.gallery({ page: 1, limit: 10 }), galleryService.latest(12)])
    .then((results) => results.filter((r) => r.status === "rejected")
      .forEach((r) => logger.warn({ err: r.reason }, "Cache warm-up failed")));
  if (!env.mailEnabled) logger.warn("Email is OFF — set SMTP_PASSWORD (Gmail App Password) in .env to send certificates");
  if (env.CERTIFICATE_WORKER === "embedded") {
    startCertificateWorker();
    startRejectionEmailWorker();
    startSmsWorker();
  } else {
    logger.info("CERTIFICATE_WORKER=off — certificate emails, rejection emails and SMS are sent by `npm run certificates:worker`");
  }
  if (env.REGISTRATION_FORCE_OPEN) logger.warn("REGISTRATION_FORCE_OPEN=true — the registration form stays open whatever Admin → Settings → Registration form says");
  if (env.CAPTCHA_PROVIDER === "dummy" || env.CAPTCHA_PROVIDER === "off") {
    logger.warn(`CAPTCHA_PROVIDER=${env.CAPTCHA_PROVIDER} — the "I am not a robot" box is not checked by Google or Cloudflare, so it does not stop scripted submissions`);
  }
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
    await Promise.all([stopCertificateWorker(), stopRejectionEmailWorker(), stopSmsWorker()]);
    await closePools();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
