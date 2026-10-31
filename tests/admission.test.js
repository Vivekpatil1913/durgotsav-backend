// middleware/admission.js: at most `concurrency` requests work at once, parked ones wait their turn, and a client that
// hangs up does not free its slot while its handler is still working. No database.
import "./helpers.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { admission, whileAdmitted } from "../src/middleware/admission.js";

// Minimal request / response pair: the gate only listens to their events
function exchange() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.set = () => res;
  return { req, res };
}

describe("admission", () => {
  test("a client that hangs up keeps its slot until its handler has finished", async () => {
    const gate = admission({ concurrency: 1, queue: 5, message: "busy" });
    let finishWork;
    const work = new Promise((resolve) => (finishWork = resolve));
    const first = exchange();
    const handler = whileAdmitted(() => work);

    let firstAdmitted = false;
    gate(first.req, first.res, () => (firstAdmitted = true));
    assert.ok(firstAdmitted);
    const running = handler(first.req, first.res);

    const second = exchange();
    let secondAdmitted = false;
    gate(second.req, second.res, () => (secondAdmitted = true));
    assert.equal(secondAdmitted, false, "parked while the first works");

    first.res.emit("close"); // the first client hangs up mid-work
    assert.equal(secondAdmitted, false, "the photo work is still running: no slot is freed");

    finishWork();
    await running;
    assert.equal(secondAdmitted, true, "admitted once the work ended");
  });

  test("a client that hangs up before its handler starts frees the slot at once; beyond the queue it is 503", async () => {
    const gate = admission({ concurrency: 1, queue: 0, message: "busy" });
    const first = exchange();
    gate(first.req, first.res, () => {});
    const second = exchange();
    let refused;
    gate(second.req, second.res, (err) => (refused = err));
    assert.equal(refused?.status, 503);
    first.res.emit("close"); // still uploading, handler not started
    const third = exchange();
    let admitted = false;
    gate(third.req, third.res, () => (admitted = true));
    assert.ok(admitted);
  });
});
