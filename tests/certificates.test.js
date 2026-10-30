// Certificate numbering, PDF contents and the email queue: uniqueness under concurrency, one email per
// certificate, each participant's own photo and number, retries, permanent failures, crashed workers, volume.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let worker;
let queue;
let registrations;
let loadAsJpeg;
let paths;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
  worker = await import("../src/modules/certificates/certificate.worker.js");
  queue = await import("../src/modules/certificates/certificate.queue.js");
  registrations = await import("../src/modules/registrations/registrations.service.js");
  ({ loadAsJpeg } = await import("../src/services/image.service.js"));
  ({ paths } = await import("../src/config/paths.js"));
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

let phoneSeq = 0;
async function register(fields = {}) {
  phoneSeq += 1;
  const phone = `97${String(phoneSeq).padStart(8, "0")}`;
  const data = { participant_type: "individual", name: `सहभागी ${phoneSeq}`, phone, email: `p${phoneSeq}@test.local`, district_id: "26", fort_id: "2", consent: "true", ...fields };
  const req = request(app).post("/api/registrations");
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  req.attach("photo", await makePhoto(), { filename: "replica.jpg", contentType: "image/jpeg" });
  const res = await req;
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.data, phone, email: data.email };
}

const review = (id, action, note) => request(app).post(`/api/admin/registrations/${id}/review`).set(auth()).send({ action, note });
const bulk = (ids, action = "verify") => request(app).post("/api/admin/registrations/bulk-review").set(auth()).send({ ids, action });

// Fake SMTP: records every message; `fail(msg, n)` may return an error to throw for the n-th call
function mailbox(fail) {
  const sent = [];
  let calls = 0;
  const send = async (msg) => {
    calls += 1;
    const err = fail?.(msg, calls);
    if (err) throw err;
    sent.push(msg);
    return { messageId: `<${sent.length}@test>`, response: "250 2.0.0 OK" };
  };
  return { sent, send };
}

const jobOf = async (registrationId) => (await pool.query(
  `SELECT j.* FROM certificate_email_jobs j JOIN certificates c ON c.id = j.certificate_id WHERE c.registration_id = $1`,
  [registrationId],
)).rows[0];
const certOf = async (registrationId) => (await pool.query("SELECT * FROM certificates WHERE registration_id = $1", [registrationId])).rows[0];
const makeDue = () => pool.query("UPDATE certificate_email_jobs SET run_at = NOW() WHERE status = 'queued'");
const smtpError = (code, responseCode, response) => Object.assign(new Error(response), { code, responseCode, response });

