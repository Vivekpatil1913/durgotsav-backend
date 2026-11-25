// Bulk registration import: Excel / CSV + optional photo ZIP → approved registrations with certificates.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import ExcelJS from "exceljs";
import request from "supertest";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

// Photo URLs in these tests point at a server on this machine
process.env.IMPORT_ALLOW_PRIVATE_PHOTO_URLS = "true";
process.env.IMPORT_BATCH_SIZE = "10"; // several batches with a small sheet

let app;
let pool;
let token;
let imports;
let photoServer;
let base;
const auth = () => ({ Authorization: `Bearer ${token}` });
const photos = new Map();

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
  imports = await import("../src/modules/imports/import.service.js");
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
  for (const name of ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) photos.set(`/${name}`, await makePhoto());
  photos.set("/big.jpg", Buffer.alloc(21 * 1024 * 1024, 1));
  photoServer = http.createServer((req, res) => {
    if (req.url === "/moved.jpg") return res.writeHead(302, { Location: "/d.jpg" }).end();
    if (req.url === "/drive-like") return res.writeHead(303, { Location: "/moved.jpg" }).end();
    if (req.url === "/signin") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html>Sign in</html>");
    if (req.url === "/text") return res.writeHead(200, { "Content-Type": "text/plain" }).end("hello");
    if (req.url === "/untyped.jpg") return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(photos.get("/a.jpg"));
    const body = photos.get(req.url);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": body.length }).end(body);
  });
  await new Promise((r) => photoServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${photoServer.address().port}`;
});
after(async () => {
  await imports.idle();
  photoServer.close();
  await pool.end();
});

async function xlsx(header, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Registrations");
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function upload(file, filename, { zip, sendSms } = {}) {
  const req = request(app).post("/api/admin/registrations/imports").set(auth());
  if (sendSms !== undefined) req.field("send_sms", String(sendSms));
  req.attach("file", file, filename);
  if (zip) req.attach("photos", zip, "photos.zip");
  return req;
}

async function finished(id) {
  await imports.idle();
  const res = await request(app).get(`/api/admin/registrations/imports/${id}`).set(auth());
  assert.equal(res.status, 200);
  return res.body.data;
}

const reasonOf = (job, rowNo) => job.errors.find((e) => e.row_no === rowNo)?.reason ?? null;

describe("registration import", () => {
  let firstImport;

  test("needs an admin token", async () => {
    assert.equal((await request(app).get("/api/admin/registrations/imports")).status, 401);
  });

  test("sample template has the expected columns", async () => {
    const res = await request(app).get("/api/admin/registrations/imports/template.xlsx").set(auth())
      .buffer(true).parse((r, cb) => { const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); });
    assert.equal(res.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    assert.deepEqual(wb.getWorksheet("Registrations").getRow(1).values.slice(1), ["Full Name", "Mobile Number", "District", "Photo URL", "Photo File Name"]);
    assert.ok(wb.getWorksheet("Districts").rowCount >= 37);
  });

  test("imports valid rows as approved with certificates and reports the rest", async () => {
    const file = await xlsx(["Full Name", "Mobile Number", "Location", "Photo URL"], [
      ["Rahul Patil", "9876543210", "Pune", `${base}/a.jpg`], // 2 ok, photo
      ["Sneha Jadhav", "+91 98765 43211", "nashik", ""], // 3 ok, no photo
      ["", "9876543212", "Pune", ""], // 4 no name
      ["Amit Shinde", "12345", "Pune", ""], // 5 bad mobile
      ["Kiran More", "9876543213", "Goa", ""], // 6 not a Maharashtra district
      ["rahul  patil", "9876543210", "Pune", ""], // 7 repeat of row 2
      ["Pooja Pawar", "9876543214", "Satara", `${base}/missing.jpg`], // 8 photo 404
      ["Patil Family", 9876543210, "पुणे", `${base}/moved.jpg`], // 9 ok: same mobile, other name; Marathi district; redirect
      ["Vikas Kale", "9876543215", "Ahmednagar", `${base}/big.jpg`], // 10 photo too large
      ["Meena Gaikwad", "09876543216", "Mumbai", `${base}/b.jpg`], // 11 ok: 0 prefix, alias district
      ["Bad Link", "9876543217", "Pune", "ftp://example.com/x.jpg"], // 12 not http(s)
    ]);
    const res = await upload(file, "batch.xlsx");
    assert.equal(res.status, 202, JSON.stringify(res.body));
    firstImport = res.body.data.id;
    const job = await finished(firstImport);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.total_rows, 11);
    assert.equal(job.processed_rows, 11);
    assert.equal(job.imported_rows, 4);
    assert.equal(job.failed_rows, 7);
    assert.equal(job.percent, 100);
    assert.match(reasonOf(job, 4), /Full Name is missing/);
    assert.match(reasonOf(job, 5), /not a valid 10-digit/);
    assert.match(reasonOf(job, 6), /not a Maharashtra district/);
    assert.match(reasonOf(job, 7), /Repeats an earlier row/);
    assert.match(reasonOf(job, 8), /HTTP 404/);
    assert.match(reasonOf(job, 10), /larger than 20 MB/);
    assert.match(reasonOf(job, 12), /http:\/\/ or https:\/\//);

    const { rows } = await pool.query(
      `SELECT r.name, r.phone, r.status, r.source, r.reviewed_by, d.name_en AS district, c.certificate_no, c.durgveer_no,
              p.image_path, j.status AS email_status
       FROM registrations r JOIN districts d ON d.id = r.district_id
       LEFT JOIN certificates c ON c.registration_id = r.id
       LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
       LEFT JOIN certificate_email_jobs j ON j.certificate_id = c.id
       WHERE r.import_id = $1 ORDER BY r.id`, [firstImport]);
    assert.deepEqual(rows.map((r) => [r.name, r.phone, r.district]), [
      ["Rahul Patil", "9876543210", "Pune"],
      ["Sneha Jadhav", "9876543211", "Nashik"],
      ["Patil Family", "9876543210", "Pune"],
      ["Meena Gaikwad", "9876543216", "Mumbai City"],
    ]);
    for (const r of rows) {
      assert.equal(r.status, "verified");
      assert.equal(r.source, "import");
      assert.ok(r.reviewed_by);
      assert.ok(r.certificate_no && r.durgveer_no, "certificate issued");
      assert.equal(r.email_status, "skipped"); // no email address in the sheet
    }
    assert.deepEqual(rows.map((r) => Boolean(r.image_path)), [true, false, true, true]);
    const sms = await pool.query(
      "SELECT COUNT(*)::int AS n FROM sms_messages m JOIN registrations r ON r.id = m.registration_id WHERE r.import_id = $1 AND m.purpose = 'certificate_link'",
      [firstImport]);
    assert.equal(sms.rows[0].n, 4);
  });

  test("certificates of imported registrations download like approved ones", async () => {
    const { rows } = await pool.query("SELECT id FROM registrations WHERE import_id = $1 ORDER BY id LIMIT 1", [firstImport]);
    const { certificateToken } = await import("../src/modules/certificates/certificate.links.js");
    const res = await request(app).get(`/api/certificates/link/${certificateToken(rows[0].id)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.certificate_available, true);
  });

  test("result and failed-row reports download as CSV", async () => {
    const results = await request(app).get(`/api/admin/registrations/imports/${firstImport}/results.csv`).set(auth());
    assert.equal(results.status, 200);
    const lines = results.text.trim().split(/\r?\n/);
    assert.equal(lines.length, 5);
    assert.match(lines[1], /Rahul Patil,9876543210,Pune,Approved,AMRUT-/);
    assert.match(lines[1], /\/c\//);
    const errors = await request(app).get(`/api/admin/registrations/imports/${firstImport}/errors.csv`).set(auth());
    assert.equal(errors.text.trim().split(/\r?\n/).length, 8);
  });

  test("importing the same people again skips them as already registered", async () => {
    const file = await xlsx(["Full Name", "Mobile Number", "District"], [["RAHUL PATIL", "9876543210", "Pune"]]);
    const job = await finished((await upload(file, "again.xlsx")).body.data.id);
    assert.equal(job.imported_rows, 0);
    assert.match(job.errors[0].reason, /Already registered .*DGT\d{2}-/);
  });

  test("CSV with photos from a ZIP, more rows than one batch, SMS off", async () => {
    const { zipWriter } = await import("../src/modules/award/award.export.js");
    const chunks = [];
    const zip = zipWriter({ write: async (c) => { chunks.push(c); } });
    await zip.file("photos/C.JPG", photos.get("/c.jpg"));
    await zip.file("d.jpg", photos.get("/d.jpg"));
    await zip.finish();
    const lines = ["Full Name,Mobile Number,District,Photo File Name",
      '"Joshi, Anil",9000000001,Kolhapur,c.jpg',
      "Rekha Deshmukh,9000000002,Latur,d.jpg",
      "Nobody,9000000003,Latur,nothere.jpg"];
    for (let i = 4; i <= 25; i++) lines.push(`Person ${i},90000000${String(i).padStart(2, "0")},Thane,`);
    const job = await finished((await upload(Buffer.from(lines.join("\r\n")), "batch.csv", { zip: Buffer.concat(chunks), sendSms: false })).body.data.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.total_rows, 25);
    assert.equal(job.imported_rows, 24);
    assert.match(reasonOf(job, 4), /"nothere.jpg" is not in the ZIP/);
    const { rows } = await pool.query(
      `SELECT r.name, p.id AS photo FROM registrations r
       LEFT JOIN registration_photos p ON p.registration_id = r.id AND p.is_current
       WHERE r.import_id = $1 ORDER BY r.id LIMIT 2`, [job.id]);
    assert.deepEqual(rows.map((r) => [r.name, Boolean(r.photo)]), [["Joshi, Anil", true], ["Rekha Deshmukh", true]]);
    const sms = await pool.query("SELECT COUNT(*)::int AS n FROM sms_messages m JOIN registrations r ON r.id = m.registration_id WHERE r.import_id = $1", [job.id]);
    assert.equal(sms.rows[0].n, 0);
  });

  test("Photo File Name without a ZIP is reported per row", async () => {
    const file = await xlsx(["Full Name", "Mobile Number", "District", "Photo File Name"], [["Asha Kulkarni", "9111111111", "Pune", "asha.jpg"]]);
    const job = await finished((await upload(file, "nozip.xlsx")).body.data.id);
    assert.match(job.errors[0].reason, /no ZIP/);
  });

  test("a sheet without the mandatory columns stops with a clear message", async () => {
    const file = await xlsx(["Name", "City"], [["Asha", "Pune"]]);
    const job = await finished((await upload(file, "wrong.xlsx")).body.data.id);
    assert.equal(job.status, "failed");
    assert.match(job.error, /no Mobile Number, District column/);
  });

  test("rejects files that are not .xlsx / .csv", async () => {
    const res = await upload(Buffer.from("x"), "old.xls");
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /\.xls files are not supported/);
    const fake = await upload(Buffer.from("not a zip"), "fake.xlsx");
    assert.equal(fake.status, 400);
  });

  test("lists imports newest first", async () => {
    const res = await request(app).get("/api/admin/registrations/imports").set(auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 5);
    assert.ok(res.body.data[0].id > res.body.data[1].id);
  });
});

