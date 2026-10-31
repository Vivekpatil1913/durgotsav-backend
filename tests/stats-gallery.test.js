// Statistics, the home page, the public and admin photo galleries, forts and the 2025 URLs at scale: what each one
// reads, what it shares between requests, and when an admin's change shows.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import request from "supertest";
import { formatRegistrationNo } from "../src/utils/format.js";
import { ADMIN, makePhoto, resetDatabase } from "./helpers.js";

let app;
let db;
let closePools;
let gallery;
let stats;
let token;
let modToken;
const auth = () => ({ Authorization: `Bearer ${token}` });
const asMod = () => ({ Authorization: `Bearer ${modToken}` });
const sql = (text, params) => db.query(text, params);

// Production servers usually run in UTC; the test database does too, so the IST day logic is really exercised
async function useUtcSessions() {
  const client = new pg.Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  await client.connect();
  await client.query(`ALTER DATABASE "${process.env.DB_NAME}" SET timezone TO 'UTC'`);
  await client.end();
}

before(async () => {
  await resetDatabase();
  await useUtcSessions();
  ({ createApp: app } = await import("../src/app.js"));
  app = app();
  ({ pool: db, closePools } = await import("../src/db/pool.js"));
  gallery = await import("../src/modules/gallery/gallery.service.js");
  stats = await import("../src/modules/stats/stats.service.js");
  token = (await request(app).post("/api/auth/login").send(ADMIN)).body.token;
});
after(async () => closePools());

