import crypto from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { EDITION_YEAR_MR } from "../../config/edition.js";
import { env } from "../../config/env.js";
import { query } from "../../db/pool.js";
import { emailLayout, escapeHtml, mailErrorKind, sendMail } from "../../services/mail.service.js";
import { formatRegistrationNo } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { registrationWindow } from "../settings/settings.service.js";

// Rejection emails: the admin's reason and a link to register again. Durable queue (table registration_emails,
// migration 037) like SMS: a row is written in the rejection's own transaction, and a background worker sends it with
// retries. The email is composed when it is sent, so it reflects the registration window at that time.
// Delivery is at-least-once: a process that dies after the mail server accepted a message but before recording it sends
// that message again once its lease expires.

export const WORKER_ID = `${os.hostname()}:${process.pid}:reject-mail:${crypto.randomBytes(3).toString("hex")}`.slice(0, 100);

const CONCURRENCY = 2;
const LEASE_MINUTES = 5; // far longer than one send (SMTP times out after 60 s)
const POLL_MS = 5_000;
const REAP_EVERY_MS = 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180]; // after attempt 1, 2, 3 …; the last value repeats
// After a mail-server failure (down, login refused, over quota) stop claiming for a while: 30 s, doubling up to 10 min
const PAUSE_MIN_MS = 30_000;
const PAUSE_MAX_MS = 10 * 60_000;

/**
 * Queues the notice for each registration in `ids` that is rejected and has an email address. db: the client of the
 * review's transaction, so a notice exists exactly when the rejection committed. Returns how many were queued.
 */
export async function enqueueRejectionEmails(db, ids, requestedBy = null) {
  if (!ids.length) return 0;
  // A notice still waiting would send the same (latest) reason again: the new one replaces it
  await db.query(
    `UPDATE registration_emails SET status = 'cancelled', error = 'SUPERSEDED', updated_at = NOW()
     WHERE registration_id = ANY($1::int[]) AND status = 'queued'`,
    [ids],
  );
  const { rowCount } = await db.query(
    `INSERT INTO registration_emails (registration_id, kind, requested_by)
     SELECT r.id, 'rejection', $2::int FROM registrations r
     WHERE r.id = ANY($1::int[]) AND r.status = 'rejected' AND r.email IS NOT NULL AND r.deleted_at IS NULL`,
    [ids, requestedBy],
  );
  return rowCount;
}

const BUTTON_STYLE = "display:inline-block;background:#c2641c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none";

export function rejectionEmail(r, window) {
  const regNo = formatRegistrationNo(r.id);
  const closes = window.closesAt
    ? ` (नोंदणी ${new Date(window.closesAt).toLocaleDateString("mr-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" })} पर्यंत सुरू आहे)`
    : "";
  const again = window.open
    ? `<p><b>आपण पुन्हा सहभागी होऊ शकता.</b> वरील कारण लक्षात घेऊन, आपण व आपली दुर्ग प्रतिकृती दोन्ही स्पष्ट दिसतील असे नवीन, मूळ छायाचित्र काढा आणि पुन्हा नोंदणी करा${closes}.</p>
       <p><a href="${env.SITE_URL}/participate" style="${BUTTON_STYLE}">पुन्हा नोंदणी करा</a></p>`
    : "<p>नोंदणीचा कालावधी संपला असल्याने आता नवीन नोंदणी करता येणार नाही. अधिक माहितीसाठी कृपया आमच्याशी संपर्क साधा.</p>";
  return {
    to: r.email,
    subject: `अमृत दुर्गोत्सव ${EDITION_YEAR_MR} — आपली नोंदणी ${regNo} अमान्य`,
    html: emailLayout(
      `<p>नमस्कार ${escapeHtml(r.name)},</p>
       <p>दुर्गोत्सव ${EDITION_YEAR_MR} मध्ये सहभाग नोंदविल्याबद्दल धन्यवाद. आपल्या नोंदणीतील छायाचित्राची पडताळणी केली असता ते स्वीकारता आले नाही, त्यामुळे ही नोंदणी अमान्य करण्यात आली आहे.</p>
       <p>नोंदणी क्रमांक: <b>${regNo}</b></p>
       <p style="background:#fdecea;border-left:4px solid #b3261e;padding:12px 16px;border-radius:8px"><b>कारण:</b><br>${escapeHtml(r.review_note).replace(/\n/g, "<br>")}</p>
       ${again}
       <p style="font-size:13px;color:#6b5743">नोंदणीची स्थिती येथे पाहा: <a href="${env.SITE_URL}/certificate?registration=${regNo}">${regNo}</a></p>`,
    ),
  };
}

