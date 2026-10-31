import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";
import { parseLookupToken } from "../modules/certificates/certificate.links.js";

// The client address as the reverse proxy saw it: req.ip honours the app's "trust proxy" setting (the number of
// proxies in front), so it is the address nginx appended — a client can put anything at the START of X-Forwarded-For,
// which is why that header itself is never read here. An IPv6 client gets its whole /64 (one home or phone), so a host
// cannot step through its addresses to escape a limit.
function clientKey(req) {
  const ip = String(req.ip ?? "unknown").split("%")[0];
  if (!ip.includes(":") || /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// NOTE: This uses an in-memory store, which means each Node.js process has its
// own independent counter. Under a multi-instance deployment (load balancer with
// N workers) the effective limit is N × the configured value. To enforce shared
// limits across instances, replace `store` with a Redis-backed store such as
// `rate-limit-redis` pointing at your Redis cluster.
const make = (windowMinutes, limit, message, options = {}) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: env.isTest ? 10_000 : limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: clientKey,
    message: { error: { code: "RATE_LIMITED", message } },
    ...options,
  });

// Public GETs the browser and any CDN may cache (Cache-Control public): each page view of the website makes several,
// and a whole school or mobile-operator NAT can share one address, so they are not counted. Lists that page through
// the database (gallery, album, podcasts) still are.
const CACHEABLE_GET = /^\/(?:home|stats|settings|visits|divisions|districts|talukas|forts(?:\/[a-z0-9-]+)?|events|videos|testimonials|faqs|announcements|pages\/[a-z0-9-]+|shivdurg-award)$/;

export const apiLimiter = make(15, 1500, "Too many requests, please slow down", {
  skip: (req) => req.method === "GET" && CACHEABLE_GET.test(req.path),
});
export const loginLimiter    = make(15,  10, "Too many login attempts. Try again in 15 minutes");
// Any number of registrations may come from one mobile number or one network (a school, a cyber café, a mobile
// operator's shared address). Each one already needs a fresh "I am not a robot" tick and waits its turn for the photo
// work (admission control), so this is only a ceiling against a runaway script.
export const registerLimiter = make(60, 1000, "Too many registrations from this network. Try again later");
// Certificate/status lookups need registration no + mobile; this stops mobile-number guessing
export const lookupLimiter   = make(15,  40, "Too many lookups. Try again in a few minutes");
// Further pages of one mobile number's registrations: the signed lookup token (issued after a CAPTCHA-checked lookup)
// already proves the number was looked up, so pages are counted per number, not against the per-network lookup budget —
// a number with hundreds of registrations can be paged through
export const lookupPageLimiter = make(15, 600, "Too many pages. Try again in a few minutes", {
  keyGenerator: (req) => {
    const phone = parseLookupToken(String(req.query.lookup_token ?? ""));
    return phone ? `lookup:${phone}` : clientKey(req);
  },
});
// Downloads through signed certificate links (cannot be guessed): a family or a school fetches many certificates, as
// PDF and image, plus "download all" bundles, often from one shared connection
export const downloadLimiter = make(15, 600, "Too many downloads. Try again in a few minutes");
// Certificate verification by the number printed on it: many checks at one venue or office share an address
export const verifyLimiter   = make(15, 300, "Too many verifications. Try again in a few minutes");
export const contactLimiter  = make(60,   8, "Too many messages. Try again later");
// Award nominations carry several files each; a real nominator submits a handful at most
export const nominationLimiter = make(60, 10, "Too many nominations from this network. Try again later");
// One visit per tab session; this only stops a script from inflating the visitor counter
export const visitLimiter    = make(60,  30, "Too many requests. Try again later");
