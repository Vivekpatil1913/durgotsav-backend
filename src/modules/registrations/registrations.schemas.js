import { z } from "zod";
import { paginationSchema } from "../../utils/pagination.js";
import { LOOKUP_TOKEN_PATTERN, TOKEN_PATTERN } from "../certificates/certificate.links.js";

export const PARTICIPANT_TYPES = ["individual", "family", "housing_society", "organization", "group", "school", "college"];
export const STATUSES = ["pending", "info_requested", "verified", "rejected", "duplicate"];
export const REVIEW_ACTIONS = ["verify", "reject", "request_info", "mark_duplicate", "reset"];
// group registrations (every type except "individual") say how many people built the replica
export const MEMBERS_MIN = 2;
export const MEMBERS_MAX = 10000;
// There is no limit on registrations per mobile number: a family, school or society may register any number of
// replicas with one number. A retried submit is recognised by its submission_id instead.

// Most links a "download all" PDF may combine: one page of the mobile lookup (certificates.service LOOKUP_PAGE_SIZE)
const BUNDLE_MAX = 20;

const trimmed = (max) => z.string().trim().max(max);
const optionalText = (max) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), trimmed(max).optional());
const optionalId = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().positive().optional());

export const mobile = z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");
const anyMobile = z.string().trim().regex(/^\d{10}$/, "Enter the 10-digit mobile number used for registration");

// multipart/form-data fields arrive as strings.
// SRS v2.1 §2: the single-page form sends name (person / organisation / family / society in one field), mobile,
// optional WhatsApp and email, district and the photo. participant_type, organisation, members, taluka, fort and notes
// are no longer on the form; they stay optional here for other clients and are validated when sent.
export const registerSchema = z
  .object({
    participant_type: z.preprocess((v) => (v === "" ? undefined : v), z.enum(PARTICIPANT_TYPES).optional()),
    name: trimmed(150).min(2, "Name is required"),
    organization_name: optionalText(200),
    members_count: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce.number().int("Enter a whole number")
        .min(MEMBERS_MIN, `Enter at least ${MEMBERS_MIN} members`)
        .max(MEMBERS_MAX, `Enter at most ${MEMBERS_MAX} members`)
        .optional(),
    ),
    phone: mobile,
    // optional; the form sends the mobile number here when "same as mobile" is ticked
    whatsapp_number: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit WhatsApp number").optional(),
    ),
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
    // Only when a type is given (the website's form no longer asks for one)
    const group = v.participant_type && v.participant_type !== "individual";
    if (group && v.participant_type !== "family" && !v.organization_name) {
      ctx.addIssue({ code: "custom", path: ["organization_name"], message: "Please enter the name of the society / organisation / school" });
    }
    if (group && !v.members_count) {
      ctx.addIssue({ code: "custom", path: ["members_count"], message: "Please enter how many members built the replica" });
    }
  });

export const lookupSchema = z.object({
  registration: z.string().trim().min(1, "Registration number is required").max(20),
  phone: anyMobile,
  format: z.enum(["pdf", "jpg"]).default("pdf"),
});

// Every registration of one mobile number: the first page (the route also requires the CAPTCHA) …
export const mobileLookupSchema = z.object({ phone: anyMobile });
// … and the following ones, with the lookup token the first page returned (no new CAPTCHA for 30 minutes)
export const mobileLookupPageSchema = z.object({
  lookup_token: z.string().regex(LOOKUP_TOKEN_PATTERN, "This search has expired. Please search again"),
  before: z.coerce.number().int().positive(),
});

export const tokenParams = z.object({ token: z.string().regex(TOKEN_PATTERN, "This certificate link is not valid") });
export const formatQuery = z.object({ format: z.enum(["pdf", "jpg"]).default("pdf") });
// "Download all": up to one lookup page of links, comma separated
export const bundleQuery = z.object({
  tokens: z.string().trim().max(BUNDLE_MAX * 30).transform((v) => v.split(",").map((t) => t.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(TOKEN_PATTERN, "Invalid certificate link")).min(1).max(BUNDLE_MAX)),
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
  // Column keys of SORTS in registrations.service.js; newest / oldest are the older named orders, still accepted
  sort: z.enum(["created_at", "registration_no", "name", "phone", "status", "newest", "oldest"]).default("created_at"),
  dir: z.enum(["asc", "desc"]).optional(),
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
  members_count: z.number().int().min(1).max(MEMBERS_MAX).nullable().optional(),
  phone: mobile.optional(),
  whatsapp_number: mobile.nullable().or(z.literal("").transform(() => null)).optional(),
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