describe("दुर्गवीर numbers", () => {
  let regs;

  test("concurrent and repeated verification gives every participant exactly one unique number", async () => {
    regs = [];
    for (let i = 0; i < 24; i++) regs.push(await register());
    const ids = regs.map((r) => r.id);
    // Overlapping bulk reviews and single reviews of the same registrations, all at once
    const results = await Promise.all([
      bulk(ids.slice(0, 16)), bulk(ids.slice(8, 24)), bulk(ids), bulk([...ids].reverse()),
      ...ids.slice(0, 6).map((id) => review(id, "verify")),
    ]);
    for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

    const { rows } = await pool.query("SELECT registration_id, durgveer_no FROM certificates WHERE registration_id = ANY($1) ORDER BY durgveer_no", [ids]);
    assert.equal(rows.length, 24, "one certificate per registration");
    assert.deepEqual(rows.map((r) => r.durgveer_no), Array.from({ length: 24 }, (_, i) => 10000 + i), "10000…10023, no repeats and no gaps");
    const jobs = await pool.query(
      "SELECT j.status FROM certificate_email_jobs j JOIN certificates c ON c.id = j.certificate_id WHERE c.registration_id = ANY($1)", [ids]);
    assert.equal(jobs.rows.length, 24, "one email job per certificate");
    assert.ok(jobs.rows.every((j) => j.status === "queued"));
  });

  test("the number survives revoke, re-verify and reinstate, and is never reused", async () => {
    const r = regs[0];
    const before = (await certOf(r.id)).durgveer_no;
    await review(r.id, "reject", "चुकीचे छायाचित्र");
    await review(r.id, "verify");
    await request(app).post(`/api/admin/certificates/${r.id}/revoke`).set(auth()).send({ reason: "test revoke" });
    assert.equal((await request(app).post(`/api/admin/certificates/${r.id}/reinstate`).set(auth())).status, 200);
    assert.equal((await certOf(r.id)).durgveer_no, before);

    const fresh = await register();
    await review(fresh.id, "verify");
    assert.equal((await certOf(fresh.id)).durgveer_no, 10024, "re-verifying did not use up numbers");
    const verify = await request(app).get(`/api/certificates/verify/${(await certOf(fresh.id)).certificate_no}`);
    assert.equal(verify.body.data.durgveer_no, 10024);
  });

  test("the database refuses a duplicate number or one below 10000", async () => {
    await assert.rejects(
      pool.query("UPDATE certificates SET durgveer_no = 10000 WHERE durgveer_no = 10001"),
      (err) => err.code === "23505",
    );
    await assert.rejects(
      pool.query("UPDATE certificates SET durgveer_no = 9999 WHERE durgveer_no = 10001"),
      (err) => err.code === "23514",
    );
  });

  test("migration 029 moves numbers issued from 1 up to 10000 in the same order", async () => {
    const fs = await import("node:fs/promises");
    const sql = await fs.readFile(new URL("../migrations/029_durgveer_no_from_10000.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Recreate the state 028 leaves behind: 1, 2, 3 … in issue order, sequence without the 10000 floor
      await client.query("ALTER TABLE certificates DROP CONSTRAINT certificates_durgveer_no_min");
      await client.query("ALTER SEQUENCE certificates_durgveer_no_seq MINVALUE 1 START WITH 1");
      await client.query("UPDATE certificates SET durgveer_no = -durgveer_no");
      await client.query(
        `WITH o AS (SELECT id, ROW_NUMBER() OVER (ORDER BY issued_at, id) AS n FROM certificates)
         UPDATE certificates c SET durgveer_no = o.n FROM o WHERE o.id = c.id`);
      const before = (await client.query("SELECT id, durgveer_no FROM certificates ORDER BY id")).rows;
      await client.query(sql);
      const afterRows = (await client.query("SELECT id, durgveer_no FROM certificates ORDER BY id")).rows;
      assert.deepEqual(afterRows.map((r) => r.durgveer_no), before.map((r) => r.durgveer_no + 9999));
      const next = (await client.query("SELECT nextval('certificates_durgveer_no_seq')::int AS n")).rows[0].n;
      assert.equal(next, before.length + 10000, "the next certificate continues after the highest number");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("certificate email queue", () => {
  test("each participant receives exactly one email with their own photo, number and address", async () => {
    const box = mailbox();
    const totals = await worker.drainQueue({ send: box.send, concurrency: 6 });
    assert.equal(totals.sent, 25);
    assert.equal(box.sent.length, 25);

    const { rows } = await pool.query(
      `SELECT c.registration_id, c.certificate_no, c.durgveer_no, c.emailed_at, r.email, p.image_path
       FROM certificates c JOIN registrations r ON r.id = c.registration_id
       JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1`);
    const photos = new Map();
    for (const c of rows) photos.set(c.registration_id, await loadAsJpeg(c.image_path, 483, 231, "attention"));

    for (const c of rows) {
      const mails = box.sent.filter((m) => m.to === c.email);
      assert.equal(mails.length, 1, `exactly one email to ${c.email}`);
      const [attachment] = mails[0].attachments;
      assert.match(attachment.filename, new RegExp(`${c.certificate_no}\\.pdf$`));
      const pdf = attachment.content;
      assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
      // Number and registration in the PDF's own metadata, and the number in the email text
      assert.ok(pdf.toString("latin1").includes(`${c.certificate_no}, Durgveer ${c.durgveer_no})`), "PDF carries this participant's number");
      assert.ok(mails[0].html.includes(`दुर्गवीर क्रमांक: <b>${String(c.durgveer_no).replace(/\d/g, (d) => "०१२३४५६७८९"[d])}</b>`));
      // The exact photo bytes of this participant are embedded — and nobody else's
      for (const [id, jpeg] of photos) {
        assert.equal(pdf.includes(jpeg), id === c.registration_id, `photo of registration ${id} ${id === c.registration_id ? "missing from" : "found in"} certificate of ${c.registration_id}`);
      }
      assert.ok(c.emailed_at);
    }
    const log = await pool.query("SELECT outcome, pdf_sha256, durgveer_no, photo_id FROM certificate_email_log WHERE outcome = 'sent'");
    assert.equal(log.rows.length, 25);
    assert.ok(log.rows.every((l) => l.pdf_sha256?.length === 64 && l.durgveer_no && l.photo_id));
  });

  test("nothing is sent twice: draining again, re-verifying and bulk 'email pending' find no work", async () => {
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 0);
    const ids = (await pool.query("SELECT registration_id FROM certificates")).rows.map((r) => r.registration_id);
    await bulk(ids);
    const pending = await request(app).post("/api/admin/certificates/send-pending").set(auth());
    assert.equal(pending.body.data.queued, 0);
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 0);
    assert.equal(box.sent.length, 0);
  });

  test("parallel workers split the queue without sending any email twice", async () => {
    const regs = [];
    for (let i = 0; i < 18; i++) regs.push(await register());
    await bulk(regs.map((r) => r.id));
    const box = mailbox();
    const runs = await Promise.all([1, 2, 3].map(() => worker.drainQueue({ send: box.send, concurrency: 4 })));
    assert.equal(runs.reduce((n, t) => n + t.sent, 0), 18);
    assert.equal(new Set(box.sent.map((m) => m.to)).size, 18);
    assert.equal(box.sent.length, 18);
  });

  test("a temporary SMTP error is retried later with backoff, then delivered once", async () => {
    const r = await register();
    await review(r.id, "verify");
    const box = mailbox((msg, n) => n === 1 && smtpError("EMESSAGE", 451, "451 4.3.0 Try again later"));
    assert.equal((await worker.drainQueue({ send: box.send })).retry, 1);
    let job = await jobOf(r.id);
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 1);
    assert.equal(job.last_error_code, "SMTP_451");
    assert.ok(job.run_at > new Date(Date.now() + 30_000), "retry is scheduled in the future");
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 0, "not retried before its time");

    await makeDue();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 1);
    job = await jobOf(r.id);
    assert.equal(job.status, "sent");
    assert.equal(box.sent.length, 1);
    const log = await request(app).get(`/api/admin/certificates/${r.id}/email-log`).set(auth());
    assert.deepEqual(log.body.data.attempts.map((a) => a.outcome), ["sent", "retry"]);
  });

  test("an address the server rejects fails at once; attempts are capped; 'retry failed' starts over", async () => {
    const bad = await register();
    const flaky = await register();
    await bulk([bad.id, flaky.id]);
    const box = mailbox((msg) => {
      if (msg.to === bad.email) return smtpError("EENVELOPE", 550, "550 5.1.1 The email account does not exist");
      if (msg.to === flaky.email) return smtpError("EMESSAGE", 451, "451 4.3.0 Mailbox busy");
      return null;
    });
    for (let i = 0; i < 8; i++) {
      await worker.drainQueue({ send: box.send });
      await makeDue();
    }
    const badJob = await jobOf(bad.id);
    assert.equal(badJob.status, "failed");
    assert.equal(badJob.attempts, 1, "no retries for a rejected address");
    const flakyJob = await jobOf(flaky.id);
    assert.equal(flakyJob.status, "failed");
    assert.equal(flakyJob.attempts, 6, "CERTIFICATE_EMAIL_MAX_ATTEMPTS");

    const retry = await request(app).post("/api/admin/certificates/retry-failed").set(auth());
    assert.equal(retry.body.data.queued, 2);
    const ok = mailbox();
    assert.equal((await worker.drainQueue({ send: ok.send })).sent, 2);
  });

  test("a certificate whose photo cannot be read is not emailed", async () => {
    const r = await register();
    await review(r.id, "verify");
    const { rows } = await pool.query("SELECT image_path FROM registration_photos WHERE registration_id = $1 AND is_current", [r.id]);
    await fs.unlink(path.join(paths.uploads, rows[0].image_path.slice("/uploads/".length)));
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).failed, 1);
    assert.equal(box.sent.length, 0);
    const job = await jobOf(r.id);
    assert.equal(job.status, "failed");
    assert.equal(job.last_error_code, "PHOTO_MISSING");
  });

  test("revoking before delivery cancels the email; verifying again queues it once", async () => {
    const r = await register();
    await review(r.id, "verify");
    await review(r.id, "reject", "प्रतिकृती दिसत नाही");
    assert.equal((await jobOf(r.id)).status, "cancelled");
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 0);

    await review(r.id, "verify");
    await review(r.id, "verify");
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 1);
    assert.equal(box.sent.length, 1);
  });

  test("registrations without a usable email are skipped (SMS link only)", async () => {
    const r = await register({ email: "" });
    const placeholder = await register({ email: "someone@example.com" });
    await bulk([r.id, placeholder.id]);
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).skipped, 2);
    assert.equal((await jobOf(r.id)).status, "skipped");
    assert.equal(box.sent.length, 0);
  });

  test("a job whose worker died is retried after its lease expires; the dead worker cannot overwrite it", async () => {
    const r = await register();
    await review(r.id, "verify");
    const [job] = await queue.claimDue(1, "crashed-worker");
    assert.equal(job.certificate_id, (await certOf(r.id)).id);
    await pool.query("UPDATE certificate_email_jobs SET locked_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [job.id]);
    assert.equal(await queue.reapExpiredLeases(10, 6, "test"), 1);
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 1);
    const late = await queue.finishJob(job, "crashed-worker", { status: "failed" }, { outcome: "failed", error_code: "LATE" });
    assert.equal(late, false);
    assert.equal((await jobOf(r.id)).status, "sent");
  });

  test("resend sends one more copy even when clicked repeatedly; revoked certificates cannot be resent", async () => {
    const [{ registration_id: id }] = (await pool.query(
      "SELECT c.registration_id FROM certificates c JOIN certificate_email_jobs j ON j.certificate_id = c.id WHERE j.status = 'sent' LIMIT 1")).rows;
    const clicks = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/admin/certificates/${id}/resend`).set(auth())));
    for (const c of clicks) assert.equal(c.body.data.status, "queued");
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 1);
    assert.equal((await jobOf(id)).sent_count, 2);

    await review(id, "reject", "रद्द");
    assert.equal((await request(app).post(`/api/admin/certificates/${id}/resend`).set(auth())).status, 409);
  });

  test("admin list, filters, दुर्गवीर search and queue stats", async () => {
    const failed = await request(app).get("/api/admin/certificates?email_status=failed").set(auth());
    assert.equal(failed.status, 200);
    assert.ok(failed.body.data.length >= 1);
    assert.ok(failed.body.data.every((c) => c.email_status === "failed" && c.email_error_code));

    const byNumber = await request(app).get("/api/admin/certificates").query({ q: "१००२४" }).set(auth());
    assert.ok(byNumber.body.data.some((c) => c.durgveer_no === 10024));

    const stats = await request(app).get("/api/admin/certificates/email-queue").set(auth());
    assert.equal(stats.status, 200);
    assert.ok(stats.body.data.sent >= 40);
    assert.ok(stats.body.data.failed >= 1);
    assert.equal(stats.body.data.mail_enabled, false);
  });
});

describe("volume", () => {
  test("10,000 registrations verified by 50 concurrent bulk reviews get 10,000 unique numbers and one job each", async () => {
    const { rows: [admin] } = await pool.query("SELECT id FROM admins LIMIT 1");
    const { rows: [photo] } = await pool.query("SELECT image_path, thumb_path FROM registration_photos WHERE is_current LIMIT 1");
    const { rows } = await pool.query(
      `INSERT INTO registrations (participant_type, name, phone, email, district_id, source)
       SELECT 'individual', 'भार चाचणी ' || g, '9' || LPAD(g::text, 9, '0'), 'load' || g || '@test.local', 26, 'admin'
       FROM generate_series(1, 10000) g RETURNING id`);
    const ids = rows.map((r) => r.id);
    await pool.query(
      `INSERT INTO registration_photos (registration_id, image_path, thumb_path, position)
       SELECT id, $2, $3, 1 FROM UNNEST($1::int[]) id`, [ids, photo.image_path, photo.thumb_path]);
    const before = (await pool.query("SELECT COALESCE(MAX(durgveer_no), 0) AS n FROM certificates")).rows[0].n;

    const batches = [];
    for (let i = 0; i < ids.length; i += 200) batches.push(ids.slice(i, i + 200));
    const started = Date.now();
    await Promise.all(batches.map((b) => registrations.review(b, "verify", null, admin.id, null)));
    const ms = Date.now() - started;

    const check = await pool.query(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT durgveer_no)::int AS distinct_no, MIN(durgveer_no) AS lo, MAX(durgveer_no) AS hi,
              COUNT(j.id)::int AS jobs
       FROM certificates c LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id
       WHERE c.registration_id = ANY($1)`, [ids]);
    const c = check.rows[0];
    assert.equal(c.n, 10000);
    assert.equal(c.distinct_no, 10000);
    assert.equal(c.jobs, 10000);
    assert.equal(c.lo, before + 1);
    assert.equal(c.hi, before + 10000, "contiguous");
    console.log(`  verified 10,000 in ${ms} ms`);

    // Deliver a slice end to end and time it
    await pool.query(
      `UPDATE certificate_email_jobs SET status = 'cancelled' WHERE status = 'queued'
       AND certificate_id NOT IN (SELECT id FROM certificates WHERE registration_id = ANY($1))`, [ids.slice(0, 300)]);
    const box = mailbox();
    const t = Date.now();
    const totals = await worker.drainQueue({ send: box.send, concurrency: 8 });
    const elapsed = Date.now() - t;
    assert.equal(totals.sent, 300);
    assert.equal(new Set(box.sent.map((m) => m.to)).size, 300);
    console.log(`  rendered + queued 300 emails in ${elapsed} ms (${Math.round(300_000 / elapsed)}/s in one process)`);
  });
});
