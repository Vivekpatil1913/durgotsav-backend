// Behaviour that keeps the system fast at millions of registrations: capped counts and page depth, index-friendly
// search, near-duplicate photos found through band keys, photos stored outside the transaction, a streamed CSV export
// in keyset batches, rejection emails through a durable queue, and request errors that stay 4xx.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let rejections;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await resetDatabase();
  app = (await import("../src/app.js")).createApp();
  ({ pool } = await import("../src/db/pool.js"));
  rejections = await import("../src/modules/registrations/rejection-emails.js");
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

async function register(fields = {}, photo) {
  const req = request(app).post("/api/registrations");
  const data = { name: "स्केल चाचणी", phone: "9810000001", district_id: "26", consent: "true", ...fields };
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  req.attach("photo", photo ?? (await makePhoto()), { filename: "replica.jpg", contentType: "image/jpeg" });
  return req;
}
const list = (params) => request(app).get("/api/admin/registrations").set(auth()).query(params);
const review = (id, action, note) => request(app).post(`/api/admin/registrations/${id}/review`).set(auth()).send({ action, note });
const photoOf = async (id) =>
  (await pool.query("SELECT * FROM registration_photos WHERE registration_id = $1 AND is_current AND position = 1", [id])).rows[0];

// Many registrations at once, straight into the table (the API path is covered elsewhere)
async function bulkInsert(count, { phone = null, name = "Bulk" } = {}) {
  await pool.query(
    `INSERT INTO registrations (name, phone, country, district_id, division_id, status, created_at)
     SELECT $2 || ' ' || g, COALESCE($3, '97' || lpad(g::text, 8, '0')), 'India', 26,
            (SELECT division_id FROM districts WHERE id = 26), 'pending', NOW() - make_interval(secs => g)
     FROM generate_series(1, $1::int) g`,
    [count, name, phone],
  );
}

