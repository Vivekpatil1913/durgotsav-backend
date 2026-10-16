import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let district;
let taluka;
const auth = () => ({ Authorization: `Bearer ${token}` });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
  // The suite must not depend on the real calendar: open the window around "now"
  await pool.query("UPDATE award_editions SET nomination_opens_at = NOW() - INTERVAL '1 day', nomination_closes_at = NOW() + INTERVAL '1 day', nominations_enabled = true");
  const { rows } = await pool.query("SELECT t.id AS taluka_id, t.district_id FROM talukas t WHERE t.deleted_at IS NULL ORDER BY t.id LIMIT 1");
  district = rows[0].district_id;
  taluka = rows[0].taluka_id;
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

const individual = (over = {}) => ({
  submission_id: crypto.randomUUID(),
  category: "individual",
  nominator_name: "सुरेश जाधव",
  nominator_mobile: "9876500001",
  nominee_name: "अनंत देशपांडे",
  father_or_husband_name: "विष्णु देशपांडे",
  date_of_birth: "1965-04-12",
  mobile: "9876500002",
  email: "anant@example.com",
  address: "१२, शनिवार पेठ, पुणे",
  district_id: district,
  taluka_id: taluka,
  work_started_year: 1990,
  work_categories: ["conservation", "research"],
  conservation_work: "गेली ३० वर्षे राजगड व तोरणा परिसरात संवर्धन मोहिमा राबवल्या.",
  activities: [{ title: "राजगड स्वच्छता मोहीम", fort_name: "राजगड", work_type: "संवर्धन", period: "२०१५–२०२५" }],
  publications: [{ title: "दुर्गवैभव", publisher: "स्वप्रकाशित", year: 2010 }],
  honours: [],
  documents: [],
  declaration_accepted: true,
  declaration_place: "पुणे",
  declaration_date: today(),
  declaration_name: "सुरेश जाधव",
  ...over,
});

const organization = (over = {}) => ({
  submission_id: crypto.randomUUID(),
  category: "organization",
  nominator_name: "मीना पाटील",
  nominator_mobile: "9876500011",
  nominee_name: "दुर्गसेवक प्रतिष्ठान",
  org_type: "public_trust",
  established_year: 2001,
  registration_no: "F-12345",
  registration_date: "2002-05-01",
  registration_authority: "धर्मादाय आयुक्त, पुणे",
  pan: "abcde1234f",
  website_url: "https://example.org",
  mobile: "9876500012",
  email: "info@example.org",
  address: "कोथरूड, पुणे",
  district_id: district,
  taluka_id: taluka,
  pincode: "411038",
  work_started_year: 2001,
  work_categories: ["conservation", "youth_participation"],
  conservation_details: "दरवर्षी १२ गडांवर स्वच्छता व तटबंदी दुरुस्ती मोहिमा.",
  distinctive_features: "५०० हून अधिक स्वयंसेवकांचे जाळे व शास्त्रशुद्ध दस्तऐवजीकरण.",
  research_tools: ["maps", "photographs"],
  volunteer_count: 500,
  officials: [{ name: "राजेश कुलकर्णी", designation: "अध्यक्ष", email: "raj@example.org", mobile: "9876500013", address: "पुणे" }],
  activities: [{ title: "गड स्वच्छता", period: "२०२४", details: "१२ गड", beneficiaries: 2000 }],
  documents: [],
  declaration_accepted: true,
  declaration_place: "पुणे",
  declaration_date: today(),
  declaration_name: "मीना पाटील",
  ...over,
});

function submit(payload, files = []) {
  const req = request(app).post("/api/shivdurg-award/nominations").field("payload", JSON.stringify(payload));
  for (const f of files) req.attach(f.field, f.buffer, { filename: f.name, contentType: f.type });
  return req;
}

describe("public award info", () => {
  test("returns the configured edition, open status, winners and option lists", async () => {
    const res = await request(app).get("/api/shivdurg-award");
    assert.equal(res.status, 200);
    assert.equal(res.body.data.edition.year, 2026);
    assert.equal(res.body.data.status.open, true);
    assert.equal(res.body.data.winners.length, 2);
    assert.ok(res.body.data.options.org_types.find((o) => o.value === "public_trust"));
    assert.deepEqual(res.body.data.uploads.extensions, ["pdf", "jpg", "jpeg", "png"]);
  });
});

let individualRef;
let orgRef;

