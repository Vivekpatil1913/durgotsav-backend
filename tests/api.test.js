import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { EDITION_YEAR, EDITION_YEAR_MR, fillYear, NUMBER_PREFIX } from "../src/config/edition.js";
import { formatRegistrationNo, parseRegistrationNo } from "../src/utils/format.js";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let pool;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

before(async () => {
  await resetDatabase();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool } = await import("../src/db/pool.js"));
});
after(async () => pool.end());

function register(fields = {}, photo) {
  const req = request(app).post("/api/registrations");
  const data = { participant_type: "individual", name: "राहुल पाटील", phone: "9876543210", district_id: "26", fort_id: "2", consent: "true", ...fields };
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  if (photo !== null) req.attach("photo", photo, { filename: "replica.jpg", contentType: "image/jpeg" });
  return req;
}

describe("auth", () => {
  test("rejects a wrong password with a generic message", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: ADMIN.email, password: "wrong-password" });
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /Invalid email or password/);
  });

  test("logs in and returns a token without the password hash", async () => {
    const res = await request(app).post("/api/auth/login").send(ADMIN);
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.admin.password_hash, undefined);
    token = res.body.token;
  });

  test("admin APIs require a token", async () => {
    assert.equal((await request(app).get("/api/admin/registrations")).status, 401);
    assert.equal((await request(app).get("/api/admin/registrations").set("Authorization", "Bearer nonsense")).status, 401);
  });

  test("moderators cannot change settings or manage admins", async () => {
    const created = await request(app).post("/api/admin/admins").set(auth())
      .send({ name: "Moderator", email: "mod@test.local", role: "moderator", password: "Moderator123" });
    assert.equal(created.status, 201);
    const login = await request(app).post("/api/auth/login").send({ email: "mod@test.local", password: "Moderator123" });
    const mod = { Authorization: `Bearer ${login.body.token}` };
    assert.equal((await request(app).put("/api/admin/settings").set(mod).send({})).status, 403);
    assert.equal((await request(app).get("/api/admin/admins").set(mod)).status, 403);
    assert.equal((await request(app).get("/api/admin/registrations").set(mod)).status, 200);
  });
});