// ---------------------------------------------------------------- worker side

// Takes up to `limit` due messages for this worker. SKIP LOCKED: concurrent workers each get different rows.
async function claimDue(limit, worker) {
  const { rows } = await query(
    `UPDATE registration_emails e
     SET status = 'processing', attempts = e.attempts + 1, locked_at = NOW(), locked_by = $2, updated_at = NOW()
     FROM (SELECT id FROM registration_emails
           WHERE status = 'queued' AND run_at <= NOW()
           ORDER BY run_at, id LIMIT $1
           FOR UPDATE SKIP LOCKED) due
     WHERE e.id = due.id
     RETURNING e.id, e.registration_id, e.kind, e.attempts`,
    [limit, worker],
  );
  return rows;
}

// Records one attempt, only while this worker still holds the lease. Returns false when the lease was lost.
// next.refund: the attempt does not count (the mail server was unavailable, not this message's fault).
async function finish(job, worker, next) {
  const { rowCount } = await query(
    `UPDATE registration_emails
     SET status = $3, run_at = COALESCE($4, run_at), error = $5, sent_at = CASE WHEN $6 THEN NOW() ELSE sent_at END,
         attempts = attempts - $7::int, locked_at = NULL, locked_by = NULL, updated_at = NOW()
     WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
    [job.id, worker, next.status, next.runAt ?? null, next.error?.slice(0, 300) ?? null, next.status === "sent", next.refund ? 1 : 0],
  );
  return rowCount === 1;
}

async function reapExpired() {
  const { rowCount } = await query(
    `UPDATE registration_emails
     SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END, run_at = NOW(),
         locked_at = NULL, locked_by = NULL, error = 'LEASE_EXPIRED', updated_at = NOW()
     WHERE status = 'processing' AND locked_at < NOW() - make_interval(mins => $1)`,
    [LEASE_MINUTES, env.CERTIFICATE_EMAIL_MAX_ATTEMPTS],
  );
  return rowCount;
}

// CERTIFICATE_EMAIL_RATE_PER_MINUTE (the mail provider's quota), spread evenly across this process's sends
let nextSendAt = 0;
async function waitForSendSlot() {
  const rate = env.CERTIFICATE_EMAIL_RATE_PER_MINUTE;
  if (!rate) return;
  const now = Date.now();
  const at = Math.max(now, nextSendAt);
  nextSendAt = at + 60_000 / rate;
  if (at > now) await sleep(at - now);
}

const retryAt = (attempt) => new Date(Date.now() + BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] * 60_000);

let pausedUntil = 0;
let pauseMs = PAUSE_MIN_MS;
function pauseSending(code) {
  pausedUntil = Date.now() + pauseMs;
  logger.warn({ code, seconds: pauseMs / 1000 }, "Rejection email worker: mail server unavailable, pausing");
  pauseMs = Math.min(pauseMs * 2, PAUSE_MAX_MS);
}

/**
 * Sends one claimed message and records the outcome. Returns its new status ('sent' | 'queued' (retry later) |
 * 'failed' | 'cancelled'). send: the mail function (tests pass a fake).
 */
export async function processRejectionEmail(job, send = sendMail) {
  let next;
  try {
    const { rows } = await query(
      "SELECT id, name, email, status, review_note, deleted_at FROM registrations WHERE id = $1", [job.registration_id]);
    const r = rows[0];
    // Approved or reset again since, deleted, or the address removed: the notice no longer applies
    const stop = !r || r.deleted_at ? "REGISTRATION_DELETED" : r.status !== "rejected" ? "NOT_REJECTED" : !r.email ? "NO_EMAIL" : null;
    if (stop) {
      next = { status: "cancelled", error: stop };
    } else {
      await waitForSendSlot();
      const info = await send(rejectionEmail(r, await registrationWindow()));
      // false: email is switched off (no SMTP settings) — keep the notice for when it is configured
      next = info === false ? { status: "queued", runAt: retryAt(job.attempts), error: "MAIL_DISABLED", refund: true } : { status: "sent" };
      if (info !== false) pauseMs = PAUSE_MIN_MS;
    }
  } catch (err) {
    // A refused address will not start working on its own; a mail server that is down, refuses our login or is over
    // its quota is waited for without using up the notice's attempts; anything else is retried with back-off
    const kind = mailErrorKind(err);
    if (kind === "transport") {
      pauseSending(err.code ?? err.responseCode);
      next = { status: "queued", runAt: new Date(pausedUntil), error: err.message, refund: true };
    } else {
      next = kind === "recipient" || job.attempts >= env.CERTIFICATE_EMAIL_MAX_ATTEMPTS
        ? { status: "failed", error: err.message }
        : { status: "queued", runAt: retryAt(job.attempts), error: err.message };
    }
  }
  const fields = { emailId: job.id, registrationId: job.registration_id, attempt: job.attempts };
  if (next.status === "failed") logger.error({ ...fields, error: next.error }, "Rejection email failed");
  else if (next.status === "queued") logger.warn({ ...fields, error: next.error, retryAt: next.runAt }, "Rejection email will be retried");
  // The result must be saved once a message went out (otherwise it is sent again), so retry the write a few times
  for (const wait of [0, 1_000, 5_000]) {
    if (wait) await sleep(wait);
    try {
      if (!(await finish(job, WORKER_ID, next))) logger.warn(fields, "Rejection email worker: lease expired before the result was saved");
      break;
    } catch (err) {
      logger.error({ err, ...fields }, "Rejection email worker: could not save the result");
    }
  }
  return next.status;
}

// ---------------------------------------------------------------- loop

let running = false;
let loopDone = null;
const inFlight = new Set();
let wakeUp = () => {};

// A rejection was just queued in this process: look at the queue now, not at the next poll
export const wakeRejectionEmails = () => wakeUp();

function nap(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wakeUp = () => {};
      resolve();
    }
    wakeUp = done;
  });
}

async function loop() {
  let lastReap = 0;
  while (running) {
    let full = false;
    try {
      if (Date.now() - lastReap >= REAP_EVERY_MS) {
        lastReap = Date.now();
        const reaped = await reapExpired();
        if (reaped) logger.warn({ count: reaped }, "Rejection email worker: re-queued messages whose worker stopped mid-send");
      }
      const free = Date.now() < pausedUntil ? 0 : CONCURRENCY - inFlight.size;
      if (free > 0) {
        const jobs = await claimDue(free, WORKER_ID);
        for (const job of jobs) {
          const task = processRejectionEmail(job)
            .catch((err) => logger.error({ err, emailId: job.id }, "Rejection email worker: job crashed"))
            .finally(() => {
              inFlight.delete(task);
              wakeRejectionEmails();
            });
          inFlight.add(task);
        }
        full = jobs.length === free;
      }
    } catch (err) {
      logger.error({ err }, "Rejection email worker: could not read the queue");
    }
    if (!running) break;
    if (!full || inFlight.size >= CONCURRENCY) await nap(POLL_MS);
  }
}

// Runs where certificate emails are sent (CERTIFICATE_WORKER=embedded, or `npm run certificates:worker`). Without SMTP
// settings it does not start, so notices wait in the queue — like certificate emails — instead of being dropped.
export function startRejectionEmailWorker() {
  if (running || !env.mailEnabled) return false;
  running = true;
  logger.info({ worker: WORKER_ID }, "Rejection email worker started");
  loopDone = loop();
  return true;
}

// Stops claiming and waits (up to timeoutMs) for sends in progress; an unfinished one is retried after its lease expires
export async function stopRejectionEmailWorker(timeoutMs = 8_000) {
  if (!running) return;
  running = false;
  wakeRejectionEmails();
  await Promise.race([Promise.allSettled([loopDone, ...inFlight]), sleep(timeoutMs)]);
}

// Sends everything due now, then returns the counts (tests, scripts). Safe beside running workers.
export async function drainRejectionEmails({ send } = {}) {
  const totals = { sent: 0, queued: 0, failed: 0, cancelled: 0 };
  for (;;) {
    const jobs = await claimDue(CONCURRENCY, WORKER_ID);
    if (!jobs.length) return totals;
    for (const status of await Promise.all(jobs.map((job) => processRejectionEmail(job, send)))) totals[status] += 1;
  }
}
