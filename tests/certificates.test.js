// Certificate numbering, PDF contents and the email queue: uniqueness under concurrency, one email per
// certificate, each participant's own photo and number, retries, permanent failures, crashed workers, volume.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
let worker;
let queue;
let certificates;
let certificateToken;
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
  certificates = await import("../src/modules/certificates/certificates.service.js");
  ({ certificateToken } = await import("../src/modules/certificates/certificate.links.js"));
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
const list = (query) => request(app).get("/api/admin/certificates").query(query).set(auth());
const binary = (req) => req.buffer(true).parse((r, cb) => {
  const chunks = [];
  r.on("data", (c) => chunks.push(c));
  r.on("end", () => cb(null, Buffer.concat(chunks)));
});

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
    const { done } = await queue.queuePending(null);
    assert.equal(await done, 0);
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 0);
    assert.equal(box.sent.length, 0);
  });

  test("'Email pending' answers at once and queues in the background, one run at a time across instances", async () => {
    // A run elsewhere holds the lock: this one is refused, by the admin route and in-process alike
    const elsewhere = await pool.connect();
    try {
      await elsewhere.query("SELECT pg_advisory_lock(hashtext('certificates:queue-pending'))");
      const refused = await request(app).post("/api/admin/certificates/send-pending").set(auth());
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "ALREADY_RUNNING");
      await assert.rejects(queue.queuePending(null), (err) => err.status === 409 && err.code === "ALREADY_RUNNING");
    } finally {
      await elsewhere.query("SELECT pg_advisory_unlock(hashtext('certificates:queue-pending'))");
      elsewhere.release();
    }

    // A certificate from before the email queue existed (no job yet) is picked up
    const r = await register();
    await review(r.id, "verify");
    await pool.query("DELETE FROM certificate_email_jobs WHERE certificate_id = $1", [(await certOf(r.id)).id]);
    const started = await request(app).post("/api/admin/certificates/send-pending").set(auth());
    assert.equal(started.status, 202);
    assert.equal(started.body.data.status, "started");
    // Audited with its count once the walk has finished
    let entry;
    for (let i = 0; i < 250 && !entry; i++) {
      [entry] = (await pool.query("SELECT meta FROM audit_logs WHERE action = 'send_pending' ORDER BY id DESC LIMIT 1")).rows;
      if (!entry) await sleep(20);
    }
    assert.deepEqual(entry?.meta, { count: 1 });
    assert.deepEqual(await jobOf(r.id).then((j) => [j.status, j.reason]), ["queued", "pending"]);
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).sent, 1);
    assert.deepEqual(box.sent.map((m) => m.to), [r.email]);
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

  test("an address the server rejects fails at once and is tried again only once corrected; attempts are capped; 'retry failed' starts over", async () => {
    const [bad, bad2, flaky] = [await register(), await register(), await register()];
    await bulk([bad.id, bad2.id, flaky.id]);
    const rejected = (msg) => [bad.email, bad2.email].includes(msg.to) && smtpError("EENVELOPE", 550, "550 5.1.1 The email account does not exist");
    const box = mailbox((msg) => rejected(msg) || (msg.to === flaky.email && smtpError("EMESSAGE", 451, "451 4.3.0 Mailbox busy")));
    for (let i = 0; i < 8; i++) {
      await worker.drainQueue({ send: box.send });
      await makeDue();
    }
    const badJob = await jobOf(bad.id);
    assert.equal(badJob.status, "failed");
    assert.equal(badJob.attempts, 1, "no retries for a rejected address");
    assert.equal(badJob.last_error_code, "RECIPIENT_SMTP_550", "recorded as a rejected address");
    const flakyJob = await jobOf(flaky.id);
    assert.equal(flakyJob.status, "failed");
    assert.equal(flakyJob.attempts, 6, "CERTIFICATE_EMAIL_MAX_ATTEMPTS");
    assert.equal(flakyJob.last_error_code, "SMTP_451");
    // The queue stats tell the admin page how many of the failed a plain retry leaves alone
    const stats = (await request(app).get("/api/admin/certificates/email-queue").set(auth())).body.data;
    assert.deepEqual([stats.failed, stats.rejected], [3, 2]);

    // 'Retry failed' starts the others over; neither it nor 'Email pending' sends to a rejected address again
    const retry = await request(app).post("/api/admin/certificates/retry-failed").set(auth());
    assert.equal(retry.body.data.queued, 1);
    assert.equal(await (await queue.queuePending(null)).done, 0);
    const ok = mailbox();
    assert.equal((await worker.drainQueue({ send: ok.send })).sent, 1);
    assert.deepEqual(ok.sent.map((m) => m.to), [flaky.email]);
    assert.equal((await jobOf(bad.id)).status, "failed");

    // ... unless asked to (e.g. a block on the sender has been lifted) ...
    const forced = await request(app).post("/api/admin/certificates/retry-failed").set(auth()).send({ include_rejected: true });
    assert.equal(forced.body.data.queued, 2);
    assert.equal((await worker.drainQueue({ send: mailbox(rejected).send })).failed, 2);

    // ... or once the address has been corrected
    await pool.query("UPDATE registrations SET email = 'fixed-' || email WHERE id = $1", [bad.id]);
    const corrected = (await request(app).get("/api/admin/certificates/email-queue").set(auth())).body.data;
    assert.deepEqual([corrected.failed, corrected.rejected], [2, 1], "a corrected address no longer counts as rejected");
    assert.equal((await request(app).post("/api/admin/certificates/retry-failed").set(auth())).body.data.queued, 1);
    await pool.query("UPDATE registrations SET email = 'fixed-' || email WHERE id = $1", [bad2.id]);
    assert.equal(await (await queue.queuePending(null)).done, 1);
    assert.equal((await worker.drainQueue({ send: ok.send })).sent, 2);
    assert.deepEqual(ok.sent.slice(1).map((m) => m.to).sort(), [`fixed-${bad.email}`, `fixed-${bad2.email}`].sort());
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

  test("registrations without a usable email get their job as 'skipped' at approval, with no worker round trip (SMS link only)", async () => {
    const r = await register({ email: "" });
    const placeholder = await register({ email: "someone@example.com" });
    await bulk([r.id, placeholder.id]);
    for (const id of [r.id, placeholder.id]) {
      const job = await jobOf(id);
      assert.deepEqual([job.status, job.last_error_code, job.attempts], ["skipped", "NO_EMAIL", 0]);
    }
    const log = await pool.query(
      "SELECT l.id FROM certificate_email_log l JOIN certificates c ON c.id = l.certificate_id WHERE c.registration_id = ANY($1)",
      [[r.id, placeholder.id]]);
    assert.equal(log.rows.length, 0, "no delivery attempt was logged");
    const box = mailbox();
    assert.equal((await worker.drainQueue({ send: box.send })).skipped, 0, "nothing left for the worker");
    assert.equal(box.sent.length, 0);

    // Approving again changes nothing; an address added later is picked up by 'Email pending'
    await bulk([r.id]);
    assert.equal((await jobOf(r.id)).status, "skipped");
    await pool.query("UPDATE registrations SET email = 'late@test.local' WHERE id = $1", [r.id]);
    await (await queue.queuePending(null)).done;
    const job = await jobOf(r.id);
    assert.deepEqual([job.status, job.reason], ["queued", "pending"]);
    await worker.drainQueue({ send: box.send });
    assert.deepEqual(box.sent.map((m) => m.to), ["late@test.local"]);
  });

  test("a delivered email is recorded on the certificate first, also when the worker's lease was lost", async () => {
    const r = await register();
    await review(r.id, "verify");
    const [job] = await queue.claimDue(1, "worker-a");
    assert.equal(job.certificate_id, (await certOf(r.id)).id);
    // Another worker holds the lease now: its job row is left alone, but the email did leave
    const lost = await queue.finishJob(job, "worker-b", { status: "sent", delivered: true }, { outcome: "sent", recipient: r.email });
    assert.equal(lost, false);
    assert.ok((await certOf(r.id)).emailed_at, "emailed_at is set even without the lease");
    assert.equal((await jobOf(r.id)).status, "processing");
    const kept = await queue.finishJob(job, "worker-a", { status: "sent", delivered: true }, { outcome: "sent", recipient: r.email });
    assert.equal(kept, true);
    const done = await jobOf(r.id);
    assert.deepEqual([done.status, done.sent_count, done.recipient], ["sent", 1, r.email]);
    assert.ok((await certOf(r.id)).emailed_at);
    assert.equal((await worker.drainQueue({ send: mailbox().send })).sent, 0, "not sent again");
  });

  test("the certificate image is a 2400×1712 baseline JPEG (4:4:4); downloads are counted once the file is ready", async () => {
    const r = await register();
    await review(r.id, "verify");
    const res = await binary(request(app).get(`/api/certificates/link/${certificateToken(r.id)}/download`).query({ format: "jpg" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/jpeg");
    const meta = await sharp(res.body).metadata();
    // Not progressive: encoded by plain libjpeg (mozjpeg off), which is several times faster
    assert.deepEqual([meta.format, meta.width, meta.height, meta.chromaSubsampling, meta.isProgressive], ["jpeg", 2400, 1712, "4:4:4", false]);
    assert.ok(res.body.length > 300_000 && res.body.length < 4_000_000, `${res.body.length} bytes`);
    assert.equal((await certOf(r.id)).download_count, 1);
    await worker.drainQueue({ send: mailbox().send });
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
    // Under 10,000 the count is exact
    assert.deepEqual([failed.body.meta.total, failed.body.meta.capped], [failed.body.data.length, false]);

    const byNumber = await request(app).get("/api/admin/certificates").query({ q: "१००२४" }).set(auth());
    assert.ok(byNumber.body.data.some((c) => c.durgveer_no === 10024));
    assert.equal(byNumber.body.meta.capped, false);

    // Searches with filters: the same rows and count as the plain SQL, in the requested order
    const expected = async (where, params) => (await pool.query(
      `SELECT c.registration_id FROM certificates c JOIN registrations r ON r.id = c.registration_id
       LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id WHERE r.deleted_at IS NULL AND ${where} ORDER BY r.name, c.id`,
      params)).rows.map((r) => r.registration_id);
    for (const query of [
      { q: "सहभागी 1", sort: "name", limit: 100 },
      { q: "सहभागी", email_status: "sent", sort: "name", limit: 100 },
      { q: "97000000", state: "valid", sort: "name", limit: 100 },
    ]) {
      const res = await list(query);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const like = `%${query.q}%`;
      const ids = await expected(
        `(r.name ILIKE $1 OR c.certificate_no ILIKE $1 OR r.phone LIKE $1)${query.email_status ? " AND j.status = 'sent'" : ""}${query.state ? " AND c.revoked_at IS NULL" : ""}`,
        [like]);
      assert.ok(ids.length > 1, JSON.stringify(query));
      assert.deepEqual(res.body.data.map((c) => c.registration_id), ids, JSON.stringify(query));
      assert.deepEqual([res.body.meta.total, res.body.meta.capped], [ids.length, false]);
    }
    // Two characters of text can match nothing (trigram search needs three)
    assert.equal((await list({ q: "सह" })).body.meta.total, 0);

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

  test("the admin list counts up to 10,000 and says so, refuses pages past that, and keeps search counts exact under the cap", async () => {
    assert.ok((await pool.query("SELECT COUNT(*)::int AS n FROM certificates")).rows[0].n > 10_000);
    const first = await list({ limit: 25 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.meta, { page: 1, limit: 25, total: 10_000, totalPages: 400, capped: true });
    assert.equal((await list({ limit: 25, page: 400 })).body.data.length, 25);
    assert.equal((await list({ limit: 25, page: 401 })).status, 400);

    // Every certificate number contains "AMRUT": counted to the cap, the page read off the sort index
    const broad = await list({ q: "amrut", sort: "durgveer_no", dir: "desc", limit: 25 });
    assert.deepEqual([broad.body.meta.total, broad.body.meta.capped], [10_000, true]);
    const top = await pool.query("SELECT durgveer_no FROM certificates ORDER BY durgveer_no DESC LIMIT 25");
    assert.deepEqual(broad.body.data.map((c) => c.durgveer_no), top.rows.map((r) => r.durgveer_no));
    // ... and with a narrow filter beside the broad text, the count is still exact
    await pool.query(
      `UPDATE certificates SET revoked_at = NOW() WHERE registration_id IN (
         SELECT c.registration_id FROM certificates c JOIN registrations r ON r.id = c.registration_id
         WHERE r.name LIKE 'भार चाचणी %' ORDER BY c.registration_id DESC LIMIT 3)`);
    const revoked = await pool.query(
      `SELECT c.registration_id FROM certificates c JOIN registrations r ON r.id = c.registration_id
       WHERE c.revoked_at IS NOT NULL AND r.deleted_at IS NULL ORDER BY c.issued_at DESC, c.id DESC`);
    const narrowed = await list({ q: "amrut", state: "revoked" });
    assert.deepEqual([narrowed.body.meta.total, narrowed.body.meta.capped], [revoked.rows.length, false]);
    assert.deepEqual(narrowed.body.data.map((c) => c.registration_id), revoked.rows.map((r) => r.registration_id));

    // Exactly 10,000 names match: not more than the cap, so the count is exact
    const names = await list({ q: "भार चाचणी", sort: "name", limit: 25 });
    assert.deepEqual([names.body.meta.total, names.body.meta.capped], [10_000, false]);
    assert.ok(names.body.data.every((c) => c.name.startsWith("भार चाचणी")));
  });

  test("sorting by certificate number is numeric: AMRUT-…-999999 comes before AMRUT-…-1000000", async () => {
    const { rows: [admin] } = await pool.query("SELECT id FROM admins LIMIT 1");
    await pool.query(
      `INSERT INTO registrations (id, participant_type, name, phone, district_id, source)
       VALUES (1000000, 'individual', 'क्रमांक चाचणी', '9800000001', 26, 'admin'), (999999, 'individual', 'क्रमांक चाचणी', '9800000002', 26, 'admin')`);
    await registrations.review([999999, 1000000], "verify", null, admin.id, null);
    const asc = await list({ q: "क्रमांक चाचणी", sort: "certificate_no" });
    assert.deepEqual(asc.body.data.map((c) => c.registration_id), [999999, 1000000]);
    assert.match(asc.body.data[1].certificate_no, /-1000000$/);
    const desc = await list({ q: "क्रमांक चाचणी", sort: "certificate_no", dir: "desc" });
    assert.deepEqual(desc.body.data.map((c) => c.registration_id), [1000000, 999999]);
  });

  test("a burst of 'download all' beyond the render queue is refused at once (BUSY); only delivered files are counted", async () => {
    const { rows } = await pool.query(
      `SELECT c.registration_id FROM certificates c JOIN registrations r ON r.id = c.registration_id
       WHERE r.name LIKE 'भार चाचणी %' AND c.revoked_at IS NULL ORDER BY c.registration_id LIMIT 20`);
    const ids = rows.map((r) => r.registration_id);
    const tokens = ids.map((id) => certificateToken(id));
    // A bundle counts as one render per certificate: 20 bundles of 20 are more than the threads and the queue take
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => certificates.bundleByTokens(tokens)));
    const delivered = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.ok(delivered.length >= 4 && refused.length >= 1, `${delivered.length} delivered, ${refused.length} refused`);
    for (const r of refused) assert.deepEqual([r.reason.status, r.reason.code], [503, "BUSY"]);
    for (const r of delivered) assert.equal(r.value.pdf.subarray(0, 5).toString(), "%PDF-");
    const counts = await pool.query("SELECT download_count FROM certificates WHERE registration_id = ANY($1)", [ids]);
    assert.ok(counts.rows.every((c) => c.download_count === delivered.length), "counted once per delivered bundle, never for a refused one");
    console.log(`  'download all' burst: ${delivered.length} delivered, ${refused.length} refused at once`);
  });

  test("'Retry failed' requeues a burst of failures batch by batch, also before the planner's statistics have seen it", async () => {
    // Statistics taken while hardly any email had failed, then thousands fail at once — when an admin presses the button.
    // Joined to its batch as a CTE, the update rescanned the batch for every failed job here: ~10 s per batch.
    await pool.query("ANALYZE certificate_email_jobs");
    const burst = await pool.query("UPDATE certificate_email_jobs SET status = 'failed', last_error_code = 'SMTP_451' WHERE status = 'cancelled'");
    assert.ok(burst.rowCount > 5_000, "more than one batch");
    const { rows: [failed] } = await pool.query("SELECT COUNT(*)::int AS n FROM certificate_email_jobs WHERE status = 'failed'");
    const started = Date.now();
    assert.equal(await queue.retryFailed(null), failed.n);
    const ms = Date.now() - started;
    const { rows: [left] } = await pool.query("SELECT COUNT(*)::int AS n FROM certificate_email_jobs WHERE status = 'failed'");
    assert.equal(left.n, 0);
    assert.ok(ms < 5_000, `${failed.n} retried in ${ms} ms`);
    console.log(`  'retry failed' requeued ${failed.n} in ${ms} ms`);
  });
});
