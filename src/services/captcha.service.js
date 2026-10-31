import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// SRS §3: "I am not a robot" — Google reCAPTCHA v2 (checkbox) or Cloudflare Turnstile. Both answer the same
// siteverify request ({ secret, response, remoteip } → { success, "error-codes" }).
const VERIFY_URL = {
  recaptcha: "https://www.google.com/recaptcha/api/siteverify",
  turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

// Read on every call (not at import), so tests can switch it like REGISTRATION_FORCE_OPEN
export const captchaEnabled = () => env.CAPTCHA_PROVIDER !== "off";

// What the website needs to draw the widget; null when the check is off
export const publicCaptcha = () => (captchaEnabled() ? { provider: env.CAPTCHA_PROVIDER, site_key: env.CAPTCHA_SITE_KEY } : null);

export async function verifyCaptcha(token, remoteIp) {
  // Development only (env.js refuses it in production): the website's static checkbox, nobody to ask
  if (env.CAPTCHA_PROVIDER === "dummy") return { ok: true, codes: [] };
  const body = new URLSearchParams({ secret: env.CAPTCHA_SECRET_KEY, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  const res = await fetch(VERIFY_URL[env.CAPTCHA_PROVIDER], { method: "POST", body, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`CAPTCHA provider answered HTTP ${res.status}`);
  const out = await res.json();
  return { ok: out.success === true, codes: out["error-codes"] ?? [] };
}

const captchaError = (status, message, code) => new AppError(status, message, { code, details: { captcha: message } });

/**
 * The request must carry a fresh token in body.captcha_token, checked with the provider before anything else
 * happens. On multipart forms it runs after multer, so an unverified request never gets its photo processed,
 * stored, or a certificate made. Tokens are single-use: the website asks for a new tick after every attempt.
 * A provider outage fails closed (503) — the form is the target of bot floods during peak traffic.
 */
export async function requireCaptcha(req, res, next) {
  if (!captchaEnabled()) return next();
  const token = typeof req.body?.captcha_token === "string" ? req.body.captcha_token.trim() : "";
  if (!token || token.length > 4096) return next(captchaError(400, "Please tick 'I am not a robot' before continuing", "CAPTCHA_REQUIRED"));
  try {
    const result = await verifyCaptcha(token, req.ip);
    if (!result.ok) {
      logger.warn({ codes: result.codes, path: req.path }, "CAPTCHA check failed");
      return next(captchaError(400, "The 'I am not a robot' check expired or failed. Please tick it again", "CAPTCHA_FAILED"));
    }
    delete req.body.captcha_token;
    next();
  } catch (err) {
    logger.error({ err }, "CAPTCHA provider unreachable");
    next(captchaError(503, "Could not complete the 'I am not a robot' check. Please try again in a moment", "CAPTCHA_UNAVAILABLE"));
  }
}
