import { z } from "zod";
import { paginationSchema } from "../../utils/pagination.js";

export const PARTICIPANT_TYPES = ["individual", "family", "housing_society", "organization", "group", "school", "college"];
export const STATUSES = ["pending", "info_requested", "verified", "rejected", "duplicate"];
export const REVIEW_ACTIONS = ["verify", "reject", "request_info", "mark_duplicate", "reset"];

const trimmed = (max) => z.string().trim().max(max);
const optionalText = (max) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), trimmed(max).optional());
const optionalId = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().positive().optional());

export const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");
const anyMobile = z.string().trim().regex(/^\d{10}$/, "Enter the 10-digit mobile number used for registration");

// multipart/form-data fields arrive as strings
export const registerSchema = z
  .object({
    participant_type: z.enum(PARTICIPANT_TYPES).default("individual"),
    name: trimmed(150).min(2, "Name is required"),
    organization_name: optionalText(200),
    phone: mobile,
    email: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().toLowerCase().email("Email is invalid").max(160).optional()),
    country: optionalText(80).default("India"),
    district_id: optionalId,
    taluka_id: optionalId,
    city: optionalText(120),
    fort_id: optionalId,
    // optional; when given, 2–300 characters (matches the registration form)
    replica_notes: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      trimmed(300).min(2, "Please write at least 2 characters").optional(),
    ),
    consent: z.literal("true", { errorMap: () => ({ message: "Please accept the rules to continue" }) }),
    // honeypot: real users never see or fill this field
    website: z.string().max(0, "Invalid submission").optional(),
    // generated once per form fill; makes a retried submit idempotent
    submission_id: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid("Invalid submission").optional()),
  })
  .superRefine((v, ctx) => {
    if (v.country === "India" && !v.district_id) {
      ctx.addIssue({ code: "custom", path: ["district_id"], message: "Please select your district" });
    }
    if (v.participant_type !== "individual" && v.participant_type !== "family" && !v.organization_name) {
      ctx.addIssue({ code: "custom", path: ["organization_name"], message: "Please enter the name of the society / organisation / school" });
    }
  });

export const lookupSchema = z.object({
  registration: z.string().trim().min(1, "Registration number is required").max(20),
  phone: anyMobile,
});

export const resubmitSchema = z.object({
  phone: anyMobile,
  replica_notes: optionalText(500),
});

// ---------------- admin
const boolish = z.enum(["true", "false"]).transform((v) => v === "true").optional();

export const adminListSchema = paginationSchema.extend({
  q: optionalText(100),
  status: z.enum(STATUSES).optional(),
  division_id: optionalId,
  district_id: optionalId,
  taluka_id: optionalId,
  fort_id: optionalId,
  participant_type: z.enum(PARTICIPANT_TYPES).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  duplicates: boolish,
  featured: boolish,
  trashed: boolish,
  sort: z.enum(["newest", "oldest", "name"]).default("newest"),
});

export const reviewSchema = z
  .object({
    action: z.enum(REVIEW_ACTIONS),
    note: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if ((v.action === "reject" || v.action === "request_info") && !v.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Please give the participant a reason" });
    }
  });

export const bulkReviewSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
  action: z.enum(REVIEW_ACTIONS),
  note: optionalText(500),
});

export const updateRegistrationSchema = z.object({
  participant_type: z.enum(PARTICIPANT_TYPES).optional(),
  name: trimmed(150).min(2).optional(),
  organization_name: z.string().trim().max(200).nullable().optional(),
  phone: mobile.optional(),
  email: z.string().trim().toLowerCase().email().max(160).nullable().or(z.literal("").transform(() => null)).optional(),
  country: trimmed(80).optional(),
  district_id: z.number().int().positive().nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  fort_id: z.number().int().positive().nullable().optional(),
});

export const featureSchema = z.object({
  photo_ids: z.array(z.coerce.number().int().positive()).min(1).max(200),
  featured: z.boolean(),
});
