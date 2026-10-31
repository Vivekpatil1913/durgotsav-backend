// Measures the API's hot endpoints under concurrency (npm run perf:bench) — run it against an API that uses a database
// filled by scripts/perf-seed.js:
//
//   DB_NAME=durgotsav_2026_load NODE_ENV=test CAPTCHA_PROVIDER=off CERTIFICATE_WORKER=off REGISTRATION_FORCE_OPEN=true PORT=4120 node src/server.js
//   node scripts/perf-bench.js http://localhost:4120 load@test.local LoadPassword123
//
// NODE_ENV=test lifts the per-IP rate limits (every request here comes from one address); CAPTCHA off lets the
// lookups and registrations through, and REGISTRATION_FORCE_OPEN keeps the form open whatever the admin switch says.
// Prints p50 / p95 / max latency and errors per scenario.
import crypto from "node:crypto";
import sharp from "sharp";

const [BASE = "http://localhost:4120", EMAIL = "load@test.local", PASSWORD = "LoadPassword123"] = process.argv.slice(2);
const api = (path) => `${BASE}/api${path}`;

async function timed(fn) {
  const started = performance.now();
  try {
    const res = await fn();
    const ms = performance.now() - started;
    if (!res.ok) return { ms, error: `${res.status}` };
    await res.arrayBuffer();
    return { ms: performance.now() - started };
  } catch (err) {
    return { ms: performance.now() - started, error: err.message };
  }
}

// `count` requests, at most `concurrency` at a time; request(i) returns a fetch promise
async function scenario(name, { count = 40, concurrency = 8 }, request) {
  const results = [];
  let next = 0;
  const lane = async () => {
    while (next < count) {
      const i = next++;
      results.push(await timed(() => request(i)));
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, lane));
  const wall = performance.now() - started;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  const errors = results.filter((r) => r.error);
  const row = {
    scenario: name,
    n: count,
    conc: concurrency,
    p50: Math.round(pct(50)),
    p95: Math.round(pct(95)),
    max: Math.round(ms[ms.length - 1]),
    "req/s": Math.round((count / wall) * 1000),
    errors: errors.length ? `${errors.length} (${[...new Set(errors.map((e) => e.error))].join(",")})` : "",
  };
  console.log(JSON.stringify(row));
  return row;
}

const json = async (url, init) => (await fetch(url, init)).json();

const { token } = await json(api("/auth/login"), {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!token) throw new Error("Login failed");
const admin = { headers: { Authorization: `Bearer ${token}` } };
const adminGet = (path) => fetch(api(path), admin);

// Sample data from the API itself
const page1 = await json(api("/admin/registrations?limit=10"), admin);
const total = page1.meta.total;
const someId = page1.data[5].id;
const certs = await json(api("/admin/certificates?limit=5"), admin);
const certNo = certs.data[0].certificate_no;
const busyPhone = "9800000007";
const lookup = await json(api("/certificates/lookup"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: busyPhone }) });
const linkToken = lookup.data[0].token;
console.log(`registrations: ${total}, busy phone ${busyPhone}: ${lookup.meta.total} registrations`);

const rows = [];
const add = async (...args) => rows.push(await scenario(...args));
// The deepest page an admin list still serves (counting and browsing stop at 10,000 matches)
const deepPage = Math.max(1, Math.min(990, Math.floor(total / 10 / 2)));

// ---------------- public
await add("GET /settings", { count: 200, concurrency: 20 }, () => fetch(api("/settings")));
await add("GET /stats", { count: 200, concurrency: 20 }, () => fetch(api("/stats")));
await add("GET /home", { count: 100, concurrency: 20 }, () => fetch(api("/home")));
await add("GET /gallery page 1", { count: 100, concurrency: 20 }, () => fetch(api("/gallery?page=1")));
await add("GET /gallery deep page", { count: 50, concurrency: 10 }, (i) => fetch(api(`/gallery?page=${2000 + i}`)));
await add("GET /images page 1", { count: 100, concurrency: 20 }, () => fetch(api("/images?page=1")));
await add("GET /images deep page", { count: 50, concurrency: 10 }, (i) => fetch(api(`/images?page=${1500 + i}`)));
await add("GET /forts", { count: 100, concurrency: 20 }, () => fetch(api("/forts")));
await add("GET /certificates/verify/:no", { count: 100, concurrency: 20 }, () => fetch(api(`/certificates/verify/${certNo}`)));
await add("GET /certificates/link/:token", { count: 100, concurrency: 20 }, () => fetch(api(`/certificates/link/${linkToken}`)));
await add("POST /certificates/lookup (busy phone)", { count: 60, concurrency: 10 }, () =>
  fetch(api("/certificates/lookup"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: busyPhone }) }));