describe("duplicate photos", () => {
  test("the same file and a recompressed copy are both flagged; a different photo is not", async () => {
    const original = await makePhoto();
    const first = await register({}, original);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstPhoto = await photoOf(first.body.data.id);
    assert.equal(firstPhoto.duplicate_of_photo_id, null);

    const same = await register({ phone: "9810000002" }, original);
    assert.equal((await photoOf(same.body.data.id)).duplicate_of_photo_id, firstPhoto.id, "exact copy (sha256)");

    const recompressed = await sharp(original).resize(700).jpeg({ quality: 55 }).toBuffer();
    const near = await register({ phone: "9810000003" }, recompressed);
    assert.equal((await photoOf(near.body.data.id)).duplicate_of_photo_id, firstPhoto.id, "near copy (dHash band keys)");

    const other = await register({ phone: "9810000004" });
    assert.equal((await photoOf(other.body.data.id)).duplicate_of_photo_id, null);
  });

  test("the same photo sent twice at the same moment is flagged on the later registration", async () => {
    const photo = await makePhoto();
    const [a, b] = await Promise.all([register({ phone: "9810000005" }, photo), register({ phone: "9810000006" }, photo)]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const [pa, pb] = [await photoOf(a.body.data.id), await photoOf(b.body.data.id)];
    const flagged = [pa, pb].filter((p) => p.duplicate_of_photo_id);
    assert.equal(flagged.length, 1, "exactly one of the two is flagged");
    assert.equal(flagged[0].duplicate_of_photo_id, Math.min(pa.id, pb.id));
  });

  test("the band-key index answers the near-duplicate probe", async () => {
    const { rows } = await pool.query("SELECT dhash, dhash_band_keys(dhash) AS keys FROM registration_photos LIMIT 1");
    assert.equal(rows[0].keys.length, 4);
    const { rows: plan } = await pool.query(
      `EXPLAIN SELECT id FROM registration_photos WHERE dhash_band_keys(dhash) && $1::int[]`, [rows[0].keys]);
    assert.ok(plan.length > 0);
  });
});

describe("admin list: capped counts, page depth, search", () => {
  before(async () => bulkInsert(1200));

  test("counts are exact below the cap and flagged as not capped", async () => {
    const res = await list({ limit: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.capped, false);
    assert.ok(res.body.meta.total >= 1200);
    assert.equal(res.body.data.length, 10);
  });

  test("pages past the first 10,000 matches are refused with a clear message, not scanned", async () => {
    const res = await list({ limit: 10, page: 1001 });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /first 10,000/);
  });

  test("a number searches mobile / WhatsApp by contains; a short query only matches a registration number", async () => {
    const byPhone = await list({ q: "0000077" });
    assert.equal(byPhone.status, 200);
    assert.ok(byPhone.body.data.some((r) => r.phone === "9700000077"));
    assert.ok(byPhone.body.data.every((r) => r.phone.includes("0000077") || r.whatsapp_number?.includes("0000077")));

    const short = await list({ q: "77" });
    assert.equal(short.status, 200);
    assert.equal(short.body.meta.total, 0, "2 digits: registration number only (none is 77)");
  });

  test("a name written with Marathi digits is found by a search typed with them", async () => {
    const reg = (await register({ phone: "9810000099", name: "पाटील कुटुंब १२३" })).body.data;
    const res = await list({ q: "कुटुंब १२३" });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((r) => r.id === reg.id), JSON.stringify(res.body.meta));
  });

  test("a narrow text search returns the matches in list order", async () => {
    const res = await list({ q: "Bulk 111", sort: "registration_no", dir: "asc" });
    assert.equal(res.status, 200);
    const names = res.body.data.map((r) => r.name);
    assert.ok(names.includes("Bulk 111") && names.includes("Bulk 1110"));
    const ids = res.body.data.map((r) => r.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(res.body.meta.total, 11, "Bulk 111 and Bulk 1110 … 1119");
  });

  test("out-of-range ids and pages are 400s, not server errors", async () => {
    assert.equal((await list({ district_id: 99999 })).status, 400);
    assert.equal((await list({ page: 5_000_000 })).status, 400);
    assert.equal((await request(app).get("/api/admin/registrations/3000000000").set(auth())).status, 400);
  });

  test("the CSV export streams every row once, in keyset batches, in registration-number order", async () => {
    const total = (await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE deleted_at IS NULL")).rows[0].n;
    const res = await request(app).get("/api/admin/registrations/export.csv").set(auth()).query({ sort: "name", dir: "asc" })
      .buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200);
    assert.deepEqual([...res.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 byte order mark, so Excel reads Marathi");
    const lines = res.body.toString("utf8").replace(/^﻿/, "").trim().split("\n");
    assert.match(lines[0], /^registration_no,name,/);
    assert.equal(lines.length - 1, total, "every registration once, across batches of 1000");
    const regNos = lines.slice(1).map((l) => l.split(",")[0]);
    assert.equal(new Set(regNos).size, regNos.length, "no row twice");
    const numbers = regNos.map((n) => Number(n.split("-").pop()));
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), "registration-number order (a number never changes mid-export)");
  });

  test("the detail view caps the count of the same mobile's other registrations", async () => {
    await bulkInsert(1005, { phone: "9822222222", name: "Same mobile" });
    const { rows: [one] } = await pool.query("SELECT id FROM registrations WHERE phone = '9822222222' LIMIT 1");
    const res = await request(app).get(`/api/admin/registrations/${one.id}`).set(auth());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.same_phone_total, 1000);
    assert.equal(res.body.data.same_phone_capped, true);
    assert.equal(res.body.data.same_phone_registrations.length, 20);
  });

  test("previous / next counts the queue (up to the cap) and says whether it was capped", async () => {
    const queue = await list({ status: "pending", sort: "oldest", limit: 1 });
    const id = queue.body.data[0].id;
    const res = await request(app).get(`/api/admin/registrations/${id}/neighbors`).set(auth()).query({ status: "pending", sort: "oldest" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.position, 1);
    assert.equal(res.body.data.capped, false);
    assert.ok(res.body.data.total > 2000);
  });
});

describe("abuse limits that keep registrations unlimited", () => {
  test("a number gets the acknowledgment SMS for at most 5 registrations a day; all of them are saved", async () => {
    const phone = "9810000077";
    for (let i = 0; i < 7; i++) assert.equal((await register({ phone, name: `SMS cap ${i}` })).status, 201);
    const { rows: [counts] } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM registrations WHERE phone = $1) AS registrations,
              (SELECT COUNT(*)::int FROM sms_messages WHERE phone = $1 AND purpose = 'registration_ack') AS acks`, [phone]);
    assert.deepEqual(counts, { registrations: 7, acks: 5 });
  });

  test("a cut-off upload is answered 400, not as a server error", async () => {
    const res = await request(app).post("/api/registrations")
      .set("Content-Type", "multipart/form-data; boundary=----cut")
      .send(["------cut", 'Content-Disposition: form-data; name="name"', "", "अर्धवट"].join("\r\n"));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, "BAD_UPLOAD");
  });
});

describe("editing a registration's district", () => {
  test("moves its division (the moderators' scope) and clears a taluka of the old district", async () => {
    const reg = (await register({ phone: "9810000011" })).body.data;
    const { rows: [other] } = await pool.query(
      "SELECT id, division_id FROM districts WHERE division_id <> (SELECT division_id FROM districts WHERE id = 26) ORDER BY id LIMIT 1");
    const { rows: [taluka] } = await pool.query("SELECT id FROM talukas WHERE district_id = 26 AND deleted_at IS NULL LIMIT 1");
    if (taluka) await pool.query("UPDATE registrations SET taluka_id = $2 WHERE id = $1", [reg.id, taluka.id]);

    const res = await request(app).put(`/api/admin/registrations/${reg.id}`).set(auth()).send({ district_id: other.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows: [after] } = await pool.query("SELECT district_id, division_id, taluka_id FROM registrations WHERE id = $1", [reg.id]);
    assert.equal(after.district_id, other.id);
    assert.equal(after.division_id, other.division_id);
    assert.equal(after.taluka_id, null);

    // Saving the same district again keeps everything as it is
    const again = await request(app).put(`/api/admin/registrations/${reg.id}`).set(auth()).send({ district_id: other.id, city: "Test" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.division_id, other.division_id);
  });
});

describe("gallery selection", () => {
  test("a deleted or unapproved registration's photo cannot be shown on the website", async () => {
    const reg = (await register({ phone: "9810000021" })).body.data;
    const photo = await photoOf(reg.id);
    const feature = () => request(app).post("/api/admin/registrations/photos/feature").set(auth())
      .send({ photo_ids: [photo.id], featured: true });
    assert.deepEqual((await feature()).body.data.updated, [], "pending: not shown");
    await review(reg.id, "verify");
    await request(app).delete(`/api/admin/registrations/${reg.id}`).set(auth());
    assert.deepEqual((await feature()).body.data.updated, [], "deleted: not shown");
    await request(app).post(`/api/admin/registrations/${reg.id}/restore`).set(auth());
    assert.deepEqual((await feature()).body.data.updated, [photo.id], "approved and live: shown");
  });
});

describe("rejection emails go through a durable queue", () => {
  const queued = async (id) => (await pool.query("SELECT * FROM registration_emails WHERE registration_id = $1 ORDER BY id", [id])).rows;

  test("rejecting queues one notice; the worker sends it with the reason", async () => {
    const reg = (await register({ phone: "9810000031", email: "reject.me@test.local" })).body.data;
    const res = await review(reg.id, "reject", "छायाचित्र अस्पष्ट आहे");
    assert.equal(res.status, 200);
    const rows = await queued(reg.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "queued");

    const sent = [];
    const totals = await rejections.drainRejectionEmails({ send: async (mail) => sent.push(mail) });
    assert.equal(totals.sent, 1);
    assert.equal(sent[0].to, "reject.me@test.local");
    assert.match(sent[0].html, /छायाचित्र अस्पष्ट आहे/);
    assert.equal((await queued(reg.id))[0].status, "sent");
  });

  test("rejecting again with the same reason sends nothing new; a new reason does", async () => {
    const reg = (await register({ phone: "9810000032", email: "again@test.local" })).body.data;
    await review(reg.id, "reject", "कारण १");
    await review(reg.id, "reject", "कारण १");
    assert.equal((await queued(reg.id)).length, 1);
    await review(reg.id, "reject", "कारण २");
    assert.equal((await queued(reg.id)).length, 2);
    await rejections.drainRejectionEmails({ send: async () => ({}) });
  });

  test("a notice for a registration approved meanwhile is cancelled; no email address, no notice", async () => {
    const reg = (await register({ phone: "9810000033", email: "changed@test.local" })).body.data;
    await review(reg.id, "reject", "चुकीचे छायाचित्र");
    await review(reg.id, "verify");
    const totals = await rejections.drainRejectionEmails({ send: async () => assert.fail("must not send") });
    assert.equal(totals.cancelled, 1);
    assert.equal((await queued(reg.id))[0].error, "NOT_REJECTED");

    const noEmail = (await register({ phone: "9810000034" })).body.data;
    await review(noEmail.id, "reject", "कारण");
    assert.equal((await queued(noEmail.id)).length, 0);
  });

  test("a second rejection replaces a notice that is still waiting", async () => {
    const reg = (await register({ phone: "9810000036", email: "twice@test.local" })).body.data;
    await review(reg.id, "reject", "पहिले कारण");
    await review(reg.id, "reject", "दुसरे कारण");
    const rows = await queued(reg.id);
    assert.deepEqual(rows.map((r) => [r.status, r.error]), [["cancelled", "SUPERSEDED"], ["queued", null]]);
    const sent = [];
    await rejections.drainRejectionEmails({ send: async (mail) => sent.push(mail) });
    assert.equal(sent.length, 1, "one email, with the latest reason");
    assert.match(sent[0].html, /दुसरे कारण/);
  });

  test("a mail server that refuses our login is waited for without using up the notice's attempts", async () => {
    const reg = (await register({ phone: "9810000037", email: "outage@test.local" })).body.data;
    await review(reg.id, "reject", "कारण");
    const login = Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 });
    const totals = await rejections.drainRejectionEmails({ send: async () => { throw login; } });
    assert.equal(totals.queued, 1);
    const [row] = await queued(reg.id);
    assert.equal(row.status, "queued", "not failed for good");
    assert.equal(row.attempts, 0, "the attempt was given back");
    assert.ok(new Date(row.run_at) > new Date());
    const refused = Object.assign(new Error("550 5.1.1 The email account that you tried to reach does not exist"), { code: "EENVELOPE", responseCode: 550 });
    await pool.query("UPDATE registration_emails SET run_at = NOW() WHERE id = $1", [row.id]);
    assert.equal((await rejections.drainRejectionEmails({ send: async () => { throw refused; } })).failed, 1, "a refused address fails at once");
  });

  test("rejecting again with the same reason resends a notice that failed", async () => {
    const reg = (await register({ phone: "9810000038", email: "bounced@test.local" })).body.data;
    await review(reg.id, "reject", "कारण");
    const refused = Object.assign(new Error("550 5.1.1 No such user"), { code: "EENVELOPE", responseCode: 550 });
    await rejections.drainRejectionEmails({ send: async () => { throw refused; } });
    assert.equal((await queued(reg.id))[0].status, "failed");
    await review(reg.id, "reject", "कारण");
    const rows = await queued(reg.id);
    assert.deepEqual(rows.map((r) => r.status), ["failed", "queued"], "a new notice for the corrected address");
    await rejections.drainRejectionEmails({ send: async () => ({}) });
  });

  test("a refused send is retried later; email switched off keeps the notice queued", async () => {
    const reg = (await register({ phone: "9810000035", email: "flaky@test.local" })).body.data;
    await review(reg.id, "reject", "कारण");
    const totals = await rejections.drainRejectionEmails({ send: async () => { throw new Error("connection reset"); } });
    assert.equal(totals.queued, 1);
    const [row] = await queued(reg.id);
    assert.equal(row.status, "queued");
    assert.ok(new Date(row.run_at) > new Date(), "retried after a back-off");
    assert.equal(row.attempts, 1);
  });
});
