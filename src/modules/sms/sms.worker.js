import crypto from "node:crypto";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../../config/env.js";
import { sendSms } from "../../services/sms.service.js";
import { maskPhone } from "../../utils/format.js";
import { logger } from "../../utils/logger.js";
import { CERTIFIED_STATUSES } from "../certificates/certificates.service.js";
import { claimDue, finish, loadTarget, reapExpired } from "./sms.queue.js";

// Sends the sms_messages queue. Runs in the API process (CERTIFICATE_WORKER=embedded) or in `npm run certificates:worker`
// next to the email worker; any number of processes can run at once, each claims different messages.
// Delivery is at-least-once: a process that dies after the gateway accepted a message but before recording it sends that
// message again once its lease expires.

export const WORKER_ID = `${os.hostname()}:${process.pid}:sms:${crypto.randomBytes(3).toString("hex")}`.slice(0, 100);

const CONCURRENCY = 4;
const LEASE_MINUTES = 5; // far longer than one send (the gateway call times out after 10 s)
const POLL_MS = 3_000;
const REAP_EVERY_MS = 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 60]; // after attempt 1, 2, 3 …; the last value repeats

// SMS_RATE_PER_MINUTE, spread evenly across this process's concurrent sends
let nextSendAt = 0;
async function waitForSendSlot() {
  const rate = env.SMS_RATE_PER_MINUTE;
  if (!rate) return;
  const now = Date.now();
  const at = Math.max(now, nextSendAt);
  nextSendAt = at + 60_000 / rate;
  if (at > now) await sleep(at - now);
}

// Why this message must not go out (null = send it)
function blocker(job, target) {
  if (!target || target.deleted_at) return "REGISTRATION_DELETED";
  if (job.purpose === "certificate_link" && (!target.certificate_id || target.revoked_at || !CERTIFIED_STATUSES.includes(target.status))) {
    return "NO_CERTIFICATE";
  }
  return null;
}

const retryAt = (attempt) => new Date(Date.now() + BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] * 60_000);

/**
 * Handles one claimed message and records the outcome. Returns its new status
 * ('sent' | 'logged' | 'queued' (retry later) | 'failed' | 'cancelled'). send: the SMS function (tests pass a fake).
 */
export async function processSms(job, send = sendSms) {
  let next;
  try {
    const stop = blocker(job, await loadTarget(job.registration_id));
    if (stop) {
      next = { status: "cancelled", error: stop };
    } else {
      await waitForSendSlot();
      const result = await send(job.phone, job.message);
      if (result.status === "failed") {
        next = job.attempts >= env.SMS_MAX_ATTEMPTS
          ? { status: "failed", provider: result.provider, response: result.response, error: result.error }
          : { status: "queued", runAt: retryAt(job.attempts), provider: result.provider, response: result.response, error: result.error };
      } else {
        next = { status: result.status, provider: result.provider, response: result.response };
      }
    }
  } catch (err) {
    next = job.attempts >= env.SMS_MAX_ATTEMPTS
      ? { status: "failed", error: err.message }
      : { status: "queued", runAt: retryAt(job.attempts), error: err.message };
  }
  const fields = { smsId: job.id, registrationId: job.registration_id, purpose: job.purpose, phone: maskPhone(job.phone), attempt: job.attempts };
  if (next.status === "failed") logger.error({ ...fields, error: next.error }, "SMS failed");
  else if (next.status === "queued") logger.warn({ ...fields, error: next.error, retryAt: next.runAt }, "SMS will be retried");
  // Saving the result must not be lost after a message went out (it would be sent again), so retry the write a few times
  for (const wait of [0, 1_000, 5_000]) {
    if (wait) await sleep(wait);
    try {
      if (!(await finish(job, WORKER_ID, next))) logger.warn(fields, "SMS worker: lease expired before the result was saved");
      break;
    } catch (err) {
      logger.error({ err, ...fields }, "SMS worker: could not save the result");
    }
  }
  return next.status;
}

// ---------------------------------------------------------------- loop

let running = false;
let loopDone = null;
const inFlight = new Set();
let wakeUp = () => {};

// New messages were queued in this process (a registration, an approval): look at the queue now, not at the next poll
export const wakeSmsWorker = () => wakeUp();

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
        const reaped = await reapExpired(LEASE_MINUTES, env.SMS_MAX_ATTEMPTS);
        if (reaped) logger.warn({ count: reaped }, "SMS worker: re-queued messages whose worker stopped mid-send");
      }
      const free = CONCURRENCY - inFlight.size;
      if (free > 0) {
        const jobs = await claimDue(free, WORKER_ID);
        for (const job of jobs) {
          const task = processSms(job)
            .catch((err) => logger.error({ err, smsId: job.id }, "SMS worker: job crashed"))
            .finally(() => {
              inFlight.delete(task);
              wakeSmsWorker();
            });
          inFlight.add(task);
        }
        full = jobs.length === free;
      }
    } catch (err) {
      logger.error({ err }, "SMS worker: could not read the queue");
    }
    if (!running) break;
    if (!full || inFlight.size >= CONCURRENCY) await nap(POLL_MS);
  }
}

export function startSmsWorker() {
  if (running) return;
  running = true;
  logger.info({ worker: WORKER_ID, driver: env.SMS_DRIVER, ratePerMinute: env.SMS_RATE_PER_MINUTE || "unlimited" }, "SMS worker started");
  loopDone = loop();
}

// Stops claiming and waits (up to timeoutMs) for sends in progress; an unfinished one is retried after its lease expires
export async function stopSmsWorker(timeoutMs = 8_000) {
  if (!running) return;
  running = false;
  wakeSmsWorker();
  await Promise.race([Promise.allSettled([loopDone, ...inFlight]), sleep(timeoutMs)]);
}

// Sends everything due now, then returns the counts (tests, scripts). Safe beside running workers.
export async function drainSms({ send } = {}) {
  const totals = { sent: 0, logged: 0, queued: 0, failed: 0, cancelled: 0 };
  for (;;) {
    const jobs = await claimDue(CONCURRENCY, WORKER_ID);
    if (!jobs.length) return totals;
    for (const status of await Promise.all(jobs.map((job) => processSms(job, send)))) totals[status] += 1;
  }
}
