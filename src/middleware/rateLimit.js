import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

// When deployed behind a reverse proxy (nginx, ALB, Cloudflare) the real client
// IP is in X-Forwarded-For, not req.ip. Without this, every request looks like
// it comes from the proxy's IP and the limiter either blocks everyone or no one.
// IMPORTANT: only trust this header when your proxy is the sole entry point —
// never expose this server directly to the internet without a proxy in front.
const keyGenerator = (req) =>
  (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ?? req.ip ?? "unknown";

// NOTE: This uses an in-memory store, which means each Node.js process has its
// own independent counter. Under a multi-instance deployment (load balancer with
// N workers) the effective limit is N × the configured value. To enforce shared
// limits across instances, replace `store` with a Redis-backed store such as
// `rate-limit-redis` pointing at your Redis cluster.
const make = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: env.isTest ? 10_000 : limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator,
    message: { error: { code: "RATE_LIMITED", message } },
  });

export const apiLimiter      = make(15, 600, "Too many requests, please slow down");
export const loginLimiter    = make(15,  10, "Too many login attempts. Try again in 15 minutes");
export const registerLimiter = make(60,  15, "Too many registrations from this network. Try again later");
// Certificate/status lookups need registration no + mobile; this stops mobile-number guessing
export const lookupLimiter   = make(15,  40, "Too many lookups. Try again in a few minutes");
export const contactLimiter  = make(60,   8, "Too many messages. Try again later");
// Award nominations carry several files each; a real nominator submits a handful at most
export const nominationLimiter = make(60, 10, "Too many nominations from this network. Try again later");
// One visit per tab session; this only stops a script from inflating the visitor counter
export const visitLimiter    = make(60,  30, "Too many requests. Try again later");
