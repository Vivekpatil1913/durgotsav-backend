// SRS v2.1 with the certificate-after-approval rule: single-page form, the certificate generated only when an admin
// approves, any number of registrations per mobile, paginated mobile lookup with PDF / image / "download all",
// participant links, CAPTCHA gate, SMS through a durable queue, admin regenerate / manual SMS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { NUMBER_PREFIX } from "../src/config/edition.js";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let env;
let smsWorker;
let smsQueue;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
  ({ env } = await import("../src/config/env.js"));
  smsWorker = await import("../src/modules/sms/sms.worker.js");
  smsQueue = await import("../src/modules/sms/sms.queue.js");
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

// Exactly what the website's single-page form sends
async function register(fields = {}, { photo, captcha } = {}) {
  const req = request(app).post("/api/registrations");
  const data = { name: "पाटील परिवार", phone: "9890000001", district_id: "26", consent: "true", ...fields };
  if (captcha !== undefined) data.captcha_token = captcha;
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  req.attach("photo", photo ?? (await makePhoto()), { filename: "replica.jpg", contentType: "image/jpeg" });
  return req;
}
const review = (id, action, note) => request(app).post(`/api/admin/registrations/${id}/review`).set(auth()).send({ action, note });

const binary = (req) => req.buffer(true).parse((r, cb) => {
  const chunks = [];
  r.on("data", (c) => chunks.push(c));
  r.on("end", () => cb(null, Buffer.concat(chunks)));
});
const pageCount = (pdf) => (pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? []).length;
const countFor = async (phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM registrations WHERE phone = $1", [phone])).rows[0].n;
const certOf = async (id) => (await pool.query("SELECT * FROM certificates WHERE registration_id = $1", [id])).rows[0];
const smsOf = async (id, purpose) =>
  (await pool.query("SELECT * FROM sms_messages WHERE registration_id = $1 AND purpose = $2 ORDER BY id", [id, purpose])).rows;

describe("single-page form; the certificate only after an admin approves", () => {
  let first;

  test("name, mobile, district and photo are enough; the registration waits for review with no certificate", async () => {
    const res = await register();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    first = res.body.data;
    assert.equal(first.status, "pending");
    assert.match(first.token, /^[0-9a-z]+\.[\w-]{16}$/, "the participant's own status link");
    assert.equal(first.certificate, undefined);
    assert.equal(await certOf(first.id), undefined, "no certificate before approval");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM certificate_email_jobs")).rows[0].n, 0);

    const { rows: [r] } = await pool.query("SELECT participant_type, email, taluka_id, fort_id, division_id FROM registrations WHERE id = $1", [first.id]);
    assert.equal(r.participant_type, null, "not asked any more");
    assert.equal(r.email, null);
    assert.ok(r.division_id, "division still derived from the district (admin scope)");
    assert.equal(r.taluka_id, null);
    assert.equal(r.fort_id, null);
  });

  test("the participant link shows 'pending'; nothing downloads yet", async () => {
    const link = await request(app).get(`/api/certificates/link/${first.token}`);
    assert.equal(link.status, 200);
    assert.equal(link.body.data.status, "pending");
    assert.equal(link.body.data.certificate_available, false);
    assert.equal(link.body.data.certificate_no, null);
    const dl = await request(app).get(`/api/certificates/link/${first.token}/download`);
    assert.equal(dl.status, 409);
    assert.equal(dl.body.error.code, "NOT_VERIFIED");
    const status = await request(app).get("/api/registrations/status").query({ registration: first.registration_no, phone: "9890000001" });
    assert.equal(status.body.data.certificate_available, false);
  });

  test("district and consent stay required; the email, when given, must be valid", async () => {
    const noDistrict = await register({ phone: "9890000002", district_id: "" });
    assert.equal(noDistrict.status, 400);
    assert.ok(noDistrict.body.error.details.district_id);
    const res = await register({ phone: "9890000002", consent: "false", email: "not-an-email" });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.consent);
    assert.ok(res.body.error.details.email);
    assert.equal(await countFor("9890000002"), 0);
  });

  test("approval generates the certificate and queues its email and SMS; it downloads as PDF and 2400×1712 image", async () => {
    const res = await review(first.id, "verify");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "verified");
    const cert = await certOf(first.id);
    assert.equal(cert.certificate_no, `AMRUT-${NUMBER_PREFIX}-${String(first.id).padStart(6, "0")}`);
    assert.equal(cert.durgveer_no, 10000);
    assert.equal(cert.revoked_at, null);
    const { rows: [job] } = await pool.query("SELECT reason, status FROM certificate_email_jobs WHERE certificate_id = $1", [cert.id]);
    // This participant gave no email address: the job is recorded as skipped at once, without a worker round trip
    assert.deepEqual(job, { reason: "verify", status: "skipped" });
    const [smsRow] = await smsOf(first.id, "certificate_link");
    assert.equal(smsRow.status, "queued");
    assert.ok(smsRow.message.includes(`/c/${first.token}`));

    const link = await request(app).get(`/api/certificates/link/${first.token}`);
    assert.equal(link.body.data.certificate_available, true);
    assert.equal(link.body.data.durgveer_no, 10000);
    const pdf = await binary(request(app).get(`/api/certificates/link/${first.token}/download`));
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.equal(pdf.body.subarray(0, 5).toString(), "%PDF-");
    const jpg = await binary(request(app).get(`/api/certificates/link/${first.token}/download`).query({ format: "jpg" }));
    assert.equal(jpg.headers["content-type"], "image/jpeg");
    const meta = await sharp(jpg.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 2400, 1712]);
    assert.equal((await certOf(first.id)).download_count, 2);
    assert.equal((await request(app).get(`/api/certificates/verify/${cert.certificate_no.toLowerCase()}`)).body.data.valid, true, "verification by number, any case");
  });

  test("approving again queues no second certificate, email or SMS", async () => {
    await review(first.id, "verify");
    assert.equal((await smsOf(first.id, "certificate_link")).length, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM certificates")).rows[0].n, 1);
  });

  test("a rejected registration never gets a certificate", async () => {
    const r = (await register({ phone: "9890000004", name: "नाकारलेली नोंदणी" })).body.data;
    assert.equal((await review(r.id, "reject", "प्रतिकृती दिसत नाही")).status, 200);
    assert.equal(await certOf(r.id), undefined);
    const dl = await request(app).get(`/api/certificates/link/${r.token}/download`);
    assert.equal(dl.status, 409);
    assert.equal(dl.body.error.code, "NOT_AVAILABLE");
    const link = await request(app).get(`/api/certificates/link/${r.token}`);
    assert.equal(link.body.data.status, "rejected");
    assert.equal(link.body.data.note, "प्रतिकृती दिसत नाही");
  });

  test("rejecting after approval withdraws the certificate and cancels its unsent SMS", async () => {
    const r = (await register({ phone: "9890000005" })).body.data;
    await review(r.id, "verify");
    assert.equal((await smsOf(r.id, "certificate_link"))[0].status, "queued");
    await review(r.id, "reject", "बनावट छायाचित्र");
    assert.ok((await certOf(r.id)).revoked_at);
    assert.equal((await smsOf(r.id, "certificate_link"))[0].status, "cancelled");
    assert.equal((await request(app).get(`/api/certificates/link/${r.token}/download`)).status, 409);
    // approving again reinstates the same certificate, same दुर्गवीर number
    const number = (await certOf(r.id)).durgveer_no;
    await review(r.id, "verify");
    assert.equal((await certOf(r.id)).revoked_at, null);
    assert.equal((await certOf(r.id)).durgveer_no, number);
  });

  test("moving an approved registration back to pending withdraws its certificate", async () => {
    const r = (await register({ phone: "9890000006" })).body.data;
    await review(r.id, "verify");
    await review(r.id, "reset");
    assert.ok((await certOf(r.id)).revoked_at);
    assert.equal((await request(app).get(`/api/certificates/link/${r.token}`)).body.data.certificate_available, false);
  });

  test("forged or malformed links are refused", async () => {
    const [id, sig] = first.token.split(".");
    const forged = `${id}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    assert.equal((await request(app).get(`/api/certificates/link/${forged}`)).status, 404);
    const other = `${(first.id + 1).toString(36)}.${sig}`;
    assert.equal((await request(app).get(`/api/certificates/link/${other}/download`)).status, 404, "a signature is bound to one registration");
    assert.equal((await request(app).get("/api/certificates/link/not-a-token")).status, 400);
  });

  test("a retried submission returns the same registration", async () => {
    const submission = "6f1c1f0e-9d1a-4c55-8f53-1c2b3d4e5f60";
    const a = await register({ phone: "9890000003", submission_id: submission });
    const b = await register({ phone: "9890000003", submission_id: submission });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.data.id, a.body.data.id);
    assert.equal(b.body.data.token, a.body.data.token);
    assert.equal(await countFor("9890000003"), 1);
    assert.equal((await smsOf(a.body.data.id, "registration_ack")).length, 1, "one acknowledgment SMS");
  });
});

describe("any number of registrations per mobile number", () => {
  const phone = "9890000010";
  const TOTAL = 27;

  test(`${TOTAL} registrations with one number all go through, also when sent at the same time`, async () => {
    for (let i = 0; i < 12; i++) assert.equal((await register({ phone, name: `सहभागी ${i + 1}` })).status, 201);
    const photos = await Promise.all(Array.from({ length: TOTAL - 12 }, () => makePhoto()));
    const results = await Promise.all(photos.map((photo, i) => register({ phone, name: `एकाचवेळी ${i + 1}` }, { photo })));
    assert.deepEqual([...new Set(results.map((r) => r.status))], [201], JSON.stringify(results.map((r) => r.body.error?.code ?? r.status)));
    assert.equal(await countFor(phone), TOTAL);
  });

  test("the admin detail lists the newest 20 other registrations of the number and counts all", async () => {
    const { rows: [r] } = await pool.query("SELECT id FROM registrations WHERE phone = $1 ORDER BY id LIMIT 1", [phone]);
    const detail = (await request(app).get(`/api/admin/registrations/${r.id}`).set(auth())).body.data;
    assert.equal(detail.same_phone_registrations.length, 20);
    assert.equal(detail.same_phone_total, TOTAL - 1);
    assert.ok(detail.participant_link.includes("/c/"));
  });
});

describe("mobile-number lookup, page by page, and download all", () => {
  const phone = "9890000010";
  let firstPage;

  test("the first page (CAPTCHA) shows the newest 20, the total, and a lookup token for the rest", async () => {
    const res = await request(app).post("/api/certificates/lookup").send({ phone });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    firstPage = res.body;
    assert.equal(firstPage.data.length, 20);
    assert.equal(firstPage.meta.total, 27);
    assert.ok(firstPage.meta.next_before);
    assert.match(firstPage.meta.lookup_token, /^9890000010\.[0-9a-z]+\.[\w-]{16}$/);
    const ids = firstPage.data.map((r) => Number(r.registration_no.slice(-6)));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "newest first");
    assert.equal(firstPage.data.find((r) => r.phone), undefined, "the number itself is not echoed");
  });

  test("the next page comes with the lookup token, no CAPTCHA; together they cover every registration once", async () => {
    const res = await request(app).get("/api/certificates/lookup").query({ lookup_token: firstPage.meta.lookup_token, before: firstPage.meta.next_before });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 7);
    assert.equal(res.body.meta.next_before, null);
    const all = [...firstPage.data, ...res.body.data].map((r) => r.registration_no);
    assert.equal(new Set(all).size, 27);
  });

  test("a forged or expired lookup token is refused", async () => {
    const forged = firstPage.meta.lookup_token.replace("9890000010", "9890000001");
    assert.equal((await request(app).get("/api/certificates/lookup").query({ lookup_token: forged, before: 99999 })).status, 401);
    const { lookupToken } = await import("../src/modules/certificates/certificate.links.js");
    const expired = lookupToken(phone, Date.now() - 31 * 60_000);
    const res = await request(app).get("/api/certificates/lookup").query({ lookup_token: expired, before: 99999 });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "LOOKUP_EXPIRED");
    assert.equal((await request(app).get("/api/certificates/lookup").query({ before: 99999 })).status, 400);
  });

  test("only approved registrations offer certificates; 'download all' is one PDF of the approved ones", async () => {
    const page = firstPage.data.slice(0, 5);
    const ids = page.map((r) => Number(r.registration_no.slice(-6)));
    await request(app).post("/api/admin/registrations/bulk-review").set(auth()).send({ ids: ids.slice(0, 3), action: "verify" });
    const fresh = (await request(app).post("/api/certificates/lookup").send({ phone })).body.data.slice(0, 5);
    assert.deepEqual(fresh.map((r) => r.certificate_available), [true, true, true, false, false]);
    assert.ok(fresh.every((r) => r.token), "every registration has its status link");
    const res = await binary(request(app).get("/api/certificates/bundle").query({ tokens: fresh.map((r) => r.token).join(",") }));
    assert.equal(res.status, 200);
    assert.equal(pageCount(res.body), 3, "pending ones are left out");
    assert.equal((await request(app).get("/api/certificates/bundle").query({ tokens: Array(21).fill(fresh[0].token).join(",") })).status, 400);
    assert.equal((await request(app).get("/api/certificates/bundle").query({ tokens: "zz.AAAAAAAAAAAAAAAA" })).status, 404);
  });

  test("an unknown number gives an empty list; an invalid one is a validation error", async () => {
    const empty = await request(app).post("/api/certificates/lookup").send({ phone: "9000000000" });
    assert.deepEqual([empty.body.data, empty.body.meta.total, empty.body.meta.next_before], [[], 0, null]);
    assert.equal((await request(app).post("/api/certificates/lookup").send({ phone: "12345" })).status, 400);
  });
});

describe("'I am not a robot' (CAPTCHA)", () => {
  const realFetch = globalThis.fetch;
  let answer;
  let calls;

  before(() => {
    env.CAPTCHA_PROVIDER = "recaptcha";
    env.CAPTCHA_SITE_KEY = "site-key";
    env.CAPTCHA_SECRET_KEY = "secret-key";
    calls = [];
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("recaptcha")) return realFetch(url, init);
      calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body.toString())) });
      return answer();
    };
  });
  after(() => {
    env.CAPTCHA_PROVIDER = "off";
    globalThis.fetch = realFetch;
  });
  const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

  test("the website is told which widget to draw", async () => {
    const res = await request(app).get("/api/settings");
    assert.deepEqual(res.body.data.captcha, { provider: "recaptcha", site_key: "site-key" });
    assert.equal(res.body.data.max_registrations_per_mobile, undefined, "no per-mobile limit any more");
  });

  test("without a token nothing is processed or stored", async () => {
    answer = ok;
    const res = await register({ phone: "9890000030" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "CAPTCHA_REQUIRED");
    assert.ok(res.body.error.details.captcha);
    assert.equal(calls.length, 0, "the provider is not even asked");
    assert.equal(await countFor("9890000030"), 0);
  });

  test("a token the provider rejects is refused; a provider outage fails closed", async () => {
    answer = () => new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), { status: 200 });
    const failed = await register({ phone: "9890000030" }, { captcha: "used-token" });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error.code, "CAPTCHA_FAILED");

    answer = () => { throw new TypeError("fetch failed"); };
    const down = await register({ phone: "9890000030" }, { captcha: "fresh-token" });
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, "CAPTCHA_UNAVAILABLE");
    assert.equal(await countFor("9890000030"), 0);
  });

  test("a verified token lets the registration through; the provider gets secret, token and client IP", async () => {
    answer = ok;
    calls.length = 0;
    const res = await register({ phone: "9890000030" }, { captcha: "good-token" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.google.com/recaptcha/api/siteverify");
    assert.equal(calls[0].body.secret, "secret-key");
    assert.equal(calls[0].body.response, "good-token");
    assert.ok(calls[0].body.remoteip);
  });

  test("the first lookup page needs the CAPTCHA, the following pages the lookup token", async () => {
    answer = ok;
    assert.equal((await request(app).post("/api/certificates/lookup").send({ phone: "9890000030" })).status, 400);
    const res = await request(app).post("/api/certificates/lookup").send({ phone: "9890000030", captcha_token: "good-token" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
  });

  test("dummy: a tick is still required, but no provider is asked", async () => {
    env.CAPTCHA_PROVIDER = "dummy";
    try {
      calls.length = 0;
      assert.equal((await request(app).get("/api/settings")).body.data.captcha.provider, "dummy");
      assert.equal((await request(app).post("/api/certificates/lookup").send({ phone: "9890000030" })).status, 400);
      const res = await request(app).post("/api/certificates/lookup").send({ phone: "9890000030", captcha_token: "dummy-1" });
      assert.equal(res.status, 200);
      assert.equal(calls.length, 0);
    } finally {
      env.CAPTCHA_PROVIDER = "recaptcha";
    }
  });

  test("production starts with dummy (no keys); Google / Cloudflare without keys is refused", () => {
    const start = (provider) => spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/config/env.js')"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, NODE_ENV: "production", CAPTCHA_PROVIDER: provider, CAPTCHA_SITE_KEY: "", CAPTCHA_SECRET_KEY: "", PARTICIPANT_IMAGE_STORAGE: "local", AWARD_DOCUMENT_STORAGE: "local" },
      encoding: "utf8",
    });
    const dummy = start("dummy");
    assert.equal(dummy.status, 0, dummy.stderr);
    const recaptcha = start("recaptcha");
    assert.notEqual(recaptcha.status, 0);
    assert.match(recaptcha.stderr, /CAPTCHA_SITE_KEY and CAPTCHA_SECRET_KEY are required in production/);
  });
});

describe("SMS queue (background worker) and admin tools", () => {
  let reg;
  const failing = async () => ({ provider: "http", status: "failed", response: "503", error: "SMS gateway answered HTTP 503" });

  before(async () => {
    await smsWorker.drainSms(); // whatever the earlier tests queued
  });

  test("the acknowledgment SMS is queued with the registration and sent by the worker", async () => {
    reg = (await register({ phone: "9890000040", email: "sms@test.local" })).body.data;
    const [queued] = await smsOf(reg.id, "registration_ack");
    assert.equal(queued.status, "queued");
    assert.ok(queued.message.includes(reg.registration_no));
    assert.ok(queued.message.includes(`/c/${reg.token}`));
    const totals = await smsWorker.drainSms();
    assert.equal(totals.logged, 1, JSON.stringify(totals));
    const [sent] = await smsOf(reg.id, "registration_ack");
    assert.equal(sent.status, "logged", "SMS_DRIVER=log in tests");
    assert.ok(sent.sent_at);
    assert.equal(sent.attempts, 1);
  });

  test("the approval SMS goes out once; a failing gateway is retried with backoff, then marked failed", async () => {
    const maxAttempts = env.SMS_MAX_ATTEMPTS;
    env.SMS_MAX_ATTEMPTS = 2;
    try {
      await review(reg.id, "verify");
      assert.equal((await smsWorker.drainSms({ send: failing })).queued, 1);
      let [row] = await smsOf(reg.id, "certificate_link");
      assert.equal(row.status, "queued");
      assert.ok(row.run_at > new Date(Date.now() + 30_000), "retry is scheduled later");
      assert.equal((await smsWorker.drainSms({ send: failing })).queued, 0, "not retried before its time");
      await pool.query("UPDATE sms_messages SET run_at = NOW() WHERE id = $1", [row.id]);
      assert.equal((await smsWorker.drainSms({ send: failing })).failed, 1);
      [row] = await smsOf(reg.id, "certificate_link");
      assert.deepEqual([row.status, row.attempts], ["failed", 2]);
      assert.match(row.error, /503/);
    } finally {
      env.SMS_MAX_ATTEMPTS = maxAttempts;
    }
  });

  test("an SMS whose certificate was withdrawn before it went out is cancelled by the worker", async () => {
    const r = (await register({ phone: "9890000041" })).body.data;
    await review(r.id, "verify");
    await request(app).post(`/api/admin/certificates/${r.id}/revoke`).set(auth()).send({ reason: "चूक" });
    await smsWorker.drainSms();
    const [row] = await smsOf(r.id, "certificate_link");
    assert.deepEqual([row.status, row.error], ["cancelled", "NO_CERTIFICATE"]);
  });

  test("an SMS whose worker died mid-send is sent again once its lease expires", async () => {
    const r = (await register({ phone: "9890000042" })).body.data;
    const [job] = await smsQueue.claimDue(1, "crashed-worker");
    assert.equal(job.registration_id, r.id);
    assert.equal(await smsQueue.reapExpired(5, 5), 0, "lease still valid");
    await pool.query("UPDATE sms_messages SET locked_at = NOW() - INTERVAL '6 minutes' WHERE id = $1", [job.id]);
    assert.equal(await smsQueue.reapExpired(5, 5), 1);
    assert.equal((await smsWorker.drainSms()).logged, 1);
    assert.equal(await smsQueue.finish(job, "crashed-worker", { status: "failed" }), false, "the dead worker cannot overwrite it");
    assert.equal((await smsOf(r.id, "registration_ack"))[0].status, "logged");
  });

  test("an admin can queue the certificate SMS again; the detail shows the SMS history and the participant link", async () => {
    const res = await request(app).post(`/api/admin/registrations/${reg.id}/sms`).set(auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, "queued");
    await smsWorker.drainSms();
    const detail = (await request(app).get(`/api/admin/registrations/${reg.id}`).set(auth())).body.data;
    assert.equal(detail.sms[0].status, "logged");
    assert.equal(detail.sms[0].requested_by_name, "Super Admin");
    assert.equal(detail.sms.length, 3, "acknowledgment, failed approval SMS, manual SMS");
    assert.ok(detail.participant_link.endsWith(`/c/${reg.token}`));
  });

  test("a corrected name is printed after 'Regenerate certificate'", async () => {
    const fixed = await request(app).put(`/api/admin/registrations/${reg.id}`).set(auth()).send({ name: "सुधारित नाव" });
    assert.equal(fixed.status, 200);
    const before = (await certOf(reg.id)).durgveer_no;
    const res = await request(app).post(`/api/admin/registrations/${reg.id}/certificate/regenerate`).set(auth());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.certificate.regenerated_at);
    assert.equal(res.body.data.certificate.durgveer_no, before, "keeps its number");
    assert.equal((await request(app).get(`/api/certificates/link/${reg.token}`)).body.data.name, "सुधारित नाव");
  });

  test("pending and rejected registrations get neither a certificate nor a certificate SMS from the admin tools", async () => {
    const pending = (await register({ phone: "9890000043" })).body.data;
    const regen = await request(app).post(`/api/admin/registrations/${pending.id}/certificate/regenerate`).set(auth());
    assert.equal(regen.status, 409);
    assert.equal(regen.body.error.code, "NOT_CERTIFIABLE");
    assert.equal((await request(app).post(`/api/admin/registrations/${pending.id}/sms`).set(auth())).status, 409);
    await review(reg.id, "reject", "बनावट छायाचित्र");
    assert.equal((await request(app).post(`/api/admin/registrations/${reg.id}/certificate/regenerate`).set(auth())).status, 409);
    assert.equal(await certOf(pending.id), undefined);
  });

  test("the CSV export has the complete record", async () => {
    const csv = await request(app).get("/api/admin/registrations/export.csv").set(auth());
    assert.equal(csv.status, 200);
    const header = csv.text.replace(/^﻿/, "").split("\n")[0].split(",");
    for (const col of ["registration_no", "name", "phone", "email", "district", "status", "certificate_no", "durgveer_no", "created_at"]) {
      assert.ok(header.includes(col), `${col} column`);
    }
  });
});
