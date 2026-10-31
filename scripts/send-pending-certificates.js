// Queues the certificate email for every verified registration with an email address that has not received one,
// then sends everything that is due and exits. Safe while the API's worker runs: each claims different emails.
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";
import { queuePending } from "../src/modules/certificates/certificates.service.js";
import { drainQueue } from "../src/modules/certificates/certificate.worker.js";
import { closeMail } from "../src/services/mail.service.js";

if (!env.mailEnabled) {
  console.error("Email is off: set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in backend/.env");
  process.exit(1);
}
// One "Email pending" run at a time, shared with the admin page's button
let run;
try {
  run = await queuePending(null);
} catch (err) {
  if (err.code !== "ALREADY_RUNNING") throw err;
  console.error(err.message);
  process.exit(1);
}
console.log(`Queued ${await run.done} certificate email(s)`);
const totals = await drainQueue();
console.log(`Sent ${totals.sent}, retry later ${totals.retry}, failed ${totals.failed}, no email ${totals.skipped}, cancelled ${totals.cancelled}`);
if (totals.retry || totals.failed) console.error("Some emails were not sent — see Admin → Certificates (email log) or the server log");
closeMail();
await pool.end();
