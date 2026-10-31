import { AppError } from "../utils/errors.js";

/**
 * Lets at most `concurrency` requests through at a time and parks up to `queue` more; beyond that answers 503 with
 * Retry-After. Put it BEFORE the body parser (multer): a parked request's upload is not read until it is admitted, so
 * a spike of photo uploads cannot fill the process's memory — at most `concurrency` photos are in memory at once.
 * A request that gives up while parked (client gone) leaves the queue.
 * The slot is freed when the response has been sent, or when the client hangs up — unless the route's handler (wrapped
 * in whileAdmitted) is still working on the photo: then it is freed when that work ends, so the gate bounds the work
 * in progress, not only the open connections.
 */
export function admission({ concurrency, queue, retryAfterSeconds = 10, message }) {
  let active = 0;
  const waiting = [];

  function admit(req, res, next) {
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      const following = waiting.shift();
      if (following) following.start();
    };
    req.admission = { working: false, release };
    res.on("finish", release);
    res.on("close", () => {
      if (!req.admission.working) release();
    });
    next();
  }

  return (req, res, next) => {
    if (active < concurrency) return admit(req, res, next);
    if (waiting.length >= queue) {
      res.set("Retry-After", String(retryAfterSeconds));
      return next(new AppError(503, message, { code: "BUSY" }));
    }
    const entry = {
      start: () => {
        req.off("close", leave);
        admit(req, res, next);
      },
    };
    function leave() {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
    }
    req.on("close", leave);
    waiting.push(entry);
  };
}

// Wraps the route handler behind admission(): its slot stays taken until the handler has finished, even when the
// client hung up halfway (the photo is still in memory, sharp and S3 still at work).
export const whileAdmitted = (handler) => async (req, res) => {
  if (req.admission) req.admission.working = true;
  try {
    return await handler(req, res);
  } finally {
    req.admission?.release();
  }
};
