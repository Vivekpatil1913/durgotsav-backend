import crypto from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { EDITION_YEAR, EDITION_YEAR_MR } from "../../config/edition.js";
import { env } from "../../config/env.js";
import { emailLayout, escapeHtml, sendMail } from "../../services/mail.service.js";
import { formatRegistrationNo, toMarathiDigits } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { certificateLink } from "./certificate.links.js";
import { claimDue, finishJob, loadForDelivery, reapExpiredLeases, REJECTED_PREFIX, UNDELIVERABLE_EMAIL } from "./certificate.queue.js";
import { renderInPool } from "./certificate.render-pool.js";
import { CertificateDataError } from "./certificate.renderer.js";
import { CERTIFIED_STATUSES } from "./certificates.service.js";

// Emails certificates from the certificate_email_jobs queue (migration 028). Runs inside the API
// (CERTIFICATE_WORKER=embedded) or as `npm run certificates:worker`; any number of processes can run at once.

// Shown in locked_by and the delivery log
export const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`.slice(0, 100);

const LEASE_MINUTES = 10; // far longer than one job can take (SMTP timeouts end a stuck send within ~2 minutes)
const POLL_MS = 3_000;
const REAP_EVERY_MS = 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180]; // after attempt 1, 2, 3 …; the last value repeats
const PAUSE_MIN_MS = 30_000;
const PAUSE_MAX_MS = 10 * 60_000;

// ---------------------------------------------------------------- the email

// Sent once an admin has approved the registration; the SMS with the certificate link is queued by that same
// approval (modules/sms), this email carries the PDF itself
function certificateEmail(cert, to, pdf) {
  return {
    to,
    subject: `अमृत दुर्गोत्सव ${EDITION_YEAR_MR} — आपले अभिनंदन पत्र`,
    html: emailLayout(
      `<p>नमस्कार ${escapeHtml(cert.name)},</p>
       <p>दुर्गोत्सव ${EDITION_YEAR_MR} मध्ये सहभाग नोंदविल्याबद्दल आपले हार्दिक अभिनंदन! आपली नोंदणी व छायाचित्राची पडताळणी पूर्ण झाली असून आपले डिजिटल <b>अभिनंदन पत्र</b> सोबत जोडले आहे.</p>
       <p>नोंदणी क्रमांक: <b>${formatRegistrationNo(cert.registration_id)}</b><br>दुर्गवीर क्रमांक: <b>${toMarathiDigits(cert.durgveer_no)}</b><br>अभिनंदन पत्र क्रमांक: <b>${escapeHtml(cert.certificate_no)}</b></p>
       <p><a href="${certificateLink(cert.registration_id)}" style="display:inline-block;background:#c2641c;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">अभिनंदन पत्र पुन्हा डाउनलोड करा</a></p>`,
    ),
    attachments: [{ filename: `Durgotsav-${EDITION_YEAR}-${cert.certificate_no}.pdf`, content: pdf, contentType: "application/pdf" }],
  };
}

// ---------------------------------------------------------------- checks

// Why this certificate must not be emailed for this job (null = go ahead). Checked when the job starts and again
// right before the email is handed to SMTP.
function blocker(rows, job) {
  if (!rows.length) return { next: { status: "cancelled" }, outcome: "cancelled", code: "CERTIFICATE_DELETED" };
  if (rows.length > 1) {
    return { next: { status: "failed" }, outcome: "failed", code: "PHOTO_AMBIGUOUS", error: "The registration has more than one current main photo" };
  }
  const c = rows[0];
  if (c.revoked_at) return { next: { status: "cancelled" }, outcome: "cancelled", code: "REVOKED" };
  if (c.deleted_at) return { next: { status: "cancelled" }, outcome: "cancelled", code: "REGISTRATION_DELETED" };
  if (!CERTIFIED_STATUSES.includes(c.status)) return { next: { status: "cancelled" }, outcome: "cancelled", code: "NOT_VERIFIED" };
  // Emailed after this delivery was asked for (e.g. by another worker): sending again would be a duplicate
  if (c.emailed_at && c.emailed_at >= job.requested_at) return { next: { status: "sent" }, outcome: "skipped", code: "ALREADY_SENT" };
  return null;
}

// Everything that ends up on the PDF. If any of it changes between rendering and sending, render again.
const printed = (c) => JSON.stringify([c.registration_id, c.certificate_no, c.durgveer_no, c.name, c.photo_id, c.photo_path]);

// What a failed attempt means:
//   data       the certificate cannot be made correctly (photo file missing …): fail now, an admin fixes it, then resends
//   recipient  invalid address / the mail server refused this message: fail now, retrying cannot help
//   transport  SMTP itself is unavailable (login, connection, quota): retry later and pause this worker
//   transient  anything else: retry later
function classify(err) {
  if (err instanceof CertificateDataError) return { kind: "data", code: err.code };
  const smtp = err.responseCode;
  const code = smtp ? `SMTP_${smtp}` : err.code || "ERROR";
  const text = `${err.response ?? ""} ${err.message ?? ""}`;
  if (["EAUTH", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "MAIL_DISABLED"].includes(err.code)
    || smtp === 421 || smtp === 454 || /5\.4\.5|quota|limit exceeded|rate limit|too many/i.test(text)) {
    return { kind: "transport", code };
  }
  if (err.code === "EENVELOPE" || (smtp >= 500 && smtp < 600)) return { kind: "recipient", code };
  return { kind: "transient", code };
}

// ±20 % jitter so a burst of failures does not retry in lock-step
const retryDelayMs = (attempt) => BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] * 60_000 * (0.8 + Math.random() * 0.4);

// ---------------------------------------------------------------- throttling

// Circuit breaker: after a transport failure stop claiming jobs for a while (30 s, doubling up to 10 min), so an
// SMTP outage does not burn the attempts of every queued email.
let pausedUntil = 0;
let pauseMs = PAUSE_MIN_MS;
function pauseSending(code) {
  pausedUntil = Date.now() + pauseMs;
  logger.warn({ code, seconds: pauseMs / 1000 }, "Certificate worker: SMTP unavailable, pausing deliveries");
  pauseMs = Math.min(pauseMs * 2, PAUSE_MAX_MS);
}

// CERTIFICATE_EMAIL_RATE_PER_MINUTE, spread evenly across this process's concurrent jobs
let nextSendAt = 0;
async function waitForSendSlot() {
  const rate = env.CERTIFICATE_EMAIL_RATE_PER_MINUTE;
  if (!rate) return;
  const now = Date.now();
  const at = Math.max(now, nextSendAt);
  nextSendAt = at + 60_000 / rate;
  if (at > now) await sleep(at - now);
}

// ---------------------------------------------------------------- one job

async function attempt(job, send, log) {
  let rows = await loadForDelivery(job.certificate_id);
  const stop = blocker(rows, job);
  if (stop) return stop;
  const cert = rows[0];
  Object.assign(log, { certificate_no: cert.certificate_no, durgveer_no: cert.durgveer_no, photo_id: cert.photo_id });

  const to = cert.email?.trim();
  if (!to || UNDELIVERABLE_EMAIL.test(to)) return { next: { status: "skipped" }, outcome: "skipped", code: "NO_EMAIL" };
  log.recipient = to;

  let started = Date.now();
  const pdf = await renderInPool(cert, { requirePhoto: true });
  Object.assign(log, { render_ms: Date.now() - started, pdf_bytes: pdf.length, pdf_sha256: crypto.createHash("sha256").update(pdf).digest("hex") });

  rows = await loadForDelivery(job.certificate_id);
  const late = blocker(rows, job);
  if (late) return late;
  if (printed(rows[0]) !== printed(cert)) {
    return { next: { status: "queued", runAt: new Date(), refund: true }, outcome: "requeued", code: "DATA_CHANGED" };
  }

  await waitForSendSlot();
  started = Date.now();
  const info = await send(certificateEmail(cert, to, pdf));
  if (!info) throw Object.assign(new Error("Email is switched off (SMTP is not configured)"), { code: "MAIL_DISABLED" });
  log.send_ms = Date.now() - started;
  Object.assign(log, { message_id: info.messageId, smtp_response: info.response });
  pauseMs = PAUSE_MIN_MS;
  return { next: { status: "sent", delivered: true }, outcome: "sent" };
}

function failure(job, err) {
  const { kind, code } = classify(err);
  if (kind === "transport") pauseSending(code);
  // Email switched off: put it back untouched until SMTP is configured
  const refund = code === "MAIL_DISABLED";
  const final = kind === "data" || kind === "recipient" || (!refund && job.attempts >= env.CERTIFICATE_EMAIL_MAX_ATTEMPTS);
  const next = final
    ? { status: "failed" }
    : { status: "queued", runAt: new Date(Date.now() + (refund ? PAUSE_MAX_MS : retryDelayMs(job.attempts))), refund };
  // A rejected address is marked as such (RECIPIENT_SMTP_550 …): "Retry failed" and "Email pending" skip it until corrected
  const recorded = kind === "recipient" ? `${REJECTED_PREFIX}${code}` : code;
  return { next, outcome: final ? "failed" : "retry", code: recorded, error: err.message, smtp_response: err.response };
}

// Saving the result must not be lost after an email went out (it would be sent again), so retry the write a few times
async function record(job, result, log) {
  for (const wait of [0, 1_000, 5_000, 15_000]) {
    if (wait) await sleep(wait);
    try {
      const kept = await finishJob(job, WORKER_ID, result.next, { ...log, outcome: result.outcome, error_code: result.code, error: result.error, smtp_response: result.smtp_response ?? log.smtp_response });
      if (!kept) logger.warn({ jobId: job.id }, "Certificate worker: lease expired before the result was saved");
      return;
    } catch (err) {
      logger.error({ err, jobId: job.id, outcome: result.outcome }, "Certificate worker: could not save the result");
    }
  }
}

/**
 * Handles one claimed job: re-validates the certificate from the database, renders this participant's PDF, emails
 * it and records the outcome. Returns 'sent' | 'retry' | 'failed' | 'skipped' | 'cancelled' | 'requeued'.
 * send: the mail function (tests pass a fake transport).
 */
export async function processJob(job, send = sendMail) {
  const log = {};
  let result;
  try {
    result = await attempt(job, send, log);
  } catch (err) {
    result = failure(job, err);
  }
  const fields = { jobId: job.id, certificateId: job.certificate_id, certificateNo: log.certificate_no, durgveerNo: log.durgveer_no, attempt: job.attempts, code: result.code };
  if (result.outcome === "sent") logger.info({ ...fields, renderMs: log.render_ms, sendMs: log.send_ms }, "Certificate emailed");
  else if (result.outcome === "failed") logger.error({ ...fields, error: result.error }, "Certificate email failed");
  else if (result.outcome === "retry") logger.warn({ ...fields, error: result.error, retryAt: result.next.runAt }, "Certificate email will be retried");
  else logger.info(fields, `Certificate email ${result.outcome}`);
  await record(job, result, log);
  return result.outcome;
}

// ---------------------------------------------------------------- loop

let running = false;
let loopDone = null;
const inFlight = new Set();
let wakeUp = () => {};

// New jobs were queued in this process (e.g. a verify): look at the queue now instead of at the next poll
export const wakeCertificateWorker = () => wakeUp();

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

async function loop(concurrency) {
  let lastReap = 0;
  while (running) {
    let full = false;
    try {
      if (Date.now() - lastReap >= REAP_EVERY_MS) {
        lastReap = Date.now();
        const reaped = await reapExpiredLeases(LEASE_MINUTES, env.CERTIFICATE_EMAIL_MAX_ATTEMPTS, WORKER_ID);
        if (reaped) logger.warn({ count: reaped }, "Certificate worker: re-queued emails whose worker stopped mid-job");
      }
      const free = concurrency - inFlight.size;
      if (free > 0 && Date.now() >= pausedUntil) {
        const jobs = await claimDue(free, WORKER_ID);
        for (const job of jobs) {
          const task = processJob(job)
            .catch((err) => logger.error({ err, jobId: job.id }, "Certificate worker: job crashed"))
            .finally(() => {
              inFlight.delete(task);
              wakeCertificateWorker();
            });
          inFlight.add(task);
        }
        full = jobs.length === free;
      }
    } catch (err) {
      logger.error({ err }, "Certificate worker: could not read the queue");
    }
    if (!running) break;
    // Claimed a full batch: go straight back for more once a slot frees up (a finishing job wakes the loop)
    const paused = pausedUntil - Date.now();
    if (!full || inFlight.size >= concurrency) await nap(paused > 0 ? paused : POLL_MS);
  }
}

export function startCertificateWorker({ concurrency = env.CERTIFICATE_WORKER_CONCURRENCY } = {}) {
  if (running) return true;
  if (!env.mailEnabled) {
    logger.warn("Certificate email worker not started: email is OFF (SMTP_HOST / SMTP_USER / SMTP_PASSWORD). Emails stay queued.");
    return false;
  }
  running = true;
  logger.info({ worker: WORKER_ID, concurrency, ratePerMinute: env.CERTIFICATE_EMAIL_RATE_PER_MINUTE || "unlimited" }, "Certificate email worker started");
  loopDone = loop(concurrency);
  return true;
}

// Stops claiming jobs and waits (up to timeoutMs) for the ones in progress. An unfinished job keeps its lease and
// is retried by any worker once the lease expires.
export async function stopCertificateWorker(timeoutMs = 8_000) {
  if (!running) return;
  running = false;
  wakeCertificateWorker();
  await Promise.race([Promise.allSettled([loopDone, ...inFlight]), sleep(timeoutMs)]);
}

/**
 * Sends every email that is due now, then returns the counts (npm run certificates:send-pending, tests).
 * Safe beside running workers: each claims different jobs.
 */
export async function drainQueue({ concurrency = env.CERTIFICATE_WORKER_CONCURRENCY, send } = {}) {
  const totals = { sent: 0, retry: 0, failed: 0, skipped: 0, cancelled: 0, requeued: 0 };
  let empty = false;
  // `concurrency` lanes, each taking the next due job as soon as its previous one is done
  const lane = async () => {
    while (!empty && Date.now() >= pausedUntil) {
      const [job] = await claimDue(1, WORKER_ID);
      if (!job) {
        empty = true;
        return;
      }
      totals[await processJob(job, send)] += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return totals;
}