// A new registration, each with its own mobile number (kept with the result, for the searches below)
let phoneNo = 0;
async function registered(fields = {}, photo) {
  phoneNo += 1;
  const data = {
    participant_type: "individual", name: "राहुल पाटील", phone: `97000000${String(phoneNo).padStart(2, "0")}`,
    district_id: "26", fort_id: "2", consent: "true", ...fields,
  };
  const req = request(app).post("/api/registrations");
  for (const [k, v] of Object.entries(data)) req.field(k, v);
  const res = await req.attach("photo", photo ?? await makePhoto(), { filename: "replica.jpg", contentType: "image/jpeg" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...res.body.data, phone: data.phone };
}

const mainPhoto = async (registrationId) =>
  (await sql("SELECT id FROM registration_photos WHERE registration_id = $1 AND is_current AND position = 1", [registrationId])).rows[0].id;

const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

describe("home page", () => {
  test("/home sends only what the website renders and never waits for the counters", async () => {
    const home = await request(app).get("/api/home");
    assert.equal(home.status, 200);
    assert.deepEqual(Object.keys(home.body.data).sort(), ["forts", "gallery", "stats", "testimonials"]);
    assert.equal(home.body.data.stats, null, "a cold counter cache is filled in the background");
    assert.match(home.headers["cache-control"], /^public, max-age=60/);
    const forts = (await request(app).get("/api/forts")).body.data;
    assert.deepEqual(home.body.data.forts.map((f) => f.id), forts.map((f) => f.id));
    assert.ok(forts.length && forts.every((f) => !("replica_count" in f)));

    // /stats waits for that same computation; /home serves it from then on
    const counters = (await request(app).get("/api/stats")).body.data;
    assert.deepEqual(Object.keys(counters).sort(), ["certificates", "districts", "forts", "participants", "verified"]);
    assert.deepEqual((await request(app).get("/api/home")).body.data.stats, counters);
  });

  test("a home section that fails is sent empty and the response is not cached", async () => {
    await sql("ALTER TABLE testimonials RENAME TO testimonials_moved");
    try {
      const home = await request(app).get("/api/home");
      assert.equal(home.status, 200);
      assert.deepEqual(home.body.data.testimonials, []);
      assert.ok(home.body.data.forts.length > 0);
      assert.equal(home.headers["cache-control"], "no-store");
    } finally {
      await sql("ALTER TABLE testimonials_moved RENAME TO testimonials");
    }
    assert.match((await request(app).get("/api/home")).headers["cache-control"], /^public/);
  });

  test("the counters count participants, verified registrations and districts", async () => {
    const konkan = await registered({ district_id: "1" });
    const amravati = await registered();
    await registered({ district_id: "27" });
    await request(app).post(`/api/admin/registrations/${konkan.id}/review`).set(auth()).send({ action: "verify" });
    await request(app).post(`/api/admin/registrations/${amravati.id}/review`).set(auth())
      .send({ action: "reject", note: "छायाचित्र स्पष्ट नाही" });
    stats.invalidateStatsCache();
    const counters = (await request(app).get("/api/stats")).body.data;
    // the rejected registration is not a participant, and its district has no other
    assert.deepEqual(
      { participants: counters.participants, verified: counters.verified, certificates: counters.certificates, districts: counters.districts },
      { participants: 2, verified: 1, certificates: 1, districts: 2 },
    );
  });
});

describe("forts", () => {
  test("the public list is shared, and every admin change to the forts shows at once", async () => {
    const list = async () => (await request(app).get("/api/forts")).body.data;
    const [first, second] = await list();

    assert.equal((await request(app).put(`/api/admin/forts/${first.id}`).set(auth()).send({ tagline: "नवी ओळ" })).status, 200);
    assert.equal((await list())[0].tagline, "नवी ओळ");

    await request(app).patch(`/api/admin/forts/${first.id}/toggle`).set(auth());
    assert.ok(!(await list()).some((f) => f.id === first.id));
    await request(app).patch(`/api/admin/forts/${first.id}/toggle`).set(auth());
    assert.ok((await list()).some((f) => f.id === first.id));

    const created = await request(app).post("/api/admin/forts").set(auth()).send({ name_mr: "तोरणा", name_en: "Torna", sort_order: 99 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await list()).at(-1).slug, "torna");
    await request(app).delete(`/api/admin/forts/${created.body.data.id}`).set(auth());
    assert.ok(!(await list()).some((f) => f.slug === "torna"));
    await request(app).post(`/api/admin/forts/${created.body.data.id}/restore`).set(auth());
    assert.ok((await list()).some((f) => f.slug === "torna"));

    const reordered = await request(app).put("/api/admin/forts/reorder").set(auth())
      .send({ items: [{ id: first.id, sort_order: 200 }, { id: second.id, sort_order: 150 }] });
    assert.equal(reordered.status, 200);
    assert.deepEqual((await list()).slice(-2).map((f) => f.id), [second.id, first.id]);
  });

  test("a reorder is one statement: all of it is saved or none", async () => {
    const before = (await sql("SELECT id, sort_order FROM forts ORDER BY id LIMIT 2")).rows;
    const res = await request(app).put("/api/admin/forts/reorder").set(auth())
      .send({ items: [{ id: before[0].id, sort_order: 7 }, { id: before[1].id, sort_order: 3_000_000_000 }] });
    assert.equal(res.status, 400);
    assert.deepEqual((await sql("SELECT id, sort_order FROM forts ORDER BY id LIMIT 2")).rows, before);
  });
});

describe("request bounds and the 2025 URLs", () => {
  test("page and id parameters outside their columns are 400s, not database errors", async () => {
    for (const url of ["/api/gallery?page=100001", "/api/gallery?district_id=32768", "/api/images?fort_id=2147483648",
      "/api/podcasts?page=100001", "/images?page=100001"]) {
      assert.equal((await request(app).get(url)).status, 400, url);
    }
    assert.equal((await request(app).get("/api/gallery?page=100000&district_id=32767")).status, 200);
    assert.equal((await request(app).get("/api/admin/website-gallery?page=501").set(auth())).status, 400);
    assert.equal((await request(app).get("/api/admin/website-gallery?division_id=40000").set(auth())).status, 400);
    assert.equal((await request(app).get("/api/admin/forts/2147483648").set(auth())).status, 400);
  });

  test("the 2025 URLs are cached and rate-limited like their /api counterparts", async () => {
    const images = await request(app).get("/images");
    assert.equal(images.status, 200);
    assert.equal(images.headers["cache-control"], "public, max-age=30, stale-while-revalidate=120");
    assert.ok(images.headers["ratelimit-policy"], "counted by the API limiter");

    const latest = await request(app).get("/gallery-images");
    assert.equal(latest.headers["cache-control"], "public, max-age=60, stale-while-revalidate=240");
    assert.ok(Array.isArray(latest.body.images));
    assert.ok(latest.headers["ratelimit-policy"]);

    const counters = await request(app).get("/admin-stats");
    assert.equal(typeof counters.body.total_durgaveers, "number");
    assert.equal(counters.headers["cache-control"], "public, max-age=60, stale-while-revalidate=240");
    assert.ok(counters.headers["ratelimit-policy"]);
  });
});

describe("website gallery", () => {
  const list = (query = {}, headers = auth()) => request(app).get("/api/admin/website-gallery").query(query).set(headers);
  const toggle = (photoId, featured, headers = auth()) =>
    request(app).post("/api/admin/website-gallery/toggle").set(headers).send({ photo_id: photoId, featured });
  const people = {};

  before(async () => {
    await sql("UPDATE registrations SET deleted_at = NOW()"); // a clean slate for exact counts
    gallery.clearGalleryCache();
    people.konkan = await registered({ name: "Konkan Kar", district_id: "1" });
    people.anita = await registered({ name: "Anita Pawar", email: "anita@test.local" });
    people.sunil = await registered({ name: "सुनील जाधव" });
    people.ravi = await registered({ name: "Ravi More" });
    people.waiting = await registered({ name: "Pending Person" });
    const ids = ["konkan", "anita", "sunil", "ravi"].map((k) => people[k].id);
    const bulk = await request(app).post("/api/admin/registrations/bulk-review").set(auth()).send({ ids, action: "verify" });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    for (const key of Object.keys(people)) people[key].photo = await mainPhoto(people[key].id);
  });

  test("a whole tab is counted once per scope, and a toggle shows on the website at once", async () => {
    let res = await list();
    assert.equal(res.status, 200);
    let { counts, meta } = res.body.data;
    assert.deepEqual([counts.total_verified, counts.total_on_website, counts.total_off_website], [4, 0, 4]);
    assert.deepEqual([counts.filter_total, counts.filter_selected, counts.filter_unselected, counts.filter_total_capped], [4, 0, 4, false]);
    assert.deepEqual([meta.total, meta.totalPages, meta.capped], [4, 1, false]);
    assert.equal(res.body.data.data[0].registration_id, people.ravi.id, "newest first");
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 0);

    res = await toggle(people.ravi.photo, true);
    assert.equal(res.body.data.updated, true);
    // the change drops this instance's shared counts and latest photos
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 1);
    assert.equal((await request(app).get("/api/images")).body.total_images, 1);
    assert.deepEqual((await request(app).get("/api/home")).body.data.gallery.map((p) => p.id), [people.ravi.photo]);
    assert.deepEqual((await request(app).get("/gallery-images")).body.images.map((p) => p.image_id), [people.ravi.photo]);

    ({ counts } = (await list()).body.data);
    assert.deepEqual([counts.total_on_website, counts.total_off_website], [1, 3]);
    res = await list({ display_status: "selected" });
    ({ counts } = res.body.data);
    assert.deepEqual([counts.filter_total, counts.filter_selected, counts.filter_unselected], [1, 1, 0]);
    assert.deepEqual(res.body.data.data.map((p) => p.photo_id), [people.ravi.photo]);
    res = await list({ display_status: "unselected", sort: "display_last" });
    assert.deepEqual([res.body.data.counts.filter_total, res.body.data.data.length], [3, 3]);
  });

  test("filters are counted up to the cap; search reads only indexed columns", async () => {
    let { counts, data } = (await list({ division_id: 5, district_id: 26, sort: "display_first" })).body.data;
    assert.deepEqual([counts.filter_total, counts.filter_selected, counts.filter_unselected, counts.filter_total_capped], [3, 1, 2, false]);
    assert.equal(data[0].photo_id, people.ravi.photo, "on the website first");
    assert.equal(counts.total_verified, 4, "the tabs still count the whole scope");

    const found = async (q) => (await list({ q })).body.data.data.map((p) => p.registration_id).sort((a, b) => a - b);
    assert.deepEqual(await found("Anita"), [people.anita.id]);
    assert.deepEqual(await found("anita@test"), [people.anita.id]);
    assert.deepEqual(await found("सुनील"), [people.sunil.id]);
    assert.deepEqual(await found(people.konkan.phone), [people.konkan.id]);
    assert.deepEqual(await found(people.konkan.phone.slice(-4)), [people.konkan.id], "part of a mobile number");
    assert.deepEqual(await found(formatRegistrationNo(people.ravi.id)), [people.ravi.id]);
    assert.deepEqual(await found("Ra"), [], "two letters match only a registration number");
    assert.deepEqual(await found("Amravati"), [], "district and fort names are dropdown filters, not search");
    ({ counts } = (await list({ q: "Anita" })).body.data);
    assert.deepEqual([counts.filter_total, counts.filter_selected, counts.filter_total_capped], [1, 0, false]);
  });

  test("a photo is shown only for a live verified registration in the admin's divisions", async () => {
    assert.equal((await toggle(people.waiting.photo, true)).body.data.updated, false, "still pending");

    await request(app).delete(`/api/admin/registrations/${people.sunil.id}`).set(auth());
    assert.equal((await toggle(people.sunil.photo, true)).body.data.updated, false, "deleted");
    await request(app).post(`/api/admin/registrations/${people.sunil.id}/restore`).set(auth());

    const roles = (await request(app).get("/api/admin/rbac").set(auth())).body.data;
    const moderator = roles.find((r) => r.slug === "moderator");
    const created = await request(app).post("/api/admin/admins").set(auth())
      .send({ name: "Amravati Moderator", email: "amravati@test.local", role_id: moderator.id, password: "Moderator123" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await sql(`UPDATE roles SET permissions = permissions || '{"website_gallery": {"read": true, "write": true}}' WHERE slug = 'moderator'`);
    await sql("INSERT INTO admin_divisions (admin_id, division_id) VALUES ($1, 5)", [created.body.data.id]);
    modToken = (await request(app).post("/api/auth/login").send({ email: "amravati@test.local", password: "Moderator123" })).body.token;

    const { counts } = (await list({}, asMod())).body.data;
    assert.deepEqual([counts.total_verified, counts.total_on_website], [3, 1], "the moderator's division only");
    assert.equal((await toggle(people.konkan.photo, true, asMod())).body.data.updated, false, "another division");
    assert.equal((await toggle(people.anita.photo, true, asMod())).body.data.updated, true);
    assert.equal((await request(app).get("/api/gallery")).body.meta.total, 2);
  });

  test("hiding needs no status check", async () => {
    // reset keeps the photo selected; it is no longer public, and an admin can still take it off the website
    await request(app).post(`/api/admin/registrations/${people.anita.id}/review`).set(auth()).send({ action: "reset" });
    assert.equal((await toggle(people.anita.photo, false)).body.data.updated, true);
    const { rows } = await sql("SELECT is_featured FROM registration_photos WHERE id = $1", [people.anita.photo]);
    assert.equal(rows[0].is_featured, false);
  });

  test("small gallery sets are shared for a few seconds; an admin change drops them at once", async () => {
    gallery.clearGalleryCache();
    const total = async () => (await request(app).get("/api/gallery?district_id=26")).body.meta.total;
    const before = await total();
    // a change made around the services (as by another instance) is not seen until the short window passes ...
    await sql("UPDATE registration_photos SET is_featured = TRUE WHERE id = $1", [people.sunil.photo]);
    assert.equal(await total(), before);
    // ... while every admin change on this instance clears the shared summaries
    gallery.clearGalleryCache();
    assert.equal(await total(), before + 1);
  });
});

describe("admin statistics", () => {
  test("the dashboard counts per status in one pass, with today and the daily chart in IST", async () => {
    const original = await makePhoto();
    const first = await registered({ name: "पहिला" }, original);
    const copy = await registered({ name: "दुसरा" }, await sharp(original).resize(700).jpeg({ quality: 60 }).toBuffer());
    // one registration just after IST midnight (still "yesterday" in UTC), one just before it
    const midnight = "(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
    await sql(`UPDATE registrations SET created_at = ${midnight} + interval '1 second' WHERE id = $1`, [first.id]);
    await sql(`UPDATE registrations SET created_at = ${midnight} - interval '1 second' WHERE id = $1`, [copy.id]);

    stats.invalidateStatsCache();
    const res = await request(app).get("/api/admin/stats/dashboard").set(auth());
    assert.equal(res.status, 200);
    const { totals, daily, by_type: byType } = res.body.data;
    const { rows: [expected] } = await sql(`
      SELECT COUNT(*)::int AS registrations,
             COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
             COUNT(*) FILTER (WHERE created_at >= ${midnight})::int AS today,
             COUNT(*) FILTER (WHERE created_at >= ${midnight} - interval '1 day' AND created_at < ${midnight})::int AS yesterday
      FROM registrations WHERE deleted_at IS NULL`);
    assert.deepEqual(
      { registrations: totals.registrations, pending: totals.pending, verified: totals.verified, today: totals.today },
      { registrations: expected.registrations, pending: expected.pending, verified: expected.verified, today: expected.today },
    );
    assert.equal(daily.length, 30);
    assert.deepEqual(daily.at(-1), { day: istToday(), count: expected.today });
    assert.equal(daily.at(-2).count, expected.yesterday);
    assert.ok(expected.yesterday >= 1);
    assert.equal(totals.pending_duplicates, 1, "the re-uploaded photo, waiting in the queue");
    const { rows: [shown] } = await sql(`
      SELECT COUNT(*)::int AS n FROM registration_photos p JOIN registrations r ON r.id = p.registration_id
      WHERE p.is_current AND p.position = 1 AND p.is_featured AND r.status = 'verified' AND r.deleted_at IS NULL`);
    assert.equal(totals.gallery_photos, shown.n);
    assert.equal(totals.certificates, (await sql("SELECT COUNT(*)::int AS n FROM certificates WHERE revoked_at IS NULL")).rows[0].n);
    assert.equal(byType, undefined);
    for (const key of ["info_requested", "rejected", "duplicate", "certificates_emailed", "forts", "events", "videos", "new_enquiries"]) {
      assert.equal(typeof totals[key], "number", key);
    }
  });

  test("a scoped dashboard counts its own divisions, certificates included", async () => {
    const res = await request(app).get("/api/admin/stats/dashboard").set(asMod());
    assert.equal(res.status, 200);
    const { rows: [expected] } = await sql(`
      SELECT COUNT(*)::int AS registrations, COUNT(c.id) FILTER (WHERE c.revoked_at IS NULL)::int AS certificates
      FROM registrations r LEFT JOIN certificates c ON c.registration_id = r.id
      WHERE r.deleted_at IS NULL AND r.division_id = 5`);
    assert.equal(res.body.data.totals.registrations, expected.registrations);
    assert.equal(res.body.data.totals.certificates, expected.certificates);
    const all = await request(app).get("/api/admin/stats/dashboard").set(auth());
    assert.ok(all.body.data.totals.registrations > expected.registrations);
  });

  test("district, division and city tables add up to the registrations", async () => {
    stats.invalidateStatsCache();
    const { rows: [live] } = await sql(`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE district_id = 26)::int AS amravati,
             COUNT(*) FILTER (WHERE division_id = 5)::int AS division
      FROM registrations WHERE deleted_at IS NULL`);
    const districts = (await request(app).get("/api/admin/stats/districts?limit=100").set(auth())).body.data.items;
    assert.equal(districts.reduce((sum, d) => sum + d.total, 0), live.total);
    assert.equal(districts.find((d) => d.id === 26).total, live.amravati);
    const divisions = (await request(app).get("/api/admin/stats/divisions?limit=100").set(auth())).body.data.items;
    assert.equal(divisions.find((d) => d.id === 5).total, live.division);
    const cities = (await request(app).get("/api/admin/stats/cities?limit=100").set(auth())).body.data.items;
    assert.equal(cities.reduce((sum, c) => sum + c.registrations, 0), live.total);
    assert.equal(cities.reduce((sum, c) => sum + c.uploaded, 0), live.total, "every registration has its main photo");
  });
});

describe("visitor counter", () => {
  test("rows older than yesterday are pruned in batches after the first visit of the hour", async () => {
    const day = "(NOW() AT TIME ZONE 'Asia/Kolkata')::date";
    await sql(`INSERT INTO site_visitor_days (day, visitor_hash)
               SELECT ${day} - 5, md5(g::text) || md5((-g)::text) FROM generate_series(1, 25000) g`);
    const res = await request(app).post("/api/visits").send({ visitor_id: crypto.randomUUID() });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.counted, true);
    // the prune runs in the background, 10,000 rows per statement
    const deadline = Date.now() + 20_000;
    let left;
    do {
      left = (await sql(`SELECT COUNT(*)::int AS n FROM site_visitor_days WHERE day < ${day} - 1`)).rows[0].n;
      if (left) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (left && Date.now() < deadline);
    assert.equal(left, 0);
    assert.equal((await sql(`SELECT COUNT(*)::int AS n FROM site_visitor_days WHERE day = ${day}`)).rows[0].n, 1);
  });
});
