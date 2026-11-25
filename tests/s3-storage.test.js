// S3 storage for participant originals. The S3 transport is replaced by an in-memory fake, so these tests
// never reach AWS; live access through the EC2 role is checked with `npm run s3:check -- --write`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import ExcelJS from "exceljs";
import sharp from "sharp";
import request from "supertest";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";
import { istDateFolder, participantFolderName, photoObjectKey } from "../src/services/participant-photo-keys.js";

process.env.PARTICIPANT_IMAGE_STORAGE = "s3";
process.env.AWS_REGION = "ap-south-1";
process.env.AWS_S3_BUCKET_NAME = "amrut-durgotsav";
process.env.AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS = "300";
process.env.IMPORT_ALLOW_PRIVATE_PHOTO_URLS = "true"; // the import test's photo server is on this machine

let app;
let pool;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// ---- fake S3
const objects = new Map();
const calls = [];
const isCopy = (cmd) => cmd.input.Key.startsWith("thumbnail/"); // display copies and thumbnails
let failCopyPut = null; // (key) => error or null
let failNextPut = null; // originals
let loseNextPutReply = false; // S3 stores the object, the reply is lost, the SDK's retry gets 412
const awsError = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

before(async () => {
  await resetDatabase();
  const { s3Transport } = await import("../src/services/s3.service.js");
  s3Transport.send = async (cmd) => {
    calls.push(cmd);
    if (cmd instanceof PutObjectCommand) {
      if (isCopy(cmd)) {
        const err = failCopyPut?.(cmd.input.Key);
        if (err) throw err;
        objects.set(cmd.input.Key, cmd.input);
        return {};
      }
      if (loseNextPutReply) {
        loseNextPutReply = false;
        objects.set(cmd.input.Key, cmd.input);
        throw awsError("PreconditionFailed", 412);
      }
      if (failNextPut) {
        const err = failNextPut;
        failNextPut = null;
        throw err;
      }
      if (cmd.input.IfNoneMatch === "*" && objects.has(cmd.input.Key)) throw awsError("PreconditionFailed", 412);
      objects.set(cmd.input.Key, cmd.input);
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const object = objects.get(cmd.input.Key);
      if (!object) throw awsError("NoSuchKey", 404);
      const body = Readable.from([object.Body]);
      body.transformToByteArray = async () => object.Body;
      return { Body: body, ContentType: object.ContentType, ContentLength: object.Body.length, ETag: '"e"' };
    }
    if (cmd instanceof HeadObjectCommand) {
      const object = objects.get(cmd.input.Key);
      if (!object) throw awsError("NotFound", 404);
      return { Metadata: object.Metadata };
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

const puts = () => calls.filter((c) => c instanceof PutObjectCommand && !isCopy(c)); // originals
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
    // the EXIF-free copies are in S3 too, under thumbnail/, and the database keeps their S3 URLs
    const origin = "https://amrut-durgotsav.s3.ap-south-1.amazonaws.com/";
    for (const ref of [rows[0].image_path, rows[0].thumb_path]) {
      assert.match(ref, /^https:\/\/amrut-durgotsav\.s3\.ap-south-1\.amazonaws\.com\/thumbnail\/registrations\/\d{4}-\d{2}\/[\w-]+\.webp$/);
      const object = objects.get(ref.slice(origin.length));
      assert.equal(object.ContentType, "image/webp");
      assert.match(object.CacheControl, /immutable/);
    }
    // clients get an address the API streams, so the bucket stays private
    const list = await request(app).get("/api/admin/registrations").set(auth());
    const thumb = list.body.data.find((r) => r.id === first.id).thumb_path;
    assert.equal(thumb, rows[0].thumb_path.replace(`${origin}thumbnail/`, "/uploads/"));
    const served = await request(app).get(thumb);
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/webp");
    assert.match(served.headers["cache-control"], /immutable/);
    assert.deepEqual(served.body, objects.get(rows[0].thumb_path.slice(origin.length)).Body);
    assert.equal((await request(app).get(thumb).set("If-None-Match", '"e"')).status, 304);
    const missing = await request(app).get("/uploads/registrations/2026-11/nope.webp");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "no-store");
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

  test("an upload stored by S3 whose reply was lost keeps that object (no second copy)", async () => {
    const before = puts().length;
    loseNextPutReply = true;
    const res = await register({ name: "Lost Reply", phone: "9222222222" }, await makePhoto());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(puts().length, before + 1, "uploaded once, not again under the next number");
    const { rows } = await pool.query("SELECT storage_key, photo_no FROM registration_photos WHERE registration_id = $1", [res.body.data.id]);
    assert.equal(rows[0].photo_no, 1);
    assert.ok(objects.has(rows[0].storage_key));
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

  test("a photo whose copies, or original, cannot be stored fails the registration and leaves nothing behind", async () => {
    const before = [...objects.keys()].sort();
    const regs = await countRegistrations();
    failCopyPut = () => awsError("SlowDown", 503);
    const res = await register({ name: "Sunil More", phone: "9111111112" }, await makePhoto());
    failCopyPut = null;
    assert.equal(res.status, 502);
    assert.equal(await countRegistrations(), regs);
    assert.deepEqual([...objects.keys()].sort(), before, "no original without its copies");
    failNextPut = awsError("AccessDenied", 403);
    await register({ name: "Sunil More", phone: "9111111112" }, await makePhoto());
    assert.deepEqual([...objects.keys()].sort(), before, "no copies without their original");
  });

  test("if only the thumbnail cannot be stored the registration succeeds, with the display copy in its place", async () => {
    failCopyPut = (key) => (key.endsWith("_t.webp") ? awsError("SlowDown", 503) : null);
    const res = await register({ name: "Only Display", phone: "9111111113" }, await makePhoto());
    failCopyPut = (key) => (key.endsWith("_t.webp") ? null : awsError("SlowDown", 503));
    const res2 = await register({ name: "Only Thumb", phone: "9111111114" }, await makePhoto());
    failCopyPut = null;
    for (const r of [res, res2]) {
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const { rows: [p] } = await pool.query("SELECT * FROM registration_photos WHERE registration_id = $1", [r.body.data.id]);
      assert.equal(p.thumb_path, p.image_path);
      assert.equal(p.storage, "s3");
      assert.ok(objects.has(p.storage_key), "the original is stored as always");
      assert.equal((await request(app).get(new URL(p.thumb_path).pathname.replace("/thumbnail/", "/uploads/"))).status, 200);
    }
  });

  test("an Excel import stores a photo over 5 MB and its thumbnail in S3", async () => {
    const big = await sharp(crypto.randomBytes(3000 * 2250 * 3), { raw: { width: 3000, height: 2250, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    assert.ok(big.length > 5 * 1024 * 1024);
    const server = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "image/jpeg" }).end(big));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const imports = await import("../src/modules/imports/import.service.js");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Registrations");
    ws.addRow(["Full Name", "Mobile Number", "District", "Photo URL"]);
    ws.addRow(["Import Bada", "9555555555", "Pune", `http://127.0.0.1:${server.address().port}/big.jpg`]);
    const res = await request(app).post("/api/admin/registrations/imports").set(auth())
      .attach("file", Buffer.from(await wb.xlsx.writeBuffer()), "rows.xlsx");
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await imports.idle();
    server.close();
    const { rows: [job] } = await pool.query("SELECT * FROM registration_imports WHERE id = $1", [res.body.data.id]);
    assert.deepEqual([job.status, job.imported_rows, job.failed_rows], ["completed", 1, 0]);
    const { rows: [p] } = await pool.query(
      "SELECT p.*, r.status FROM registration_photos p JOIN registrations r ON r.id = p.registration_id WHERE r.phone = '9555555555'");
    assert.equal(p.status, "verified");
    assert.equal(p.storage_key, keyFor(1, "Import_Bada_9555555555"));
    assert.equal(objects.get(p.storage_key).Body.length, big.length, "the full-size photo is stored untouched");
    const origin = "https://amrut-durgotsav.s3.ap-south-1.amazonaws.com/";
    assert.ok(p.thumb_path.startsWith(`${origin}thumbnail/registrations/`));
    assert.ok(objects.get(p.thumb_path.slice(origin.length)).Body.length <= 100 * 1024);
    assert.ok(objects.get(p.image_path.slice(origin.length)).Body.length <= 300 * 1024);
  });

  test("nothing is written to this server's disk", async () => {
    const { paths } = await import("../src/config/paths.js");
    const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);
    const before = [list(paths.uploads), list(paths.privateStorage)];
    assert.equal((await register({ name: "No Disk", phone: "9111111115" }, await makePhoto())).status, 201);
    assert.deepEqual([list(paths.uploads), list(paths.privateStorage)], before);
  });

  test("thumbnails from before S3 load from disk, migrated ones from S3 wherever they were copied, in every review status", async () => {
    const { paths } = await import("../src/config/paths.js");
    const name = (n) => `registrations/2026-10/compat-${n}`;
    const body = await makePhoto();
    fs.mkdirSync(`${paths.uploads}/registrations/2026-10`, { recursive: true });
    fs.writeFileSync(`${paths.uploads}/${name("disk")}_t.webp`, body);
    objects.set(`uploads/${name("synced")}_t.webp`, { Body: body, ContentType: "image/webp" });
    objects.set(`${name("flat")}_t.webp`, { Body: body, ContentType: "image/webp" });
    objects.set(`thumbnail/${name("moved")}_t.webp`, { Body: body, ContentType: "image/webp" });
    objects.set(`uploads/${name("url")}_t.webp`, { Body: body, ContentType: "image/webp" });
    const refs = { disk: "/uploads/", synced: "/uploads/", flat: "/uploads/", moved: "/uploads/", url: "https://amrut-durgotsav.s3.ap-south-1.amazonaws.com/uploads/" };
    const ids = {};
    for (const n of Object.keys(refs)) {
      const { id } = (await register({ name: `Compat ${n}`, phone: "9333333333" }, await makePhoto())).body.data;
      ids[n] = id;
      await pool.query("UPDATE registration_photos SET image_path = $2, thumb_path = $3 WHERE registration_id = $1",
        [id, `${refs[n]}${name(n)}.webp`, `${refs[n]}${name(n)}_t.webp`]);
    }
    const all = Object.values(ids);
    const fresh = (await register({ name: "Compat new", phone: "9333333333" }, await makePhoto())).body.data.id;
    for (const [status, action] of [["pending", null], ["verified", "verify"], ["rejected", "reject"], ["duplicate", "mark_duplicate"]]) {
      if (action) {
        const res = await request(app).post("/api/admin/registrations/bulk-review").set(auth()).send({ ids: [...all, fresh], action, note: "कारण कारण" });
        assert.equal(res.status, 200, JSON.stringify(res.body));
      }
      const { body: page } = await request(app).get(`/api/admin/registrations?status=${status}&limit=100`).set(auth());
      const rows = page.data.filter((r) => [...all, fresh].includes(r.id));
      assert.equal(rows.length, all.length + 1);
      for (const row of rows) {
        assert.match(row.thumb_path, /^\/uploads\/registrations\/\d{4}-\d{2}\//, `${status} ${row.name}`);
        assert.equal((await request(app).get(row.thumb_path)).status, 200, `${status} ${row.name} ${row.thumb_path}`);
      }
    }
    fs.rmSync(`${paths.uploads}/${name("disk")}_t.webp`);
  });

  test("/uploads never reaches originals or anything else in the bucket", async () => {
    objects.set("secret.webp", { Body: Buffer.from("x") });
    for (const url of [`/uploads/${encodeURI(keyFor(1))}`, "/uploads/secret.webp", "/uploads/../secret.webp", "/uploads/registrations/%2e%2e/secret.webp", "/uploads/registrations/2026-10/..%2f..%2fsecret.webp"]) {
      const res = await request(app).get(url);
      assert.ok(res.status >= 400, `${url} → ${res.status}`);
    }
  });

  test("the website gallery shows an approved photo stored in S3", async () => {
    const { id } = (await register({ name: "Gallery S3", phone: "9444444444" }, await makePhoto())).body.data;
    assert.equal((await request(app).post(`/api/admin/registrations/${id}/review`).set(auth()).send({ action: "verify" })).status, 200);
    await pool.query("UPDATE registration_photos SET is_featured = TRUE WHERE registration_id = $1", [id]);
    const { clearGalleryCache } = await import("../src/modules/gallery/gallery.service.js");
    clearGalleryCache();
    const { body } = await request(app).get("/api/gallery?page=1&limit=10");
    const photo = body.data.find((p) => p.name === "Gallery S3");
    for (const ref of [photo.image_path, photo.thumb_path]) {
      assert.match(ref, /^\/uploads\/registrations\//);
      assert.equal((await request(app).get(ref)).headers["content-type"], "image/webp");
    }
  });

  test("a certificate's photo is read back from S3", async () => {
    const { loadAsJpeg } = await import("../src/services/image.service.js");
    const { rows } = await pool.query("SELECT image_path FROM registration_photos WHERE registration_id = $1", [first.id]);
    assert.equal((await loadAsJpeg(rows[0].image_path)).subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(await loadAsJpeg("https://amrut-durgotsav.s3.ap-south-1.amazonaws.com/thumbnail/registrations/2026-11/gone.webp"), null);
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
    const fresh = deleted.slice(-3);
    assert.deepEqual(fresh.filter((k) => !k.startsWith("thumbnail/")), [blocker]);
    assert.equal(fresh.filter((k) => k.startsWith("thumbnail/")).length, 2, "its two copies go with it");
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
