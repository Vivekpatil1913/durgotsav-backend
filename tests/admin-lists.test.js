// What every admin list promises at any size: pages from the server with the numbers the table's S.NO. is built from,
// counts that stop at the cap, filters that mean what the admin sees (Indian days, literal search text) and exports that
// match the list. The database runs in UTC here, like the live server, so a filter that leaned on its time zone fails.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import request from "supertest";
import { ADMIN, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const get = (url, params) => request(app).get(`/api/admin${url}`).set(auth()).query(params);

before(async () => {
  await resetDatabase();
  // Before the app's first connection, so every one of them starts in UTC
  const { dbConfig } = await import("../src/db/pool.js");
  const client = new pg.Client(dbConfig("postgres"));
  await client.connect();
  await client.query(`ALTER DATABASE "${process.env.DB_NAME}" SET timezone TO 'UTC'`);
  await client.end();
  app = (await import("../src/app.js")).createApp();
  ({ pool } = await import("../src/db/pool.js"));
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

async function insertRegistration({ name, createdAt, districtId = 26, notes = null }) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO registrations (name, phone, country, district_id, division_id, status, replica_notes, created_at)
     VALUES ($1, '9830000001', 'India', $2, (SELECT division_id FROM districts WHERE id = $2), 'pending', $3, $4) RETURNING id`,
    [name, districtId, notes, createdAt],
  );
  return r.id;
}

describe("page numbers", () => {
  test("page 2 says which page it is, so the table can number its rows 11 to 20", async () => {
    await pool.query(
      `INSERT INTO registrations (name, phone, country, district_id, division_id, status)
       SELECT 'Row ' || g, '9830000002', 'India', 26, (SELECT division_id FROM districts WHERE id = 26), 'pending'
       FROM generate_series(1, 25) g`,
    );
    const [first, second, last] = await Promise.all([1, 2, 3].map((page) => get("/registrations", { page, limit: 10, sort: "registration_no", dir: "asc" })));
    assert.deepEqual([second.body.meta.page, second.body.meta.limit], [2, 10]);
    assert.equal(second.body.data.length, 10);
    assert.equal(last.body.data.length, 5);
    const ids = [first, second, last].flatMap((r) => r.body.data.map((row) => row.id));
    assert.equal(new Set(ids).size, 25, "every record on exactly one page");
  });

  test("a page past the end comes back empty with the new last page, for the panel to step back to", async () => {
    const res = await get("/registrations", { page: 40, limit: 10 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.page, 40);
    assert.equal(res.body.meta.totalPages, 3);
  });
});

describe("date filters are Indian days", () => {
  // 3 Nov 2026 in IST runs from 2 Nov 18:30 UTC to 3 Nov 18:30 UTC
  const justBefore = "2026-11-02T18:29:00Z";
  const firstMinute = "2026-11-02T18:31:00Z";
  const lastMinute = "2026-11-03T18:29:00Z";
  const justAfter = "2026-11-03T18:31:00Z";
  const oneDay = { from: "2026-11-03", to: "2026-11-03" };

  test("the registrations list and its export keep exactly that day", async () => {
    await insertRegistration({ name: "IST before", createdAt: justBefore });
    const inside = [await insertRegistration({ name: "IST first", createdAt: firstMinute }), await insertRegistration({ name: "IST last", createdAt: lastMinute })];
    await insertRegistration({ name: "IST after", createdAt: justAfter });

    const list = await get("/registrations", oneDay);
    assert.deepEqual(list.body.data.map((r) => r.id).sort(), inside.sort());
    const csv = await get("/registrations/export.csv", oneDay);
    assert.match(csv.text, /IST first/);
    assert.match(csv.text, /IST last/);
    assert.doesNotMatch(csv.text, /IST before|IST after/);
  });

  test("the audit log reaches any day, and refuses a date that is not one", async () => {
    await pool.query(
      `INSERT INTO audit_logs (action, entity, created_at)
       VALUES ('dated', 'file', $1), ('dated', 'file', $2), ('dated', 'file', $3), ('dated', 'file', $4)`,
      [justBefore, firstMinute, lastMinute, justAfter],
    );
    const day = await get("/audit-logs", { action: "dated", ...oneDay });
    assert.equal(day.status, 200, JSON.stringify(day.body));
    assert.equal(day.body.data.length, 2);
    assert.equal((await get("/audit-logs", { action: "dated", from: "2026-11-04" })).body.data.length, 1);
    assert.equal((await get("/audit-logs", { action: "dated", to: "2026-11-02" })).body.data.length, 1);
    assert.equal((await get("/audit-logs", { from: "yesterday" })).status, 400);
  });
});

describe("registrations export", () => {
  test("times are in IST as on screen, and a carriage return stays inside its cell", async () => {
    const id = await insertRegistration({ name: "Export row", createdAt: "2026-11-03T15:05:00Z", notes: "line one\rline two" });
    const csv = await get("/registrations/export.csv", { q: "Export row" });
    assert.equal(csv.status, 200);
    assert.match(csv.text, /"03 Nov 2026, (0?8):35 pm"/i);
    assert.doesNotMatch(csv.text, /2026-11-03T15:05/);
    assert.match(csv.text, /"line one\rline two"/);
    assert.equal((await pool.query("SELECT 1 FROM registrations WHERE id = $1", [id])).rowCount, 1);
  });
});

describe("CMS lists", () => {
  const enquire = (count, name) => pool.query(
    `INSERT INTO contact_enquiries (name, email, subject, message, created_at)
     SELECT $2 || ' ' || g, 'e@test.local', 'Subject', 'Message', '2026-11-01T10:00:00Z' FROM generate_series(1, $1::int) g`,
    [count, name],
  );

  test("enquiries of the same instant never repeat or vanish between pages", async () => {
    await enquire(25, "Same moment");
    const pages = await Promise.all([1, 2, 3].map((page) => get("/enquiries", { page, limit: 10, q: "Same moment" })));
    const ids = pages.flatMap((r) => r.body.data.map((row) => row.id));
    assert.equal(ids.length, 25);
    assert.equal(new Set(ids).size, 25);
  });

  test("% and _ in the search box are the characters themselves, not wildcards", async () => {
    await enquire(1, "100% sure");
    await enquire(1, "plain_name");
    const names = async (q) => (await get("/enquiries", { q })).body.data.map((r) => r.name);
    assert.deepEqual(await names("100%"), ["100% sure 1"]);
    assert.deepEqual(await names("%"), ["100% sure 1"]);
    assert.deepEqual(await names("n_m"), []);
    assert.deepEqual(await names("in_n"), ["plain_name 1"]);
  });

  test("counting stops at the cap, and pages past it are refused with a way forward", async () => {
    await enquire(10_005, "Crowd");
    const res = await get("/enquiries", { limit: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.total, 10_000);
    assert.equal(res.body.meta.capped, true);
    assert.equal(res.body.meta.totalPages, 1_000);
    assert.equal((await get("/enquiries", { limit: 10, page: 1_000 })).status, 200);
    const past = await get("/enquiries", { limit: 10, page: 1_001 });
    assert.equal(past.status, 400);
    assert.match(past.body.error.message, /Narrow the filters/);
  });

  test("a small list reports its exact total", async () => {
    const res = await get("/divisions", { limit: 100 });
    assert.equal(res.body.meta.capped, false);
    assert.equal(res.body.meta.total, res.body.data.length);
  });
});

describe("admin search", () => {
  test("% in the users search is the character itself", async () => {
    assert.deepEqual((await get("/admins", { q: "%" })).body.data, []);
    assert.equal((await get("/admins", { q: "admin@test" })).body.data.length, 1);
  });
});

describe("statistics tables", () => {
  test("division and district shares are of the whole table, not of the page asked for", async () => {
    const { invalidateStatsCache } = await import("../src/modules/stats/stats.service.js");
    invalidateStatsCache();
    const onePage = await get("/stats/divisions", { limit: 1 });
    const all = (await get("/stats/divisions", { limit: 100 })).body.data.items;
    assert.equal(onePage.body.data.items.length, 1);
    const grand = all.reduce((sum, d) => sum + d.total, 0);
    const top = onePage.body.data.items[0];
    assert.equal(top.share, Math.round((top.total * 1000) / grand) / 10);
    assert.ok(top.share < 100 || all.filter((d) => d.total).length === 1);

    const districts = await get("/stats/districts", { page: 2, limit: 10 });
    assert.equal(districts.body.data.meta.page, 2);
    assert.equal(districts.body.data.items.length, 10);
    assert.ok(districts.body.data.items.every((d) => typeof d.share === "number"));
  });
});
