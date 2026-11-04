// A division-limited admin works with the certificates of their own divisions and nobody else's: the list, its search and
// filters, the delivery cards, and every action on one certificate. Actions over all certificates stay with admins of
// all divisions.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let scopedToken;
let emptyToken;
let own;
let other;
let abroad;
const superAdmin = () => ({ Authorization: `Bearer ${token}` });
const scoped = () => ({ Authorization: `Bearer ${scopedToken}` });
const noDivisions = () => ({ Authorization: `Bearer ${emptyToken}` });

let phoneSeq = 0;
async function certified(fields) {
  phoneSeq += 1;
  const phone = `96${String(phoneSeq).padStart(8, "0")}`;
  const data = { name: `सहभागी ${phoneSeq}`, phone, email: `d${phoneSeq}@test.local`, consent: "true", ...fields };
  const req = request(app).post("/api/registrations");
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  req.attach("photo", await makePhoto(), { filename: "replica.jpg", contentType: "image/jpeg" });
  const res = await req;
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { id } = res.body.data;
  const verified = await request(app).post(`/api/admin/registrations/${id}/review`).set(superAdmin()).send({ action: "verify" });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const { rows: [c] } = await pool.query("SELECT durgveer_no FROM certificates WHERE registration_id = $1", [id]);
  return { id, name: data.name, phone, durgveer_no: c.durgveer_no };
}