describe("registration → verification → certificate", () => {
  let reg;
  let photo;

  test("validates required fields", async () => {
    const res = await register({ name: "", phone: "12345", consent: "false" }, null);
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.name);
    assert.ok(res.body.error.details.phone);
    assert.ok(res.body.error.details.consent);
  });

  test("rejects files that are not really images", async () => {
    const res = await register({}, Buffer.from("this is not a jpeg at all".repeat(50)));
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not a valid image/);
  });

  test("organisation types need an organisation name", async () => {
    const res = await register({ participant_type: "school" }, await makePhoto());
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.organization_name);
  });

  test("creates a pending registration and EXIF-free WebP copies", async () => {
    photo = await makePhoto();
    const res = await register({ email: "rahul@test.local" }, photo);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    reg = res.body.data;
    assert.match(reg.registration_no, new RegExp(`^${NUMBER_PREFIX}-\\d{6}$`));
    assert.equal(reg.status, "pending");

    const detail = await request(app).get(`/api/admin/registrations/${reg.id}`).set(auth());
    const p = detail.body.data.photos[0];
    assert.match(p.image_path, /\.webp$/);
    const img = await request(app).get(p.image_path).buffer(true);
    assert.equal(img.status, 200);
    assert.equal((await sharp(img.body).metadata()).exif, undefined);
  });

  test("flags a re-uploaded copy of the same photo as a duplicate", async () => {
    const recompressed = await sharp(photo).resize(700).jpeg({ quality: 60 }).toBuffer();
    const res = await register({ name: "दुसरी व्यक्ती", phone: "9123456780" }, recompressed);
    assert.equal(res.status, 201);
    const list = await request(app).get("/api/admin/registrations?duplicates=true").set(auth());
    assert.ok(list.body.data.some((r) => r.id === res.body.data.id));
    assert.ok(!list.body.data.some((r) => r.id === reg.id), "the original is not the duplicate");
  });

  test("status lookup needs the matching mobile number", async () => {
    const wrong = await request(app).get("/api/registrations/status").query({ registration: reg.registration_no, phone: "9000000000" });
    assert.equal(wrong.status, 404);
    const ok = await request(app).get("/api/registrations/status").query({ registration: String(reg.id), phone: "9876543210" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.status, "pending");
    assert.equal(ok.body.data.certificate_available, false);
  });

  test("unverified photos are not public and certificates are not available", async () => {
    const album = await request(app).get("/api/images?page=1");
    assert.equal(album.body.total_images, 0);
    const cert = await request(app).get("/api/certificates/download").query({ registration: reg.registration_no, phone: "9876543210" });
    assert.equal(cert.status, 409);
  });

  test("request_info requires a note, then the participant can resubmit", async () => {
    const noNote = await request(app).post(`/api/admin/registrations/${reg.id}/review`).set(auth()).send({ action: "request_info" });
    assert.equal(noNote.status, 400);
    const ask = await request(app).post(`/api/admin/registrations/${reg.id}/review`).set(auth())
      .send({ action: "request_info", note: "प्रतिकृती स्पष्ट दिसत नाही" });
    assert.equal(ask.body.data.status, "info_requested");

    const status = await request(app).get("/api/registrations/status").query({ registration: reg.registration_no, phone: "9876543210" });
    assert.equal(status.body.data.note, "प्रतिकृती स्पष्ट दिसत नाही");

    const re = await request(app).post(`/api/registrations/${reg.registration_no}/resubmit`)
      .field("phone", "9876543210").attach("photo", await makePhoto(), "new.jpg");
    assert.equal(re.status, 200, JSON.stringify(re.body));
    assert.equal(re.body.data.status, "pending");
  });

  test("verify issues a certificate that downloads as a PDF", async () => {
    const res = await request(app).post(`/api/admin/registrations/${reg.id}/review`).set(auth()).send({ action: "verify" });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "verified");
    assert.match(res.body.data.certificate.certificate_no, new RegExp(`^AMRUT-${NUMBER_PREFIX}-`));

    const pdf = await request(app).get("/api/certificates/download")
      .query({ registration: reg.registration_no, phone: "9876543210" }).buffer(true).parse((r, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.equal(pdf.body.subarray(0, 5).toString(), "%PDF-");

    const verify = await request(app).get(`/api/certificates/verify/${res.body.data.certificate.certificate_no}`);
    assert.equal(verify.body.data.valid, true);
  });

  test("verified photo appears in the album; featuring adds it to the gallery", async () => {
    const album = await request(app).get("/api/images?page=1");
    assert.equal(album.body.total_images, 1);
    assert.equal(album.body.page_size, 20);
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 0);

    const detail = await request(app).get(`/api/admin/registrations/${reg.id}`).set(auth());
    const current = detail.body.data.photos.find((p) => p.is_current);
    await request(app).post("/api/admin/registrations/photos/feature").set(auth()).send({ photo_ids: [current.id], featured: true });
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 1);
  });

  test("rejecting a verified registration revokes its certificate and unpublishes the photo", async () => {
    await request(app).post(`/api/admin/registrations/${reg.id}/review`).set(auth()).send({ action: "reject", note: "बनावट छायाचित्र" });
    const verify = await request(app).get(`/api/certificates/verify/AMRUT-${NUMBER_PREFIX}-${String(reg.id).padStart(6, "0")}`);
    assert.equal(verify.body.data.valid, false);
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 0);
    assert.equal((await request(app).get("/api/images")).body.total_images, 0);
  });

  test("bulk verify, soft delete and restore", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await register({ phone: `98000000${10 + i}` }, await makePhoto())).body.data.id);
    const bulk = await request(app).post("/api/admin/registrations/bulk-review").set(auth()).send({ ids, action: "verify" });
    assert.deepEqual(bulk.body.data.updated.sort(), ids.sort());
    assert.equal((await request(app).get("/api/stats")).body.data.verified, 3);

    assert.equal((await request(app).delete(`/api/admin/registrations/${ids[0]}`).set(auth())).status, 204);
    assert.equal((await request(app).get("/api/images")).body.total_images, 2);
    assert.equal((await request(app).post(`/api/admin/registrations/${ids[0]}/restore`).set(auth())).status, 200);
    assert.equal((await request(app).get("/api/images")).body.total_images, 3);
  });

  test("CSV export neutralises formula injection", async () => {
    await register({ name: "=HYPERLINK(\"x\")", phone: "9811111111" }, await makePhoto());
    const csv = await request(app).get("/api/admin/registrations/export.csv").set(auth());
    assert.equal(csv.status, 200);
    assert.match(csv.text, /'=HYPERLINK/);
  });
});

