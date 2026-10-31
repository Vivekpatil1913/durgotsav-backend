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

const threads = [];
let nextId = 0;

function spawn() {
  const thread = { worker: new Worker(THREAD), pending: new Map() };
  thread.worker.unref(); // an idle pool must not keep scripts alive
  thread.worker.on("message", ({ id, data, error }) => {
    const task = thread.pending.get(id);
    if (!task) return;
    thread.pending.delete(id);
    if (!thread.pending.size) thread.worker.unref();
    if (error) task.reject(error.data ? new CertificateDataError(error.code, error.message) : Object.assign(new Error(error.message), { code: error.code }));
    else task.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
  // A crashed thread fails only its own renders (they are retried by the queue) and is replaced on next use
  thread.worker.on("error", (err) => logger.error({ err }, "Certificate render thread crashed"));
  thread.worker.on("exit", () => {
    if (threads.includes(thread)) threads.splice(threads.indexOf(thread), 1);
    for (const task of thread.pending.values()) task.reject(new Error("Certificate render thread stopped"));
  });
  threads.push(thread);
  return thread;
}

// Only these fields cross to the thread, so the renderer cannot see anything else about the participant.
// verify_url is what the QR code on the certificate opens.
const printable = ({ registration_id, name, photo_path, certificate_no, durgveer_no, registered_at }) =>
  ({ registration_id, name, photo_path, certificate_no, durgveer_no, registered_at, verify_url: verifyLink(certificate_no) });

// Back-pressure: beyond this many renders waiting per thread a download is refused with 503 (BUSY) at once, instead of
// queueing for longer than a browser waits — a download rush degrades into "try again", not a stalled process.
const MAX_WAITING_PER_THREAD = 40;

function run(job) {
  const thread = threads.length < SIZE
    ? spawn()
    : threads.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  if (thread.pending.size >= MAX_WAITING_PER_THREAD) {
    return Promise.reject(new AppError(503, "Many certificates are being prepared right now. Please try again in a few seconds", { code: "BUSY" }));
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    thread.pending.set(id, { resolve, reject });
    thread.worker.ref();
    thread.worker.postMessage({ id, ...job });
  });
}

/**
 * Renders on the least busy thread. cert: { registration_id, name, photo_path, certificate_no, durgveer_no, registered_at }.
 * format: "pdf" (default) or "image" (2400×1712 JPEG).
 */
export const renderInPool = (cert, { format = "pdf", ...options } = {}) =>
  run({ kind: format === "image" ? "image" : "pdf", cert: printable(cert), options });

// Several certificates as one PDF, a page each
export const renderBundleInPool = (certs, options = {}) => run({ kind: "bundle", certs: certs.map(printable), options });
