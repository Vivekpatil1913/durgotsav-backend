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

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("8h"),

  ALBUM_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  UPLOAD_MAX_MB: z.coerce.number().min(1).max(25).default(8),
  REGISTRATION_FORCE_OPEN: bool,
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

  SMS_DRIVER: z.enum(["log"]).default("log"),

  // Participant originals: "s3" (private bucket, EC2 instance role) or "local" (storage/originals, dev/tests)
  PARTICIPANT_IMAGE_STORAGE: z.enum(["s3", "local"]).default("local"),
  AWS_REGION: z.string().trim().default("ap-south-1"),
  AWS_S3_BUCKET_NAME: z.string().trim().default(""),
  AWS_S3_PRESIGNED_URL_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
}).superRefine((v, ctx) => {
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

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  isTest: parsed.data.NODE_ENV === "test",
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  mailEnabled: Boolean(parsed.data.SMTP_HOST && parsed.data.SMTP_USER && parsed.data.SMTP_PASSWORD),
};
