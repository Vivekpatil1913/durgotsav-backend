import { AppError } from "../utils/errors.js";

/**
 * Lets at most `concurrency` requests through at a time and parks up to `queue` more; beyond that answers 503 with
 * Retry-After. Put it BEFORE the body parser (multer): a parked request's upload is not read until it is admitted, so
 * a spike of photo uploads cannot fill the process's memory — at most `concurrency` photos are in memory at once.
 * A request that gives up while parked (client gone) leaves the queue.
 *
 * gate.around(...middlewares, handler) runs the upload, its checks and the handler inside the gate as one unit: the
 * slot is given back when that unit has finished — not when the client hangs up while its photo is still being read,
 * checked, processed or uploaded — so the gate bounds the work in progress, not only the open connections.
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

  const gate = (req, res, next) => {
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

  // middlewares: Express middlewares that call next() (multer, CAPTCHA check, validation); handler: async (req, res)
  gate.around = (...steps) => {
    const handler = steps.pop();
    return (req, res, next) => gate(req, res, async (refused) => {
      if (refused) return next(refused);
      req.admission.working = true;
      try {
        for (const step of steps) {
          await new Promise((resolve, reject) => step(req, res, (err) => (err ? reject(err) : resolve())));
        }
        // The client is gone (its connection closed): nobody will read the answer, so the photo work is skipped.
        // Not req.destroyed — a request reads as destroyed as soon as its body has been read.
        if (res.destroyed || req.socket?.destroyed) return;
        await handler(req, res);
      } catch (err) {
        next(err);
      } finally {
        req.admission.release();
      }
    });
  };

  return gate;
}