describe("Google Drive links and photo downloads", () => {
  test("share links become direct-download URLs; other URLs stay as they are", async () => {
    const { directPhotoUrl, driveFileId } = await import("../src/modules/imports/import.photos.js");
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
    const direct = `https://drive.google.com/uc?export=download&id=${id}`;
    for (const link of [
      `https://drive.google.com/file/d/${id}/view?usp=drive_link`,
      `https://drive.google.com/file/d/${id}/view`,
      `https://drive.google.com/file/u/0/d/${id}/edit`,
      `https://drive.google.com/open?id=${id}`,
      `https://drive.google.com/uc?id=${id}&export=view`,
      `https://drive.google.com/uc?export=download&id=${id}`,
      ` https://drive.google.com/file/d/${id}/view?usp=sharing `,
    ]) assert.equal(directPhotoUrl(link), direct, link);
    assert.equal(driveFileId("https://example.com/file/d/abcdefghijklmnop/view"), null);
    assert.equal(driveFileId("https://drive.google.com/drive/folders/"), null);
    assert.equal(directPhotoUrl("https://bucket.s3.amazonaws.com/p.jpg"), "https://bucket.s3.amazonaws.com/p.jpg");
  });

  test("downloads follow 301/302/303, need an image type, and explain a private Drive file", async () => {
    const { DRIVE_PRIVATE, fetchImage } = await import("../src/modules/imports/import.photos.js");
    const message = (p) => p.then(() => null, (e) => e.message);
    assert.ok((await fetchImage(`${base}/drive-like`, { drive: true })).length > 1000, "303 → 302 → image");
    assert.ok((await fetchImage(`${base}/untyped.jpg`)).length > 1000, "untyped bytes are accepted (checked as an image later)");
    assert.equal(await message(fetchImage(`${base}/signin`, { drive: true })), DRIVE_PRIVATE);
    assert.equal(await message(fetchImage(`${base}/missing.jpg`, { drive: true })), DRIVE_PRIVATE);
    assert.match(await message(fetchImage(`${base}/signin`)), /web page, not an image/);
    assert.match(await message(fetchImage(`${base}/text`)), /not an image \(Content-Type text\/plain\)/);
  });

  test("blank row 1, headers on row 2 with '*' and notes, hyperlink cells and Drive links", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Participants");
    ws.getRow(2).values = ["Sr. No.", "Full Name *", "Mobile Number *", "District *", "Photo URL (Direct Link)"];
    const rows = [
      [1, "Ganesh Kadam", "9222222221", "Pune", { text: "View photo", hyperlink: `${base}/a.jpg` }], // 3 inserted hyperlink
      [2, "Lata Bhosale", "9222222222", "Kolhapur", { formula: `HYPERLINK("${base}/b.jpg","Photo")`, result: "Photo" }], // 4 formula
      [3, "Drive Restricted", "9222222223", "Satara", "https://drive.google.com/file/d/1ThisFileIdDoesNotExist000000000/view?usp=drive_link"], // 5
      [4, "Plain Url", "9222222224", "Sangli", `${base}/c.jpg`], // 6
    ];
    rows.forEach((r, i) => { ws.getRow(3 + i).values = r; });
    const res = await upload(Buffer.from(await wb.xlsx.writeBuffer()), "row2-headers.xlsx");
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const job = await finished(res.body.data.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.total_rows, 4);
    const drive = reasonOf(job, 5);
    // Needs internet: Google answers an unknown / restricted file with an HTML page
    if (!/was not found|could not be downloaded \(E/.test(drive ?? "")) {
      assert.equal(drive, "Google Drive link is private or invalid — set file access to 'Anyone with the link'");
    }
    assert.equal(job.imported_rows, 3);
    const { rows: saved } = await pool.query(
      `SELECT r.name, r.status, p.image_path, c.certificate_no FROM registrations r
       JOIN registration_photos p ON p.registration_id = r.id AND p.is_current AND p.position = 1
       JOIN certificates c ON c.registration_id = r.id
       WHERE r.import_id = $1 ORDER BY r.id`, [job.id]);
    assert.deepEqual(saved.map((r) => r.name), ["Ganesh Kadam", "Lata Bhosale", "Plain Url"]);
    for (const r of saved) {
      assert.equal(r.status, "verified");
      assert.match(r.image_path, /^\/uploads\/registrations\//);
    }
  });

  test("outside production, S3 without credentials keeps photo originals on local disk", async () => {
    const { env } = await import("../src/config/env.js");
    const { s3Transport } = await import("../src/services/s3.service.js");
    const saved = { storage: env.PARTICIPANT_IMAGE_STORAGE, bucket: env.AWS_S3_BUCKET_NAME, send: s3Transport.send };
    env.PARTICIPANT_IMAGE_STORAGE = "s3";
    env.AWS_S3_BUCKET_NAME = "test-bucket";
    s3Transport.send = async () => { throw Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" }); };
    try {
      const file = await xlsx(["Full Name", "Mobile Number", "District", "Photo URL"], [["Fallback Person", "9444444441", "Pune", `${base}/d.jpg`]]);
      const job = await finished((await upload(file, "fallback.xlsx")).body.data.id);
      assert.equal(job.imported_rows, 1, JSON.stringify(job.errors));
      const { rows } = await pool.query(
        "SELECT p.storage, p.original_path FROM registration_photos p JOIN registrations r ON r.id = p.registration_id WHERE r.import_id = $1", [job.id]);
      assert.equal(rows[0].storage, "local");
      assert.ok(rows[0].original_path);
    } finally {
      Object.assign(env, { PARTICIPANT_IMAGE_STORAGE: saved.storage, AWS_S3_BUCKET_NAME: saved.bucket });
      s3Transport.send = saved.send;
    }
  });

  test("a title banner above the header is skipped; no header in the first 10 rows is a clear error", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.getRow(1).values = ["Amrut Durgotsav 2026 — participant list"];
    ws.getRow(3).values = ["Name", "Mobile", "Location (District) *", "Photo"];
    ws.getRow(4).values = ["Banner Test", "9333333331", "Nagpur", ""];
    const job = await finished((await upload(Buffer.from(await wb.xlsx.writeBuffer()), "banner.xlsx")).body.data.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.imported_rows, 1);

    const late = new ExcelJS.Workbook();
    const ls = late.addWorksheet("S");
    ls.getRow(12).values = ["Full Name", "Mobile Number", "District"];
    ls.getRow(13).values = ["Too Late", "9333333332", "Pune"];
    const failed = await finished((await upload(Buffer.from(await late.xlsx.writeBuffer()), "late.xlsx")).body.data.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /No header row found in the first 10 rows/);
  });
});

