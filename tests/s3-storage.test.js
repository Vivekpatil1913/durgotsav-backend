// S3 storage for participant originals. The S3 transport is replaced by an in-memory fake, so these tests
// never reach AWS; live access through the EC2 role is checked with `npm run s3:check -- --write`.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import request from "supertest";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";
import { istDateFolder, participantFolderName, photoObjectKey } from "../src/services/participant-photo-keys.js";

process.env.PARTICIPANT_IMAGE_STORAGE = "s3";
process.env.AWS_REGION = "ap-south-1";
process.env.AWS_S3_BUCKET_NAME = "amrut-durgotsav";
process.env.AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS = "300";

let app;
let pool;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// ---- fake S3
const objects = new Map();
const calls = [];
let failNextPut = null;
const awsError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

before(async () => {
  await resetDatabase();
  const { s3Transport } = await import("../src/services/s3.service.js");
  s3Transport.send = async (cmd) => {
    calls.push(cmd);
    if (cmd instanceof PutObjectCommand) {
      if (failNextPut) {
        const err = failNextPut;
        failNextPut = null;
        throw err;
      }
      if (cmd.input.IfNoneMatch === "*" && objects.has(cmd.input.Key)) throw awsError("PreconditionFailed", 412);
      objects.set(cmd.input.Key, cmd.input);
      return {};
    }
    if (cmd instanceof DeleteObjectCommand) {
      objects.delete(cmd.input.Key);
      return {};
    }
    throw new Error(`unexpected command ${cmd.constructor.name}`);
  };
  s3Transport.presign = async (cmd, { expiresIn }) =>
    `https://${cmd.input.Bucket}.s3.ap-south-1.amazonaws.com/${encodeURIComponent(cmd.input.Key)}?X-Amz-Expires=${expiresIn}&X-Amz-Signature=fake`;

  app = (await import("../src/app.js")).createApp();
  ({ pool } = await import("../src/db/pool.js"));
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => pool.end());

function register(fields = {}, photo) {
  const req = request(app).post("/api/registrations");
  const data = { participant_type: "individual", name: "Rahul Patil", phone: "9876543210", district_id: "26", consent: "true", ...fields };
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  if (photo !== null) req.attach("photo", photo, { filename: "IMG_2041.jpg", contentType: "image/jpeg" });
  return req;
}

const puts = () => calls.filter((c) => c instanceof PutObjectCommand);
const countRegistrations = async () => (await pool.query("SELECT COUNT(*)::int AS n FROM registrations")).rows[0].n;
const today = istDateFolder();
const keyFor = (n, folder = "Rahul_Patil_9876543210") => `${today}/${folder}/${folder} (${n}).jpg`;

describe("S3 object keys", () => {
  test("date folder is DD-MM-YYYY in Asia/Kolkata", () => {
    assert.equal(istDateFolder(new Date("2026-10-12T06:00:00Z")), "12-10-2026");
    // 00:30 IST on 13 Oct is still 12 Oct in UTC
    assert.equal(istDateFolder(new Date("2026-10-12T19:00:00Z")), "13-10-2026");
  });

  test("participant folder uses first + last name and the full mobile number", () => {
    assert.equal(participantFolderName("Rahul Patil", "9876543210"), "Rahul_Patil_9876543210");
    assert.equal(participantFolderName("  Rahul  Suresh   Patil ", "9876543210"), "Rahul_Patil_9876543210");
    assert.equal(participantFolderName("राहुल पाटील", "9876543210"), "राहुल_पाटील_9876543210");
    assert.equal(participantFolderName("+91 98765 43210", "+91 98765-43210"), "91_43210_919876543210");
  });

  test("names cannot inject path segments or odd characters", () => {
    const folder = participantFolderName("../../etc/passwd Patil\u0000", "9876543210");
    assert.equal(folder, "etcpasswd_Patil_9876543210");
    assert.ok(!folder.includes("/") && !folder.includes(".."));
    assert.equal(participantFolderName("!!!", "9876543210"), "Participant_9876543210");
  });

  test("file names are numbered (1), (2), …", () => {
    const { key, fileName } = photoObjectKey({ dateFolder: "12-10-2026", folder: "Rahul_Patil_9876543210", number: 2, ext: "jpg" });
    assert.equal(key, "12-10-2026/Rahul_Patil_9876543210/Rahul_Patil_9876543210 (2).jpg");
    assert.equal(fileName, "Rahul_Patil_9876543210 (2).jpg");
    assert.throws(() => photoObjectKey({ dateFolder: "x", folder: "y", number: 0, ext: "jpg" }));
  });
});

describe("registration with S3 originals", () => {
  let first;

  test("uploads the original to the private bucket with the agreed key", async () => {
    const res = await register({}, await makePhoto());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    first = res.body.data;

    const [put] = puts();
    assert.equal(put.input.Bucket, "amrut-durgotsav");
    assert.equal(put.input.Key, keyFor(1));
    assert.equal(put.input.ContentType, "image/jpeg");
    assert.equal(put.input.IfNoneMatch, "*");
    assert.equal(put.input.Metadata["registration-id"], String(first.id));

    const { rows } = await pool.query("SELECT * FROM registration_photos WHERE registration_id = $1", [first.id]);
    assert.equal(rows[0].storage, "s3");
    assert.equal(rows[0].storage_key, keyFor(1));
    assert.equal(rows[0].photo_no, 1);
    assert.equal(rows[0].original_path, null, "no local original");
    assert.equal(rows[0].original_name, "IMG_2041.jpg");
    assert.equal(rows[0].mime_type, "image/jpeg");
    // public EXIF-free copy still served locally
    assert.equal((await request(app).get(rows[0].thumb_path)).status, 200);
  });

  test("a second registration with the same name and mobile on the same day gets (2), not an overwrite", async () => {
    const res = await register({}, await makePhoto());
    assert.equal(res.status, 201);
    assert.ok(objects.has(keyFor(1)) && objects.has(keyFor(2)));
    assert.equal(puts().length, 2);
  });

  test("an object already in S3 without a DB row is skipped, never overwritten", async () => {
    objects.set(keyFor(3), { Key: keyFor(3), orphan: true });
    const res = await register({}, await makePhoto());
    assert.equal(res.status, 201);
    assert.equal(objects.get(keyFor(3)).orphan, true);
    const { rows } = await pool.query("SELECT storage_key FROM registration_photos WHERE registration_id = $1", [res.body.data.id]);
    assert.equal(rows[0].storage_key, keyFor(4));
  });

  test("a retried submit with the same submission_id returns the same registration without re-uploading", async () => {
    const submission = "6f1d2c1e-3b7a-4d4e-9a51-1c2b3d4e5f60";
    const one = await register({ name: "Asha Kale", phone: "9123456789", submission_id: submission }, await makePhoto());
    assert.equal(one.status, 201);
    const before = puts().length;
    const regs = await countRegistrations();
    const two = await register({ name: "Asha Kale", phone: "9123456789", submission_id: submission }, await makePhoto());
    assert.equal(two.status, 200);
    assert.equal(two.body.data.id, one.body.data.id);
    assert.equal(puts().length, before);
    assert.equal(await countRegistrations(), regs);
    const other = await register({ name: "Someone Else", phone: "9000000001", submission_id: submission }, await makePhoto());
    assert.equal(other.status, 409);
  });

  test("invalid image bytes are rejected before anything is uploaded", async () => {
    const before = puts().length;
    const res = await register({}, Buffer.from("not an image".repeat(100)));
    assert.equal(res.status, 400);
    assert.equal(puts().length, before);
  });

  test("an S3 permission error fails the registration with a clear error and saves nothing", async () => {
    const regs = await countRegistrations();
    failNextPut = awsError("AccessDenied", 403);
    const res = await register({ name: "Sunil More", phone: "9111111111" }, await makePhoto());
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "S3_ACCESS_DENIED");
    assert.equal(await countRegistrations(), regs);
  });

  test("missing EC2 role credentials give an operational error, not a success", async () => {
    const regs = await countRegistrations();
    failNextPut = Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
    const res = await register({ name: "Sunil More", phone: "9111111111" }, await makePhoto());
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "S3_CREDENTIALS_UNAVAILABLE");
    assert.equal(await countRegistrations(), regs);
  });

  test("if the database write fails after upload, only the new object is removed", async () => {
    // A row already claiming the next key (without a number) makes the photo INSERT violate the unique index
    const blocker = keyFor(5);
    await pool.query("UPDATE registration_photos SET storage_key = $1 WHERE registration_id = $2", [blocker, first.id]);
    const regs = await countRegistrations();
    const res = await register({}, await makePhoto());
    assert.notEqual(res.status, 201);
    assert.equal(await countRegistrations(), regs);
    const deleted = calls.filter((c) => c instanceof DeleteObjectCommand).map((c) => c.input.Key);
    assert.deepEqual(deleted, [blocker]);
    assert.ok(!objects.has(blocker));
    assert.ok(objects.has(keyFor(2)) && objects.has(keyFor(3)) && objects.has(keyFor(4)), "earlier photos untouched");
    await pool.query("UPDATE registration_photos SET storage_key = $1 WHERE registration_id = $2", [keyFor(1), first.id]);
  });

  test("a resubmitted photo continues the numbering", async () => {
    await request(app).post(`/api/admin/registrations/${first.id}/review`).set(auth()).send({ action: "request_info", note: "नवीन छायाचित्र पाठवा" });
    const res = await request(app).post(`/api/registrations/${first.registration_no}/resubmit`)
      .field("phone", "9876543210").attach("photo", await makePhoto(), "new.jpg");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows } = await pool.query(
      "SELECT storage_key, is_current FROM registration_photos WHERE registration_id = $1 ORDER BY id", [first.id]);
    assert.deepEqual(rows.map((r) => r.storage_key), [keyFor(1), keyFor(5)]);
    assert.deepEqual(rows.map((r) => r.is_current), [false, true]);
  });

  test("admins get short-lived presigned links; anonymous users and mismatched ids do not", async () => {
    const detail = await request(app).get(`/api/admin/registrations/${first.id}`).set(auth());
    assert.equal(detail.status, 200);
    const photo = detail.body.data.photos.find((p) => p.is_current);
    assert.match(photo.original_url, /X-Amz-Expires=300/);
    assert.ok(new Date(photo.original_url_expires_at) > new Date());

    const fresh = await request(app).get(`/api/admin/registrations/${first.id}/photos/${photo.id}/original`).set(auth());
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers["cache-control"], "no-store");
    assert.match(fresh.body.data.url, /X-Amz-Signature=/);

    assert.equal((await request(app).get(`/api/admin/registrations/${first.id}/photos/${photo.id}/original`)).status, 401);
    const otherReg = first.id + 1;
    assert.equal((await request(app).get(`/api/admin/registrations/${otherReg}/photos/${photo.id}/original`).set(auth())).status, 404);

    // the participant's public status never exposes S3 keys or links
    const status = await request(app).get("/api/registrations/status").query({ registration: first.registration_no, phone: "9876543210" });
    assert.ok(!JSON.stringify(status.body).includes("amazonaws"));
    assert.ok(!JSON.stringify(status.body).includes(today));
  });
});
