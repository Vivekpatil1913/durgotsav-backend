import { AppError } from "../utils/errors.js";

/**
 * Lets at most `concurrency` requests through at a time and parks up to `queue` more; beyond that answers 503 with
 * Retry-After. Put it BEFORE the body parser (multer): a parked request's upload is not read until it is admitted, so
 * a spike of photo uploads cannot fill the process's memory — at most `concurrency` photos are in memory at once.
 * A request that gives up while parked (client gone) leaves the queue.
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
    res.on("finish", release);
    res.on("close", release);
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
