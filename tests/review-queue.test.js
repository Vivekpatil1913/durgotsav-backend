// GET /api/admin/registrations/:id/neighbors — server-side Previous / Next for the review queue
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let registrations;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
  registrations = await import("../src/modules/registrations/registrations.service.js");
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

let seq = 0;
async function register(fields = {}) {
  seq += 1;
  const data = { participant_type: "individual", name: `रांग ${seq}`, phone: `96${String(seq).padStart(8, "0")}`, district_id: "26", fort_id: "2", consent: "true", ...fields };
  const req = request(app).post("/api/registrations");
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  req.attach("photo", await makePhoto(), { filename: "replica.jpg", contentType: "image/jpeg" });
  const res = await req;
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id;
}

const neighbors = (id, query) => request(app).get(`/api/admin/registrations/${id}/neighbors`).query(query).set(auth());
const queue = { status: "pending", sort: "oldest" };

describe("review queue navigation (server side)", () => {
  let ids;

  before(async () => {
    ids = [];
    for (let i = 0; i < 6; i++) ids.push(await register());
    // ids[2] and ids[3] share a timestamp (order falls back to id); ids[4] is 1 µs later — a difference that a
    // millisecond-precision comparison in the browser would lose
    const times = ["10:00:00.000100", "10:00:00.000150", "10:00:00.000200", "10:00:00.000200", "10:00:00.000201", "10:00:01"];
    for (const [i, t] of times.entries()) {
      await pool.query("UPDATE registrations SET created_at = $2 WHERE id = $1", [ids[i], `2026-11-06 ${t}+05:30`]);
    }
  });

  test("first, middle and last record: prev / next / position in the oldest-first queue", async () => {
    const first = await neighbors(ids[0], queue);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { id: ids[0], prev_id: null, next_id: ids[1], position: 1, total: 6 });

    const tie = (await neighbors(ids[3], queue)).body.data;
    assert.deepEqual([tie.prev_id, tie.next_id, tie.position], [ids[2], ids[4], 4], "same timestamp: ordered by id");

    const micro = (await neighbors(ids[2], queue)).body.data;
    assert.equal(micro.next_id, ids[3]);
    assert.equal((await neighbors(ids[4], queue)).body.data.prev_id, ids[3], "1 µs later is after, not equal");

    const last = (await neighbors(ids[5], queue)).body.data;
    assert.deepEqual([last.prev_id, last.next_id, last.position, last.total], [ids[4], null, 6, 6]);
  });

  test("a record that was just reviewed still answers: next is the one that followed it", async () => {
    const review = await request(app).post(`/api/admin/registrations/${ids[3]}/review`).set(auth()).send({ action: "verify" });
    assert.equal(review.status, 200);
    const n = (await neighbors(ids[3], queue)).body.data;
    assert.deepEqual(n, { id: ids[3], prev_id: ids[2], next_id: ids[4], position: null, total: 5 });
    // and from its neighbour's point of view it is gone
    assert.equal((await neighbors(ids[2], queue)).body.data.next_id, ids[4]);
  });

  test("filters and sort order match the list", async () => {
    const { rows } = await pool.query("SELECT id FROM districts WHERE id <> 26 AND deleted_at IS NULL ORDER BY id LIMIT 1");
    const other = await register({ district_id: String(rows[0].id) });
    await pool.query("UPDATE registrations SET created_at = '2026-11-06 10:00:00.000175+05:30' WHERE id = $1", [other]);

    // without a district filter it sits between ids[1] and ids[2]; with district 26 it is skipped
    assert.equal((await neighbors(ids[1], queue)).body.data.next_id, other);
    const filtered = (await neighbors(ids[1], { ...queue, district_id: 26 })).body.data;
    assert.equal(filtered.next_id, ids[2]);
    assert.equal(filtered.total, 5);

    // newest first is the mirror image
    const newest = (await neighbors(ids[2], { status: "pending", sort: "newest" })).body.data;
    assert.deepEqual([newest.prev_id, newest.next_id], [ids[4], other]);
  });

  test("unknown record is 404; a record outside the admin's divisions is refused", async () => {
    assert.equal((await neighbors(999999, queue)).status, 404);
    await assert.rejects(registrations.neighbors(ids[0], { sort: "oldest" }, []), (err) => err.status === 403);
  });

  test("the whole queue can be walked with next alone, and back with prev", async () => {
    const forward = [];
    let n = (await neighbors(ids[0], queue)).body.data;
    forward.push(n.id);
    while (n.next_id) {
      n = (await neighbors(n.next_id, queue)).body.data;
      forward.push(n.id);
    }
    const list = await request(app).get("/api/admin/registrations").query({ ...queue, limit: 100 }).set(auth());
    assert.deepEqual(forward, list.body.data.map((r) => r.id), "same records, same order as the list");

    const back = [n.id];
    while (n.prev_id) {
      n = (await neighbors(n.prev_id, queue)).body.data;
      back.push(n.id);
    }
    assert.deepEqual(back, [...forward].reverse());
  });
});
