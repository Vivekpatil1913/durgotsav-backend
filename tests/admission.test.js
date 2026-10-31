// middleware/admission.js: at most `concurrency` requests work at once, parked ones wait their turn, and a client that
// hangs up does not free its slot while its upload, checks or photo work are still running. No database.
import "./helpers.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { admission } from "../src/middleware/admission.js";

// Minimal request / response pair: the gate only listens to their events
function exchange() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.set = () => res;
  return { req, res };
}

// A promise and the function that resolves it
function later() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe("admission", () => {
  test("a client that hangs up keeps its slot until its checks and photo work have finished", async () => {
    const gate = admission({ concurrency: 1, queue: 5, message: "busy" });
    const captcha = later(); // a slow CAPTCHA provider
    const work = later();
    let handled = false;
    const route = gate.around(
      (req, res, next) => captcha.promise.then(() => next()),
      async () => {
        handled = true;
        await work.promise;
      },
    );

    const first = exchange();
    const errors = [];
    route(first.req, first.res, (err) => errors.push(err));

    const second = exchange();
    let secondAdmitted = false;
    gate(second.req, second.res, () => (secondAdmitted = true));
    assert.equal(secondAdmitted, false, "parked while the first works");

    first.res.emit("close"); // the first client hangs up during the CAPTCHA check
    await new Promise(setImmediate);
    assert.equal(secondAdmitted, false, "its checks are still running: no slot is freed");

    captcha.resolve();
    await new Promise(setImmediate);
    assert.equal(handled, true);
    assert.equal(secondAdmitted, false, "the photo work is still running");

    work.resolve();
    await new Promise(setImmediate);
    assert.equal(secondAdmitted, true, "admitted once the unit finished");
    assert.deepEqual(errors, []);
  });

  test("a failing check ends the unit: its error is passed on and the slot freed", async () => {
    const gate = admission({ concurrency: 1, queue: 5, message: "busy" });
    const route = gate.around((req, res, next) => next(new Error("CAPTCHA failed")), async () => assert.fail("handler must not run"));
    const first = exchange();
    let error;
    route(first.req, first.res, (err) => (error = err));
    await new Promise(setImmediate);
    assert.equal(error?.message, "CAPTCHA failed");
    let admitted = false;
    gate(exchange().req, exchange().res, () => (admitted = true));
    assert.ok(admitted);
  });

  test("beyond the queue a request is answered 503 at once", () => {
    const gate = admission({ concurrency: 1, queue: 0, message: "busy" });
    gate(exchange().req, exchange().res, () => {});
    let refused;
    gate(exchange().req, exchange().res, (err) => (refused = err));
    assert.equal(refused?.status, 503);
  });
});
