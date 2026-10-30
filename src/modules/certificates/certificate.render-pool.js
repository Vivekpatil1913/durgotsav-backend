import os from "node:os";
import { Worker } from "node:worker_threads";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
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
  thread.worker.on("message", ({ id, pdf, error }) => {
    const task = thread.pending.get(id);
    if (!task) return;
    thread.pending.delete(id);
    if (!thread.pending.size) thread.worker.unref();
    if (error) task.reject(error.data ? new CertificateDataError(error.code, error.message) : Object.assign(new Error(error.message), { code: error.code }));
    else task.resolve(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
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

/**
 * Renders on the least busy thread. cert: { registration_id, name, photo_path, certificate_no, durgveer_no }.
 * Only these fields cross to the thread, so the renderer cannot see anything else about the participant.
 */
export function renderInPool(cert, options = {}) {
  const thread = threads.length < SIZE
    ? spawn()
    : threads.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  const id = ++nextId;
  const { registration_id, name, photo_path, certificate_no, durgveer_no } = cert;
  return new Promise((resolve, reject) => {
    thread.pending.set(id, { resolve, reject });
    thread.worker.ref();
    thread.worker.postMessage({ id, cert: { registration_id, name, photo_path, certificate_no, durgveer_no }, options });
  });
}
