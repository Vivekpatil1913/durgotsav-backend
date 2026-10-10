// Emails the certificate to every verified registration that has an email address and has not received one.
import { env } from "../src/config/env.js";
import { pool } from "../src/db/pool.js";
import { notify, pendingEmailIds } from "../src/modules/certificates/certificates.service.js";

if (!env.mailEnabled) {
  console.error("Email is off: set SMTP_HOST, SMTP_USER and SMTP_PASSWORD in backend/.env");
  process.exit(1);
}
const ids = await pendingEmailIds();
let sent = 0;
for (const id of ids) {
  const result = await notify(id);
  if (result.email) sent++;
  else console.error(`Registration ${id}: email not sent (see log)`);
}
console.log(`Sent ${sent} of ${ids.length} pending certificate email(s)`);
await pool.end();