// a page in the middle of the busy number's registrations (keyset: as cheap as page 2)
const middle = Number(lookup.data[0].registration_no.split("-")[1]) - 1_000_000;
await add("GET /certificates/lookup deep page", { count: 60, concurrency: 10 }, () =>
  fetch(api(`/certificates/lookup?lookup_token=${lookup.meta.lookup_token}&before=${middle}`)));
await add("GET /registrations/status", { count: 100, concurrency: 20 }, () =>
  fetch(api(`/registrations/status?registration=${page1.data[0].registration_no}&phone=${page1.data[0].phone}`)));
await add("GET certificate PDF (link)", { count: 40, concurrency: 8 }, async () => {
  const verified = lookup.data.find((r) => r.certificate_available);
  return fetch(api(`/certificates/link/${verified.token}/download`));
});

// ---------------- admin
await add("admin list newest", { count: 60, concurrency: 10 }, () => adminGet("/admin/registrations?limit=10"));
await add("admin list deep page", { count: 30, concurrency: 5 }, (i) => adminGet(`/admin/registrations?limit=10&page=${deepPage + i}`));
await add("admin list pending (queue)", { count: 60, concurrency: 10 }, () => adminGet("/admin/registrations?status=pending&sort=oldest&limit=10"));
await add("admin list district+status", { count: 60, concurrency: 10 }, () => adminGet("/admin/registrations?district_id=7&status=verified&limit=10"));
await add("admin list sort by name", { count: 60, concurrency: 10 }, () => adminGet("/admin/registrations?sort=name&dir=asc&limit=10"));
await add("admin search name", { count: 40, concurrency: 8 }, () => adminGet(`/admin/registrations?q=${encodeURIComponent("स्नेहा मोरे")}&limit=10`));
await add("admin search mobile", { count: 40, concurrency: 8 }, () => adminGet("/admin/registrations?q=9000123&limit=10"));
await add("admin search reg no", { count: 40, concurrency: 8 }, () => adminGet(`/admin/registrations?q=DGT26-${String(someId).padStart(6, "0")}&limit=10`));
await add("admin duplicates tab", { count: 30, concurrency: 5 }, () => adminGet("/admin/registrations?duplicates=true&limit=10"));
await add("admin detail", { count: 60, concurrency: 10 }, () => adminGet(`/admin/registrations/${someId}`));
await add("admin neighbors", { count: 60, concurrency: 10 }, () => adminGet(`/admin/registrations/${someId}/neighbors?status=pending&sort=oldest`));
await add("admin dashboard", { count: 20, concurrency: 5 }, () => adminGet("/admin/stats/dashboard"));
await add("admin district stats", { count: 20, concurrency: 5 }, () => adminGet("/admin/stats/districts"));
await add("admin certificates list", { count: 40, concurrency: 8 }, () => adminGet("/admin/certificates?limit=10"));
await add("admin certificates search", { count: 40, concurrency: 8 }, () => adminGet(`/admin/certificates?q=${encodeURIComponent("राहुल")}&limit=10`));
await add("admin email queue stats", { count: 20, concurrency: 5 }, () => adminGet("/admin/certificates/email-queue"));
await add("admin audit log", { count: 40, concurrency: 8 }, () => adminGet("/admin/audit-logs?limit=10"));

// ---------------- writes
const photos = await Promise.all(Array.from({ length: 60 }, async () => {
  const grid = sharp(crypto.randomBytes(6 * 5 * 3), { raw: { width: 6, height: 5, channels: 3 } });
  return grid.resize(1600, 1200, { kernel: "nearest" }).jpeg({ quality: 85 }).toBuffer();
}));
await add("POST /registrations", { count: 60, concurrency: 10 }, (i) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: `भार चाचणी ${i}`, phone: busyPhone, district_id: "5", consent: "true", country: "India" })) form.append(k, v);
  form.append("photo", new Blob([photos[i]], { type: "image/jpeg" }), "replica.jpg");
  return fetch(api("/registrations"), { method: "POST", body: form });
});
const pending = await json(api("/admin/registrations?status=pending&sort=oldest&limit=100"), admin);
const pendingIds = pending.data.map((r) => r.id);
await add("bulk approve 20 × 5", { count: 5, concurrency: 1 }, (i) =>
  fetch(api("/admin/registrations/bulk-review"), {
    method: "POST", headers: { ...admin.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: pendingIds.slice(i * 20, i * 20 + 20), action: "verify" }),
  }));

console.table(rows);