describe("CMS", () => {
  test("fort CRUD with slug, toggle, soft delete and restore", async () => {
    const created = await request(app).post("/api/admin/forts").set(auth())
      .send({ name_mr: "तोरणा", name_en: "Torna Fort", fort_type: "hill", facts: [{ label: "जिल्हा", value: "पुणे" }], is_unesco: false });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const fort = created.body.data;
    assert.equal(fort.slug, "torna-fort");
    assert.deepEqual(fort.facts, [{ label: "जिल्हा", value: "पुणे" }]);
    assert.equal((await request(app).get("/api/forts/torna-fort")).status, 200);

    await request(app).patch(`/api/admin/forts/${fort.id}/toggle`).set(auth());
    assert.equal((await request(app).get("/api/forts/torna-fort")).status, 404);

    const dup = await request(app).post("/api/admin/forts").set(auth()).send({ name_mr: "x", name_en: "y", slug: "rajgad" });
    assert.equal(dup.status, 409);

    assert.equal((await request(app).delete(`/api/admin/forts/${fort.id}`).set(auth())).status, 204);
    const trash = await request(app).get("/api/admin/forts?trashed=true").set(auth());
    assert.ok(trash.body.data.some((f) => f.id === fort.id));
    assert.equal((await request(app).post(`/api/admin/forts/${fort.id}/restore`).set(auth())).status, 200);
  });

  test("settings update accepts known keys only", async () => {
    const res = await request(app).put("/api/admin/settings").set(auth())
      .send({ registration: { enabled: false, opens_at: "2026-11-05T00:00:00+05:30", closes_at: "2027-11-25T23:59:59+05:30" } });
    assert.equal(res.status, 200);
    const bad = await request(app).put("/api/admin/settings").set(auth()).send({ unknown_key: 1 });
    assert.equal(bad.status, 400);
  });

  test("important dates are validated, saved and public", async () => {
    const dates = { festival_begins: "2026-11-02", upload_opens: "2026-11-06", upload_closes: "2026-11-21" };
    const res = await request(app).put("/api/admin/settings").set(auth()).send({ important_dates: dates });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.important_dates, dates);

    const pub = await request(app).get("/api/settings");
    assert.deepEqual(pub.body.data.important_dates, dates);

    const reversed = await request(app).put("/api/admin/settings").set(auth())
      .send({ important_dates: { ...dates, upload_closes: "2026-11-01" } });
    assert.equal(reversed.status, 400);
    assert.ok(reversed.body.error.details["important_dates.upload_closes"]);

    const invalid = await request(app).put("/api/admin/settings").set(auth())
      .send({ important_dates: { ...dates, festival_begins: "2026-02-30" } });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error.details["important_dates.festival_begins"]);
  });

  test("public settings fill in {year}; the admin API keeps the placeholder", async () => {
    const admin = await request(app).get("/api/admin/settings").set(auth());
    assert.equal(admin.body.data.seo.site_name, "अमृत दुर्गोत्सव {year}");
    const pub = await request(app).get("/api/settings");
    assert.equal(pub.body.data.seo.site_name, `अमृत दुर्गोत्सव ${EDITION_YEAR_MR}`);
    assert.equal(pub.body.data.edition_year, EDITION_YEAR);
    assert.deepEqual(fillYear({ title: "दुर्गोत्सव {year}", title_en: "Durgotsav {year}", list: ["{year}"] }),
      { title: `दुर्गोत्सव ${EDITION_YEAR_MR}`, title_en: `Durgotsav ${EDITION_YEAR}`, list: [EDITION_YEAR_MR] });
  });

  test("registration numbers follow the edition and earlier editions' numbers still resolve", () => {
    assert.equal(formatRegistrationNo(123), `${NUMBER_PREFIX}-000123`);
    assert.equal(parseRegistrationNo("DGT25-000123"), 123);
    assert.equal(parseRegistrationNo("dgt26000123"), 123);
    assert.equal(parseRegistrationNo("123"), 123);
    assert.equal(parseRegistrationNo("DGT123"), null);
  });

  test("contact form validates and stores enquiries", async () => {
    assert.equal((await request(app).post("/api/contact").send({ name: "A", message: "short" })).status, 400);
    const ok = await request(app).post("/api/contact").send({ name: "सुनील", phone: "9876500000", message: "फोटो अपलोड होत नाही, मदत करा." });
    assert.equal(ok.status, 201);
    const list = await request(app).get("/api/admin/enquiries?status=new").set(auth());
    assert.equal(list.body.meta.total, 1);
  });

  test("dashboard aggregates", async () => {
    const res = await request(app).get("/api/admin/stats/dashboard").set(auth());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.daily.length, 30);
    assert.ok(res.body.data.totals.registrations >= 5);
    assert.equal(res.body.data.by_fort.length, 13);
  });
});
