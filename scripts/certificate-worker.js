// Long-running certificate email worker (npm run certificates:worker).
// Production: run it as its own pm2 process and set CERTIFICATE_WORKER=off for the API, so rendering and SMTP
// never share a process with web requests. Several copies may run at once; each claims different emails.
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";
import { startCertificateWorker, stopCertificateWorker } from "../src/modules/certificates/certificate.worker.js";
import { closeMail } from "../src/services/mail.service.js";
import { logger } from "../src/utils/logger.js";

if (!startCertificateWorker()) {
  console.error("Email is off: set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in backend/.env");
  await pool.end();
  process.exit(1);
}

async function shutdown(signal) {
  logger.info(`${signal} received, finishing emails in progress`);
  await stopCertificateWorker(25_000);
  closeMail();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
logger.info(`Certificate worker running (concurrency ${env.CERTIFICATE_WORKER_CONCURRENCY})`);