describe("nomination submission", () => {
  test("saves an individual nomination with a file and a link, and returns a reference number", async () => {
    const payload = individual({
      documents: [
        { title: "वृत्तपत्र कात्रण", doc_type: "newspaper", file_field: "doc_0" },
        { title: "माहितीपट", doc_type: "documentary_link", external_url: "https://youtube.com/watch?v=abcdefghijk" },
        { title: "छायाचित्र", doc_type: "photograph", file_field: "doc_1", external_url: "https://example.com/photo" },
      ],
    });
    const res = await submit(payload, [
      { field: "doc_0", buffer: PDF, name: "cutting.pdf", type: "application/pdf" },
      { field: "doc_1", buffer: await makePhoto(), name: "fort.jpg", type: "image/jpeg" },
    ]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.data.reference_no, /^ASBP26-I-\d{6}$/);
    individualRef = res.body.data.reference_no;

    const { rows } = await pool.query("SELECT n.*, i.full_name FROM award_nominations n JOIN award_individual_nominees i ON i.nomination_id = n.id WHERE reference_no = $1", [individualRef]);
    assert.equal(rows[0].status, "submitted");
    assert.equal(rows[0].full_name, "अनंत देशपांडे");
    const docs = await pool.query("SELECT * FROM award_nomination_documents WHERE nomination_id = $1 ORDER BY sort_order", [rows[0].id]);
    assert.equal(docs.rowCount, 3);
    assert.equal(docs.rows[0].original_name, "cutting.pdf");
    assert.ok(docs.rows[0].storage_key && !docs.rows[0].storage_key.includes("cutting"), "stored under a random name");
    assert.equal(docs.rows[1].storage_key, null);
    const nominator = await pool.query("SELECT * FROM award_nominators WHERE id = $1", [rows[0].nominator_id]);
    assert.equal(nominator.rows[0].mobile, "9876500001");
  });

  test("a retried submit with the same submission_id returns the same receipt", async () => {
    const payload = individual();
    const first = await submit(payload);
    assert.equal(first.status, 201);
    const again = await submit(payload);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.reference_no, first.body.data.reference_no);
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM award_nominations WHERE submission_id = $1", [payload.submission_id]);
    assert.equal(rows[0].n, 1);
  });

  test("saves an organization nomination with officials; PAN is normalised", async () => {
    const res = await submit(organization());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.data.reference_no, /^ASBP26-O-\d{6}$/);
    orgRef = res.body.data.reference_no;
    const { rows } = await pool.query(
      "SELECT o.pan, o.research_tools, (SELECT COUNT(*)::int FROM award_nomination_officials WHERE nomination_id = n.id) AS officials FROM award_nominations n JOIN award_organization_nominees o ON o.nomination_id = n.id WHERE n.reference_no = $1",
      [orgRef],
    );
    assert.equal(rows[0].pan, "ABCDE1234F");
    assert.deepEqual(rows[0].research_tools, ["maps", "photographs"]);
    assert.equal(rows[0].officials, 1);
  });

  test("registration fields are required for registered organization types only", async () => {
    const missing = await submit(organization({ registration_no: "", registration_date: "", registration_authority: "" }));
    assert.equal(missing.status, 400);
    assert.ok(missing.body.error.details.registration_no);
    assert.ok(missing.body.error.details.registration_authority);
    const ngo = await submit(organization({ org_type: "ngo", registration_no: "", registration_date: "", registration_authority: "" }));
    assert.equal(ngo.status, 201, JSON.stringify(ngo.body));
  });

  test("rejects invalid fields with per-field messages", async () => {
    const res = await submit(individual({
      nominator_mobile: "12345", email: "nope", pan: "BAD", work_categories: [], declaration_accepted: false,
    }));
    assert.equal(res.status, 400);
    const d = res.body.error.details;
    for (const k of ["nominator_mobile", "email", "pan", "work_categories", "declaration_accepted"]) {
      assert.ok(d[k], `expected an error for ${k}: ${JSON.stringify(d)}`);
    }
    // cross-field rules (run once the basic fields are valid)
    const cross = await submit(individual({ date_of_birth: "2999-01-01", documents: [{ title: "x" }], work_categories: ["conservation", "other"] }));
    assert.equal(cross.status, 400);
    for (const k of ["date_of_birth", "documents.0.file_field", "work_category_other"]) {
      assert.ok(cross.body.error.details[k], `expected an error for ${k}: ${JSON.stringify(cross.body.error.details)}`);
    }
  });

  test("organization fields are refused on an individual nomination (no mass assignment)", async () => {
    const res = await submit(individual({ status: "selected" }));
    assert.equal(res.status, 400);
  });

  test("rejects a file whose content does not match its extension", async () => {
    const res = await submit(individual({ documents: [{ file_field: "doc_0" }] }), [
      { field: "doc_0", buffer: Buffer.from("<script>alert(1)</script>"), name: "evil.pdf", type: "application/pdf" },
    ]);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.doc_0);
    assert.equal((await pool.query("SELECT 1 FROM award_nominations WHERE nominee_name = 'x'")).rowCount, 0);
  });

  test("rejects disallowed file types", async () => {
    const res = await submit(individual({ documents: [{ file_field: "doc_0" }] }), [
      { field: "doc_0", buffer: Buffer.from("MZ"), name: "setup.exe", type: "application/octet-stream" },
    ]);
    assert.equal(res.status, 400);
  });

  test("confirmation lookup needs the matching mobile and hides review stages", async () => {
    const ok = await request(app).get(`/api/shivdurg-award/nominations/${individualRef}`).query({ mobile: "9876500001" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.status, "submitted");
    const wrong = await request(app).get(`/api/shivdurg-award/nominations/${individualRef}`).query({ mobile: "9000000000" });
    assert.equal(wrong.status, 404);
  });

  test("refuses nominations when the window is closed", async () => {
    await pool.query("UPDATE award_editions SET nominations_enabled = false");
    const res = await submit(individual());
    assert.equal(res.status, 403);
    assert.equal((await request(app).get("/api/shivdurg-award")).body.data.status.reason, "disabled");
    await pool.query("UPDATE award_editions SET nominations_enabled = true");
  });
});

