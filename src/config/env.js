import "dotenv/config";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4100),
  API_URL: z.string().url().default("http://localhost:4100"),
  SITE_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:5174"),

  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().default("postgres"),
  DB_PASSWORD: z.string().default(""),
  DB_NAME: z.string().default("durgotsav_2026"),
  DB_POOL_MAX: z.coerce.number().default(10),
  // Separate connections for admin analytics (dashboard and district/city statistics), so slow whole-table reports
  // never take the connections registrations and downloads need. Keep instances × (DB_POOL_MAX + this) under
  // PostgreSQL's max_connections.
  DB_REPORT_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("8h"),

  ALBUM_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  UPLOAD_MAX_MB: z.coerce.number().min(1).max(25).default(5),
  REGISTRATION_FORCE_OPEN: bool,
  // Registrations processed at the same time per API process (photo in memory + image work); more wait in a queue of
  // REGISTRATION_QUEUE, beyond which the API answers 503 "try again" instead of running out of memory
  REGISTRATION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  REGISTRATION_QUEUE: z.coerce.number().int().min(0).max(5000).default(200),
  // Shivdurg Bhushan award: true = accept nominations regardless of the configured window (local testing only)
  AWARD_FORCE_OPEN: bool,
  // Award evidence files: "local" (storage/award-documents) or "s3" (AWS_S3_BUCKET_NAME, prefix shivdurg-bhushan/)
  AWARD_DOCUMENT_STORAGE: z.enum(["s3", "local"]).default("local"),

  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  MAIL_FROM: z.string().optional().default(""),
  CONTACT_NOTIFY_EMAIL: z.string().optional().default(""),

  // Certificate emails go through a queue (certificate_email_jobs). "embedded": the API process also runs the
  // delivery worker. "off": a separate `npm run certificates:worker` process does it (recommended in production).
  CERTIFICATE_WORKER: z.enum(["embedded", "off"]).default("embedded"),
  // Certificates rendered and emailed at the same time per worker process (also the SMTP connection pool size)
  CERTIFICATE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  // Emails per minute per worker process; 0 = no limit. Keep it under the SMTP provider's sending quota.
  CERTIFICATE_EMAIL_RATE_PER_MINUTE: z.coerce.number().int().min(0).default(0),
  // Attempts per email before it is marked failed (retries back off: 1, 5, 15, 60, 180 … minutes)
  CERTIFICATE_EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),

  // "log" writes the SMS to the server log only. "http" calls an SMS gateway: SMS_HTTP_URL with {phone} (10 digits)
  // and {message} filled in, URL-encoded (most Indian gateways accept the DLT template id and API key in the URL).
  SMS_DRIVER: z.enum(["log", "http"]).default("log"),
  SMS_HTTP_URL: z.string().trim().default(""),
  SMS_HTTP_METHOD: z.enum(["GET", "POST"]).default("GET"),
  // SMS go through a queue (sms_messages) sent by the same worker processes as certificate emails (CERTIFICATE_WORKER).
  // Messages per minute per worker process; 0 = no limit. Keep it under the gateway's throughput.
  SMS_RATE_PER_MINUTE: z.coerce.number().int().min(0).default(0),
  // Attempts per SMS before it is marked failed (retries back off: 1, 5, 15, 60 … minutes)
  SMS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

  // "I am not a robot" check on the registration form and the mobile certificate lookup (SRS §3): Google reCAPTCHA v2
  // (checkbox) or Cloudflare Turnstile. Outside production, empty keys fall back to the provider's public test keys
  // (the widget shows, every check passes). "dummy" (development only): the website draws a static look-alike checkbox
  // and any tick passes — no provider, no keys. "off" only for automated tests.
  CAPTCHA_PROVIDER: z.enum(["recaptcha", "turnstile", "dummy", "off"]).default("recaptcha"),
  CAPTCHA_SITE_KEY: z.string().trim().default(""),
  CAPTCHA_SECRET_KEY: z.string().trim().default(""),

  // Participant originals: "s3" (private bucket, EC2 instance role) or "local" (storage/originals, dev/tests)
  PARTICIPANT_IMAGE_STORAGE: z.enum(["s3", "local"]).default("local"),
  AWS_REGION: z.string().trim().default("ap-south-1"),
  AWS_S3_BUCKET_NAME: z.string().trim().default(""),
  AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
}).superRefine((v, ctx) => {
  if (v.SMS_DRIVER === "http" && !(/^https?:\/\//.test(v.SMS_HTTP_URL) && v.SMS_HTTP_URL.includes("{phone}") && v.SMS_HTTP_URL.includes("{message}"))) {
    ctx.addIssue({ code: "custom", path: ["SMS_HTTP_URL"], message: "An http(s) URL containing {phone} and {message} is required when SMS_DRIVER=http" });
  }
  if (v.NODE_ENV === "production" && v.CAPTCHA_PROVIDER === "dummy") {
    ctx.addIssue({ code: "custom", path: ["CAPTCHA_PROVIDER"], message: "dummy is for development only: use recaptcha or turnstile with real keys in production" });
  } else if (v.NODE_ENV === "production" && v.CAPTCHA_PROVIDER !== "off" && !(v.CAPTCHA_SITE_KEY && v.CAPTCHA_SECRET_KEY)) {
    ctx.addIssue({ code: "custom", path: ["CAPTCHA_SECRET_KEY"], message: "CAPTCHA_SITE_KEY and CAPTCHA_SECRET_KEY are required in production" });
  }
  if (v.PARTICIPANT_IMAGE_STORAGE !== "s3" && v.AWARD_DOCUMENT_STORAGE !== "s3") return;
  if (!v.AWS_REGION) ctx.addIssue({ code: "custom", path: ["AWS_REGION"], message: "Required when S3 storage is enabled" });
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v.AWS_S3_BUCKET_NAME)) {
    ctx.addIssue({ code: "custom", path: ["AWS_S3_BUCKET_NAME"], message: "A valid bucket name is required when S3 storage is enabled" });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Invalid environment configuration:\n${issues}\nSee backend/.env.example`);
  process.exit(1);
}

// Published test keys: the widget is shown and every token passes verification. Never used in production (see above).
const CAPTCHA_TEST_KEYS = {
  recaptcha: ["6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI", "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe"],
  turnstile: ["1x00000000000000000000AA", "1x0000000000000000000000000000000AA"],
};
if (parsed.data.CAPTCHA_PROVIDER in CAPTCHA_TEST_KEYS && !(parsed.data.CAPTCHA_SITE_KEY && parsed.data.CAPTCHA_SECRET_KEY)) {
  [parsed.data.CAPTCHA_SITE_KEY, parsed.data.CAPTCHA_SECRET_KEY] = CAPTCHA_TEST_KEYS[parsed.data.CAPTCHA_PROVIDER];
  console.warn(`CAPTCHA: no keys configured, using ${parsed.data.CAPTCHA_PROVIDER}'s public TEST keys (every check passes). Set CAPTCHA_SITE_KEY / CAPTCHA_SECRET_KEY.`);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  mailEnabled: Boolean(parsed.data.SMTP_HOST && parsed.data.SMTP_USER && parsed.data.SMTP_PASSWORD),
};
