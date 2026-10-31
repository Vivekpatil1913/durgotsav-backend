import os from "node:os";
import { Worker } from "node:worker_threads";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { verifyLink } from "./certificate.links.js";
import { CertificateDataError } from "./certificate.renderer.js";

// Building a PDF is ~35 ms of synchronous CPU (font parsing and layout in pdfkit). Doing that on the main thread
// would stall every API request while certificates are emailed or downloaded, so renders run on a few worker
// threads instead — which also spreads them over the CPU cores.
const SIZE = Math.max(1, Math.min(env.CERTIFICATE_WORKER_CONCURRENCY, os.availableParallelism() - 1, 4));
const THREAD = new URL("./certificate.render-thread.js", import.meta.url);

// Renders a thread works on at once: one laid out while the other reads and scales its photo. More would only pile
// image work onto libuv's small shared thread pool, which file reads everywhere in the API need too. The rest wait
// here, in arrival order.
const PER_THREAD = 2;
// Back-pressure: beyond this many renders waiting (a "download all" counts once per certificate in it) a download is
// refused with 503 (BUSY) at once, instead of queueing for longer than a browser waits — a download rush degrades into
// "try again", not a stalled process.
const MAX_WAITING = 40 * SIZE;
// A render takes well under a second; one still running after this has hung, and its thread is replaced
const TIMEOUT_MS = 60_000;

const threads = [];
const waiting = [];
let waitingUnits = 0;
let nextId = 0;

function spawn() {
  const thread = { worker: new Worker(THREAD), running: new Map() };
  thread.worker.unref(); // an idle pool must not keep scripts alive
  thread.worker.on("message", ({ id, data, error }) => {
    const task = thread.running.get(id);
    if (!task) return;
    settle(thread, task);
    if (error) task.reject(error.data ? new CertificateDataError(error.code, error.message) : Object.assign(new Error(error.message), { code: error.code }));
    else task.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    dispatch();
  });
  // A crashed or stopped thread fails only its own renders (they are retried by the queue); the next one waiting
  // starts a replacement
  thread.worker.on("error", (err) => logger.error({ err }, "Certificate render thread crashed"));
  thread.worker.on("exit", () => {
    retire(thread);
    for (const task of thread.running.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Certificate render thread stopped"));
    }
    thread.running.clear();
    dispatch();
  });
  threads.push(thread);
  return thread;
}

function retire(thread) {
  if (threads.includes(thread)) threads.splice(threads.indexOf(thread), 1);
}

function settle(thread, task) {
  clearTimeout(task.timer);
  thread.running.delete(task.id);
  if (!thread.running.size) thread.worker.unref();
}

// An idle thread first, then a new one while fewer than SIZE run, then the least busy one with a free slot
function freeThread() {
  let best = null;
  for (const t of threads) if (!best || t.running.size < best.running.size) best = t;
  if (best?.running.size === 0) return best;
  if (threads.length < SIZE) return spawn();
  return best && best.running.size < PER_THREAD ? best : null;
}

// Hands the oldest waiting renders to threads with a free slot
function dispatch() {
  while (waiting.length) {
    const thread = freeThread();
    if (!thread) return;
    const task = waiting.shift();
    waitingUnits -= task.units;
    thread.running.set(task.id, task);
    task.timer = setTimeout(() => timeOut(thread, task), TIMEOUT_MS).unref();
    thread.worker.ref();
    thread.worker.postMessage({ id: task.id, ...task.job });
  }
}

// The thread may be stuck for good: it is stopped (its other render fails with it) and a new one takes its place
function timeOut(thread, task) {
  settle(thread, task);
  const registrationIds = (task.job.certs ?? [task.job.cert]).map((c) => c.registration_id);
  logger.error({ registrationIds, seconds: TIMEOUT_MS / 1000 }, "Certificate render timed out; restarting its thread");
  task.reject(new AppError(503, "The certificate is taking too long to prepare. Please try again in a minute", { code: "RENDER_TIMEOUT" }));
  retire(thread);
  thread.worker.terminate();
  dispatch();
}

function run(job, units) {
  if (waitingUnits + units > MAX_WAITING) {
    return Promise.reject(new AppError(503, "Many certificates are being prepared right now. Please try again in a few seconds", { code: "BUSY" }));
  }
  return new Promise((resolve, reject) => {
    waiting.push({ id: ++nextId, job, units, resolve, reject });
    waitingUnits += units;
    dispatch();
  });
}

// Only these fields cross to the thread, so the renderer cannot see anything else about the participant.
// verify_url is what the QR code on the certificate opens.
const printable = ({ registration_id, name, photo_path, certificate_no, durgveer_no, registered_at }) =>
  ({ registration_id, name, photo_path, certificate_no, durgveer_no, registered_at, verify_url: verifyLink(certificate_no) });

/**
 * Renders on the next free thread slot. cert: { registration_id, name, photo_path, certificate_no, durgveer_no, registered_at }.
 * format: "pdf" (default) or "image" (2400×1712 JPEG).
 */
export const renderInPool = (cert, { format = "pdf", ...options } = {}) =>
  run({ kind: format === "image" ? "image" : "pdf", cert: printable(cert), options }, 1);

// Several certificates as one PDF, a page each
export const renderBundleInPool = (certs, options = {}) => run({ kind: "bundle", certs: certs.map(printable), options }, certs.length);
