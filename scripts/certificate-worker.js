// Long-running background worker (npm run certificates:worker): certificate emails, rejection emails and SMS.
// Production: run it as its own pm2 process and set CERTIFICATE_WORKER=off for the API, so rendering, SMTP and the SMS
// gateway never share a process with web requests. Several copies may run at once; each claims different messages.
import { env } from "../src/config/env.js";
import { closePools } from "../src/db/pool.js";
import { startCertificateWorker, stopCertificateWorker } from "../src/modules/certificates/certificate.worker.js";
import { startRejectionEmailWorker, stopRejectionEmailWorker } from "../src/modules/registrations/rejection-emails.js";
import { startSmsWorker, stopSmsWorker } from "../src/modules/sms/sms.worker.js";
import { closeMail } from "../src/services/mail.service.js";
import { logger } from "../src/utils/logger.js";

// SMS go out whether or not email is configured
startSmsWorker();
if (!startCertificateWorker()) {
  logger.warn("Email is off (SMTP_HOST, SMTP_USER, SMTP_PASSWORD in backend/.env): certificate and rejection emails stay queued, SMS are sent");
}
startRejectionEmailWorker();

async function shutdown(signal) {
  logger.info(`${signal} received, finishing emails and SMS in progress`);
  await Promise.all([stopCertificateWorker(25_000), stopRejectionEmailWorker(25_000), stopSmsWorker(25_000)]);
  closeMail();
  await closePools();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
logger.info(`Background worker running (email concurrency ${env.CERTIFICATE_WORKER_CONCURRENCY}, SMS driver ${env.SMS_DRIVER})`);
