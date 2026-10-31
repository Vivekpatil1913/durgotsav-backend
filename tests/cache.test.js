// utils/cache.js: one computation for concurrent callers, stale values served while one refresh runs, never served
// when very old, and kept when a refresh fails. No database.
import "./helpers.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCache } from "../src/utils/cache.js";

// A computation that answers 1, 2, 3 … after `ms`, counting its calls
function counter(ms = 20) {
  let calls = 0;
  const compute = async () => {
    calls += 1;
    await sleep(ms);
    return calls;
  };
  return { compute, calls: () => calls };
}

describe("createCache", () => {
  test("concurrent callers share one computation; a fresh value is reused", async () => {
    const cache = createCache({ ttlMs: 1000 });
    const c = counter();
    const values = await Promise.all([cache.get("k", c.compute), cache.get("k", c.compute), cache.get("k", c.compute)]);
    assert.deepEqual(values, [1, 1, 1]);
    assert.equal(await cache.get("k", c.compute), 1);
    assert.equal(c.calls(), 1);
  });

  test("a stale value is answered at once while one refresh runs", async () => {
    const cache = createCache({ ttlMs: 30, maxStaleMs: 10_000 });
    const c = counter(50);
    assert.equal(await cache.get("k", c.compute), 1);
    await sleep(40);
    const started = Date.now();
    assert.equal(await cache.get("k", c.compute), 1, "the old value, without waiting");
    assert.ok(Date.now() - started < 30);
    await sleep(80);
    assert.equal(await cache.get("k", c.compute), 2, "the refreshed value");
  });

  test("a value older than maxStaleMs is not served: the caller waits for the refresh", async () => {
    const cache = createCache({ ttlMs: 20, maxStaleMs: 60 });
    const c = counter(30);
    assert.equal(await cache.get("k", c.compute), 1);
    await sleep(90);
    assert.equal(await cache.get("k", c.compute), 2);
  });

  test("a failed refresh keeps the old value, even past maxStaleMs", async () => {
    const cache = createCache({ ttlMs: 20, maxStaleMs: 40, retryMs: 1000 });
    assert.equal(await cache.get("k", async () => "first"), "first");
    await sleep(60);
    assert.equal(await cache.get("k", async () => { throw new Error("database down"); }), "first");
  });

  test("peek never waits: null while cold, then the cached value", async () => {
    const cache = createCache({ ttlMs: 1000 });
    const c = counter(30);
    assert.equal(cache.peek("k", c.compute), null);
    await sleep(60);
    assert.equal(cache.peek("k", c.compute), 1);
  });
});