describe("admin award section", () => {
  let indId;
  let orgId;

  test("requires authentication and the award permission", async () => {
    assert.equal((await request(app).get("/api/admin/shivdurg-award/nominations")).status, 401);
    const role = (await pool.query("SELECT id FROM roles WHERE slug = 'moderator'")).rows[0].id;
    const created = await request(app).post("/api/admin/admins").set(auth()).send({ name: "Mod", email: "awardmod@test.local", role_id: role, password: "Moderator123" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mod = (await request(app).post("/api/auth/login").send({ email: "awardmod@test.local", password: "Moderator123" })).body.token;
    assert.equal((await request(app).get("/api/admin/shivdurg-award/nominations").set({ Authorization: `Bearer ${mod}` })).status, 403);
    assert.equal((await request(app).put("/api/admin/shivdurg-award/config").set({ Authorization: `Bearer ${mod}` }).send({})).status, 403);
  });

  test("stats come from the database", async () => {
    const res = await request(app).get("/api/admin/shivdurg-award/stats").set(auth());
    assert.equal(res.status, 200);
    const { rows } = await pool.query("SELECT category, COUNT(*)::int AS n FROM award_nominations GROUP BY category");
    const count = Object.fromEntries(rows.map((r) => [r.category, r.n]));
    assert.equal(res.body.data.totals.individual, count.individual);
    assert.equal(res.body.data.totals.organization, count.organization);
    assert.equal(res.body.data.totals.submitted, count.individual + count.organization);
  });

  test("lists with server-side filters, search and pagination", async () => {
    const all = await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ limit: 2 });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 2);
    assert.ok(all.body.meta.total >= 4);
    const orgs = await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ category: "organization" });
    assert.ok(orgs.body.data.every((r) => r.category === "organization"));
    const byRef = await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ q: individualRef });
    assert.equal(byRef.body.data.length, 1);
    indId = byRef.body.data[0].id;
    const work = await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ work_category: "youth_participation" });
    assert.ok(work.body.data.length >= 1 && work.body.data.every((r) => r.work_categories.includes("youth_participation")));
    orgId = (await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ q: orgRef })).body.data[0].id;
    const dated = await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ from: "2000-01-01", to: "2000-01-02" });
    assert.equal(dated.body.data.length, 0);
  });

  test("detail view includes repeaters, documents (without storage keys) and history", async () => {
    const res = await request(app).get(`/api/admin/shivdurg-award/nominations/${indId}`).set(auth());
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.details.father_or_husband_name, "विष्णु देशपांडे");
    assert.equal(typeof d.details.age, "number");
    assert.equal(d.activities.length, 1);
    assert.equal(d.documents.length, 3);
    assert.equal(d.documents[0].storage_key, undefined);
    assert.equal(d.history[0].to_status, "submitted");
    assert.equal(d.submission_id, undefined);
  });

  test("streams an evidence file to an authorised admin only", async () => {
    const detail = (await request(app).get(`/api/admin/shivdurg-award/nominations/${indId}`).set(auth())).body.data;
    const doc = detail.documents.find((x) => x.has_file);
    const res = await request(app).get(`/api/admin/shivdurg-award/nominations/${indId}/documents/${doc.id}?download=1`).set(auth()).buffer(true);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-disposition"], /attachment/);
    assert.equal(Buffer.compare(Buffer.from(res.body), PDF), 0);
    assert.equal((await request(app).get(`/api/admin/shivdurg-award/nominations/${indId}/documents/${doc.id}`)).status, 401);
    // a document id from another nomination is not reachable through this nomination
    assert.equal((await request(app).get(`/api/admin/shivdurg-award/nominations/${orgId}/documents/${doc.id}`).set(auth())).status, 404);
  });

  test("status workflow enforces transitions, records history and allows one winner per category", async () => {
    const post = (id, body) => request(app).post(`/api/admin/shivdurg-award/nominations/${id}/status`).set(auth()).send(body);
    assert.equal((await post(indId, { status: "selected" })).status, 400, "cannot jump straight to selected");
    assert.equal((await post(indId, { status: "under_review" })).status, 200);
    assert.equal((await post(indId, { status: "shortlisted", remarks: "उत्तम कार्य" })).status, 200);
    const sel = await post(indId, { status: "selected" });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.data.history.length, 4);
    assert.equal(sel.body.data.history[3].admin_name, "Super Admin");

    const other = (await request(app).get("/api/admin/shivdurg-award/nominations").set(auth()).query({ category: "individual", status: "submitted" })).body.data[0];
    await post(other.id, { status: "under_review" });
    await post(other.id, { status: "shortlisted" });
    const second = await post(other.id, { status: "selected" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "WINNER_EXISTS");

    assert.equal((await post(orgId, { status: "not_selected" })).status, 400, "a reason is required");
    assert.equal((await post(orgId, { status: "not_selected", remarks: "निकषात बसत नाही" })).status, 200);
    const logs = await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'award_nomination' AND action = 'status_change'");
    assert.ok(logs.rows[0].n >= 4);
  });

  test("committee remarks are stored with the admin", async () => {
    const res = await request(app).post(`/api/admin/shivdurg-award/nominations/${indId}/remarks`).set(auth()).send({ body: "कागदपत्रे तपासली." });
    assert.equal(res.status, 201);
    const detail = (await request(app).get(`/api/admin/shivdurg-award/nominations/${indId}`).set(auth())).body.data;
    assert.equal(detail.remarks[0].body, "कागदपत्रे तपासली.");
    assert.equal(detail.remarks[0].admin_name, "Super Admin");
  });

  test("exports CSV, Excel and PDF honouring filters", async () => {
    const csv = await request(app).get("/api/admin/shivdurg-award/nominations/export.csv").set(auth()).query({ category: "organization" }).buffer(true);
    assert.equal(csv.status, 200);
    const text = csv.text;
    assert.ok(text.includes(orgRef));
    assert.ok(!text.includes(individualRef));
    const xlsx = await request(app).get("/api/admin/shivdurg-award/nominations/export.xlsx").set(auth()).buffer(true)
      .parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.subarray(0, 2).toString(), "PK");
    const pdf = await request(app).get("/api/admin/shivdurg-award/nominations/export.pdf").set(auth()).buffer(true)
      .parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.subarray(0, 5).toString(), "%PDF-");
  });

  test("configuration changes dates without code changes and is audited", async () => {
    const cfg = (await request(app).get("/api/admin/shivdurg-award/config").set(auth())).body.data;
    const { id, status, created_at, updated_at, updated_by, is_current, ...rest } = cfg;
    const body = { ...rest, nominations_enabled: true, nomination_opens_at: "2020-01-01T00:00:00+05:30", nomination_closes_at: "2020-01-31T23:59:59+05:30" };
    const res = await request(app).put("/api/admin/shivdurg-award/config").set(auth()).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status.reason, "closed");
    assert.equal((await submit(individual())).status, 403);
    const bad = await request(app).put("/api/admin/shivdurg-award/config").set(auth()).send({ ...body, nomination_closes_at: "2019-01-01T00:00:00+05:30" });
    assert.equal(bad.status, 400);
    const logs = await pool.query("SELECT 1 FROM audit_logs WHERE entity = 'award_config'");
    assert.ok(logs.rowCount >= 1);
  });

  test("committee members and winners are managed via the admin and shown publicly", async () => {
    const created = await request(app).post("/api/admin/shivdurg-award/committee").set(auth()).send({ name: "डॉ. सदस्य", designation: "इतिहास अभ्यासक" });
    assert.equal(created.status, 201);
    const pub = await request(app).get("/api/shivdurg-award");
    assert.ok(pub.body.data.committee.find((c) => c.name === "डॉ. सदस्य"));
    const w = await request(app).post("/api/admin/shivdurg-award/winners").set(auth()).send({ name: "नवीन विजेते", category: "individual", year: 2026 });
    assert.equal(w.status, 201);
  });
});