async function divisionAdmin(email, divisionId) {
  const roles = (await request(app).get("/api/admin/rbac").set(superAdmin())).body.data;
  const created = await request(app).post("/api/admin/admins").set(superAdmin())
    .send({ name: "Division Admin", email, role_id: roles.find((r) => r.slug === "moderator").id, password: "Moderator123" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  if (divisionId) await pool.query("INSERT INTO admin_divisions (admin_id, division_id) VALUES ($1, $2)", [created.body.data.id, divisionId]);
  return (await request(app).post("/api/auth/login").send({ email, password: "Moderator123" })).body.token;
}

before(async () => {
  await resetDatabase();
  app = (await import("../src/app.js")).createApp();
  ({ pool } = await import("../src/db/pool.js"));
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;

  const { rows: [home] } = await pool.query("SELECT id, division_id FROM districts WHERE id = 26");
  const { rows: [away] } = await pool.query("SELECT id FROM districts WHERE division_id <> $1 ORDER BY id LIMIT 1", [home.division_id]);
  own = [await certified({ district_id: String(home.id) }), await certified({ district_id: String(home.id) })];
  other = [await certified({ district_id: String(away.id) }), await certified({ district_id: String(away.id) })];
  abroad = await certified({ country: "Nepal" });

  await pool.query(`UPDATE roles SET permissions = permissions || '{"certificates": {"read": true, "write": true}}' WHERE slug = 'moderator'`);
  scopedToken = await divisionAdmin("division@test.local", home.division_id);
  emptyToken = await divisionAdmin("nodivision@test.local", null);
});
after(async () => pool.end());

const list = (who, params) => request(app).get("/api/admin/certificates").set(who()).query(params);
const idsOf = (res) => res.body.data.map((c) => c.registration_id).sort((a, b) => a - b);
const sorted = (people) => people.map((p) => p.id).sort((a, b) => a - b);

describe("the certificate list", () => {
  test("shows a division-limited admin their own divisions only, and a full admin everything", async () => {
    const mine = await list(scoped);
    assert.equal(mine.status, 200);
    assert.deepEqual(idsOf(mine), sorted(own));
    assert.equal(mine.body.meta.total, 2);
    assert.deepEqual(idsOf(await list(superAdmin)), sorted([...own, ...other, abroad]));
  });

  test("search finds nobody outside those divisions, by name, mobile or दुर्गवीर number", async () => {
    for (const q of [other[0].name, other[0].phone, String(other[0].durgveer_no), abroad.name]) {
      const res = await list(scoped, { q });
      assert.deepEqual(res.body.data, [], `search for ${q}`);
      assert.equal(res.body.meta.total, 0);
      assert.equal((await list(superAdmin, { q })).body.data.length, 1, `a full admin finds ${q}`);
    }
    assert.deepEqual(idsOf(await list(scoped, { q: own[0].name })), [own[0].id]);
  });

  test("filters stay inside the divisions too", async () => {
    assert.deepEqual(idsOf(await list(scoped, { state: "valid" })), sorted(own));
    assert.deepEqual(idsOf(await list(scoped, { email_status: "queued" })), sorted(own));
    assert.deepEqual(idsOf(await list(scoped, { emailed: "no" })), sorted(own));
  });

  test("an admin with no divisions sees no certificates at all", async () => {
    const res = await list(noDivisions);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });
});

describe("the delivery cards", () => {
  const cards = async (who) => (await request(app).get("/api/admin/certificates/email-queue").set(who())).body.data;

  test("count a division-limited admin's certificates, exactly the rows each card opens", async () => {
    const stats = await cards(scoped);
    assert.equal(stats.total, 2);
    for (const status of ["queued", "processing", "sent", "failed", "skipped"]) {
      assert.equal(stats[status], (await list(scoped, { email_status: status })).body.meta.total, `the ${status} card`);
    }
    assert.equal(stats.queued, 2);
    assert.equal(stats.due_now, 2);
    assert.ok(stats.next_run_at);
    assert.equal(stats.rejected, 0);
    assert.equal(stats.sent_last_hour, 0);
    assert.equal(stats.last_activity_at, null);
    assert.equal(typeof stats.mail_enabled, "boolean");
  });

  test("a full admin's cards still count everything, and an admin with no divisions counts nothing", async () => {
    assert.equal((await cards(superAdmin)).total, 5);
    const none = await cards(noDivisions);
    assert.equal(none.total, 0);
    assert.equal(none.queued, 0);
  });
});

describe("actions on one certificate", () => {
  const routes = (id) => [
    ["get", `/api/admin/certificates/${id}/pdf`],
    ["get", `/api/admin/certificates/${id}/email-log`],
    ["post", `/api/admin/certificates/${id}/resend`],
    ["post", `/api/admin/certificates/${id}/revoke`, { reason: "Wrong person" }],
    ["post", `/api/admin/certificates/${id}/reinstate`],
  ];

  test("are refused for a certificate of another division, or of no division", async () => {
    for (const person of [other[0], abroad]) {
      for (const [method, url, body] of routes(person.id)) {
        const res = await request(app)[method](url).set(scoped()).send(body);
        assert.equal(res.status, 403, `${method} ${url}`);
      }
    }
    const { rows } = await pool.query("SELECT revoked_at FROM certificates WHERE registration_id = $1", [other[0].id]);
    assert.equal(rows[0].revoked_at, null, "the refused revoke changed nothing");
  });

  test("are refused for an admin with no divisions", async () => {
    assert.equal((await request(app).get(`/api/admin/certificates/${own[0].id}/pdf`).set(noDivisions())).status, 403);
  });

  test("work on the admin's own division", async () => {
    const pdf = await request(app).get(`/api/admin/certificates/${own[0].id}/pdf`).set(scoped())
      .buffer(true).parse((r, cb) => { const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.subarray(0, 5).toString(), "%PDF-");
    assert.equal((await request(app).get(`/api/admin/certificates/${own[0].id}/email-log`).set(scoped())).status, 200);
    assert.equal((await request(app).post(`/api/admin/certificates/${own[0].id}/resend`).set(scoped())).status, 200);
    assert.equal((await request(app).post(`/api/admin/certificates/${own[1].id}/revoke`).set(scoped()).send({ reason: "Wrong person" })).status, 200);
    assert.equal((await request(app).post(`/api/admin/certificates/${own[1].id}/reinstate`).set(scoped())).status, 200);
  });

  test("an unknown certificate is still a 404, and a full admin reaches every division", async () => {
    assert.equal((await request(app).get("/api/admin/certificates/99999999/pdf").set(scoped())).status, 404);
    assert.equal((await request(app).get(`/api/admin/certificates/${other[0].id}/email-log`).set(superAdmin())).status, 200);
    assert.equal((await request(app).get(`/api/admin/certificates/${abroad.id}/email-log`).set(superAdmin())).status, 200);
  });
});

describe("actions over all certificates", () => {
  test("are refused for a division-limited admin", async () => {
    for (const url of ["send-pending", "retry-failed"]) {
      const res = await request(app).post(`/api/admin/certificates/${url}`).set(scoped()).send({});
      assert.equal(res.status, 403, url);
      assert.match(res.body.error.message, /all divisions/);
    }
  });

  test("still run for a full admin", async () => {
    assert.equal((await request(app).post("/api/admin/certificates/retry-failed").set(superAdmin()).send({})).status, 200);
  });
});
