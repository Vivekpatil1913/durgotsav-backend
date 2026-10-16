import { z } from "zod";
import { paginationSchema } from "../../utils/pagination.js";
import {
  CATEGORIES, DOCUMENT_TYPES, INDIVIDUAL_WORK, ORG_TYPES, ORG_TYPES_REQUIRING_REGISTRATION, ORGANIZATION_WORK,
  RESEARCH_TOOLS, STATUSES,
} from "./award.constants.js";

export const LONG_TEXT_MAX = 5000;
const SHORT = 300;

const blank = (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? undefined : v);
const req = (max, message = "आवश्यक") => z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message).max(max, `कमाल ${max} अक्षरे`);
const opt = (max) => z.preprocess(blank, z.string().trim().max(max, `कमाल ${max} अक्षरे`).optional());
const longReq = (min = 20) => z.string({ required_error: "आवश्यक" }).trim()
  .min(min, `किमान ${min} अक्षरे लिहा`).max(LONG_TEXT_MAX, `कमाल ${LONG_TEXT_MAX} अक्षरे`);
const longOpt = () => opt(LONG_TEXT_MAX);

const thisYear = () => Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" }).format(new Date()));
const todayIst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const year = (min = 1900) => z.coerce.number({ invalid_type_error: "वर्ष योग्य नाही" }).int("वर्ष योग्य नाही")
  .min(min, "वर्ष योग्य नाही").refine((v) => v <= thisYear(), "भविष्यातील वर्ष चालणार नाही");
const optYear = (min = 1900) => z.preprocess(blank, year(min).optional());
const pastDate = (message = "दिनांक योग्य नाही") => z.string().trim().date(message)
  .refine((v) => v >= "1800-01-01" && v <= todayIst(), "दिनांक भविष्यातील किंवा अवैध आहे");
const optPastDate = () => z.preprocess(blank, pastDate().optional());

export const mobile = z.string({ required_error: "मोबाईल क्रमांक आवश्यक" }).trim()
  .regex(/^[6-9]\d{9}$/, "१० अंकी वैध मोबाईल क्रमांक लिहा");
const email = z.string({ required_error: "ई-मेल आवश्यक" }).trim().toLowerCase().email("ई-मेल योग्य नाही").max(160);
export const httpUrl = z.string().trim().max(1000, "लिंक खूप मोठी आहे")
  .url("लिंक योग्य नाही (https://... ने सुरू करा)")
  .refine((v) => /^https?:\/\//i.test(v), "फक्त http / https लिंक चालतील");
const optUrl = z.preprocess(blank, httpUrl.optional());
const id = z.coerce.number({ invalid_type_error: "निवडा" }).int().positive("निवडा");
const count = z.preprocess(blank, z.coerce.number().int("पूर्ण संख्या लिहा").min(0).max(100_000_000).optional());

const keysOf = (map) => Object.keys(map);

const activity = z.object({
  title: req(250),
  fort_name: opt(250),
  work_type: opt(250),
  period: opt(120),
  details: opt(2000),
  beneficiaries: count,
});
const publication = z.object({ title: req(SHORT), pub_type: opt(120), publisher: opt(250), year: optYear(), details: opt(2000) });
const honour = z.object({ title: req(SHORT), awarded_by: opt(250), year: optYear(), details: opt(2000) });
const official = z.object({ name: req(160), designation: req(160), email, mobile, address: req(1000) });
const evidence = z.object({
  title: opt(250),
  doc_type: z.preprocess(blank, z.enum(keysOf(DOCUMENT_TYPES)).optional()),
  description: opt(1000),
  external_url: optUrl,
  // name of the multipart file field carrying this entry's file (doc_0, doc_1, …)
  file_field: z.preprocess(blank, z.string().regex(/^doc_\d{1,2}$/).optional()),
});

const repeat = (schema, max = 20) => z.array(schema).max(max, `जास्तीत जास्त ${max} नोंदी`).default([]);

// The whole nomination arrives as one JSON document in the multipart field `payload`.
export const nominationSchema = z.object({
  submission_id: z.string().uuid("Invalid submission"),
  website: z.string().max(0, "Invalid submission").optional(), // honeypot
  category: z.enum(keysOf(CATEGORIES), { errorMap: () => ({ message: "नामनिर्देशन प्रकार निवडा" }) }),

  nominator_name: req(160, "नामनिर्देशकाचे नाव आवश्यक"),
  nominator_mobile: mobile,

  // Nominee (person or organization) — common fields
  nominee_name: req(250, "नाव आवश्यक"),
  mobile,
  email,
  address: req(1000, "पत्ता आवश्यक"),
  district_id: id,
  taluka_id: id,

  // Individual
  father_or_husband_name: opt(160),
  date_of_birth: z.preprocess(blank, z.string().trim().optional()),
  conservation_work: longOpt(),
  lectures_awareness: longOpt(),
  external_references: longOpt(),

  // Organization
  org_type: z.preprocess(blank, z.enum(keysOf(ORG_TYPES)).optional()),
  org_type_other: opt(160),
  established_on: optPastDate(),
  established_year: z.preprocess(blank, z.coerce.number().int().optional()),
  registration_no: opt(120),
  registration_date: optPastDate(),
  registration_authority: opt(200),
  pan: z.preprocess((v) => (typeof v === "string" ? blank(v.trim().toUpperCase()) : v),
    z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN योग्य नाही (उदा. ABCDE1234F)").optional()),
  website_url: optUrl,
  pincode: z.preprocess(blank, z.string().trim().regex(/^[1-9]\d{5}$/, "६ अंकी वैध पिनकोड लिहा").optional()),
  conservation_details: longOpt(),
  research_documentation: longOpt(),
  research_tools: z.array(z.enum(keysOf(RESEARCH_TOOLS))).max(20).default([]),
  youth_participation: longOpt(),
  volunteer_count: count,
  media_publicity: longOpt(),
  distinctive_features: longOpt(),
  officials: repeat(official, 10),

  // Work
  work_started_year: year(1900),
  work_categories: z.array(z.string().max(40)).min(1, "किमान एक कार्यक्षेत्र निवडा").max(20),
  work_category_other: opt(300),
  activities: repeat(activity),
  publications: repeat(publication),
  honours: repeat(honour),
  documents: repeat(evidence, 30),

  // Declaration
  declaration_accepted: z.literal(true, { errorMap: () => ({ message: "घोषणापत्र मान्य करणे आवश्यक आहे" }) }),
  declaration_place: req(120, "ठिकाण आवश्यक"),
  declaration_date: z.string().trim().date("दिनांक योग्य नाही"),
  declaration_name: req(160, "अर्जदार / नामनिर्देशकाचे नाव आवश्यक"),
}).strict().superRefine((v, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: "custom", path: [path], message });
  const allowedWork = keysOf(v.category === "organization" ? ORGANIZATION_WORK : INDIVIDUAL_WORK);
  if (v.work_categories.some((k) => !allowedWork.includes(k))) issue("work_categories", "अवैध कार्यक्षेत्र निवडले आहे");
  if (new Set(v.work_categories).size !== v.work_categories.length) issue("work_categories", "कार्यक्षेत्र एकदाच निवडा");
  if (v.work_categories.includes("other") && !v.work_category_other) issue("work_category_other", "इतर कार्याचा तपशील लिहा");

  // Declaration date: the day of submission (IST), with a day of slack for clock/time-zone differences
  const today = todayIst();
  const d = Date.parse(`${v.declaration_date}T00:00:00Z`);
  if (Math.abs(d - Date.parse(`${today}T00:00:00Z`)) > 86_400_000) issue("declaration_date", "आजचा दिनांक निवडा");

  if (v.category === "individual") {
    if (!v.father_or_husband_name) issue("father_or_husband_name", "वडिलांचे / पतीचे नाव आवश्यक");
    if (!v.date_of_birth) issue("date_of_birth", "जन्मतारीख आवश्यक");
    else {
      const ok = pastDate().safeParse(v.date_of_birth);
      if (!ok.success) issue("date_of_birth", ok.error.issues[0].message);
      else if (v.date_of_birth < "1900-01-01") issue("date_of_birth", "जन्मतारीख योग्य नाही");
      else if (v.work_started_year < Number(v.date_of_birth.slice(0, 4))) issue("work_started_year", "कार्य सुरू केल्याचे वर्ष जन्मवर्षानंतरचे असावे");
    }
    if (!v.conservation_work || v.conservation_work.length < 20) issue("conservation_work", "संवर्धन कार्याची माहिती किमान २० अक्षरांत लिहा");
    if (v.officials.length) issue("officials", "Not applicable to individual nominations");
  }

  if (v.category === "organization") {
    if (!v.org_type) issue("org_type", "संस्थेचा प्रकार निवडा");
    if (v.org_type === "other" && !v.org_type_other) issue("org_type_other", "संस्थेचा प्रकार लिहा");
    const yr = v.established_year ?? (v.established_on ? Number(v.established_on.slice(0, 4)) : undefined);
    if (!yr) issue("established_year", "स्थापना वर्ष आवश्यक");
    else if (yr < 1800 || yr > thisYear()) issue("established_year", "स्थापना वर्ष योग्य नाही");
    else if (v.established_on && Number(v.established_on.slice(0, 4)) !== yr) issue("established_year", "स्थापना दिनांक व वर्ष जुळत नाहीत");
    if (ORG_TYPES_REQUIRING_REGISTRATION.includes(v.org_type)) {
      if (!v.registration_no) issue("registration_no", "नोंदणी क्रमांक आवश्यक");
      if (!v.registration_date) issue("registration_date", "नोंदणी दिनांक आवश्यक");
      if (!v.registration_authority) issue("registration_authority", "नोंदणी प्राधिकरण आवश्यक");
    }
    if (v.registration_date && v.established_on && v.registration_date < v.established_on) issue("registration_date", "नोंदणी दिनांक स्थापनेनंतरचा असावा");
    if (!v.pincode) issue("pincode", "पिनकोड आवश्यक");
    if (!v.conservation_details || v.conservation_details.length < 20) issue("conservation_details", "कामाचा तपशील किमान २० अक्षरांत लिहा");
    if (!v.distinctive_features || v.distinctive_features.length < 20) issue("distinctive_features", "वैशिष्ट्ये किमान २० अक्षरांत लिहा");
    if (!v.officials.length) issue("officials", "किमान एका अधिकृत पदाधिकाऱ्याची माहिती द्या");
    // work_started_year is deliberately not compared with the founding year: groups often work before registering
    for (const k of ["father_or_husband_name", "date_of_birth", "conservation_work", "lectures_awareness", "external_references"]) {
      if (v[k]) issue(k, "Not applicable to organization nominations");
    }
  }

  v.documents.forEach((d, i) => {
    if (!d.external_url && !d.file_field) ctx.addIssue({ code: "custom", path: ["documents", i, "file_field"], message: "फाइल अपलोड करा किंवा लिंक द्या" });
  });
  const fields = v.documents.map((d) => d.file_field).filter(Boolean);
  if (new Set(fields).size !== fields.length) issue("documents", "Invalid submission");
});

export const lookupSchema = z.object({ mobile });

// ---------------------------------------------------------------- admin
const optionalId = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional());
const optDate = z.preprocess((v) => (v === "" ? undefined : v), z.string().date().optional());

export const adminListSchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  category: z.preprocess(blank, z.enum(keysOf(CATEGORIES)).optional()),
  status: z.preprocess(blank, z.enum(keysOf(STATUSES)).optional()),
  district_id: optionalId,
  taluka_id: optionalId,
  work_category: z.preprocess(blank, z.string().regex(/^[a-z_]{2,40}$/).optional()),
  from: optDate,
  to: optDate,
  edition_id: optionalId,
  sort: z.enum(["submitted_at", "nominee_name", "reference_no", "status", "district"]).default("submitted_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export const statusSchema = z.object({
  status: z.enum(keysOf(STATUSES)),
  remarks: z.preprocess(blank, z.string().trim().max(2000).optional()),
});

export const remarkSchema = z.object({ body: z.string().trim().min(2, "Write a remark").max(4000) });

const iso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date/time");
const lines = (max = 20) => z.array(z.string().trim().min(1).max(1000)).max(max);

const pageContent = z.object({
  intro: z.string().trim().max(4000).default(""),
  objectives: lines(),
  eligibility: lines(),
  instructions: lines(),
  documents: lines(),
  process: lines(),
  faqs: z.array(z.object({ q: z.string().trim().min(1).max(500), a: z.string().trim().min(1).max(2000) })).max(30),
  help: z.string().trim().max(1000).default(""),
});

export const configSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  reference_prefix: z.string().trim().regex(/^[A-Z0-9]{2,12}$/, "2–12 capital letters / digits"),
  title: z.string().trim().min(3).max(200),
  title_en: z.preprocess(blank, z.string().trim().max(200).nullable().default(null)),
  tagline: z.preprocess(blank, z.string().trim().max(600).nullable().default(null)),
  tagline_en: z.preprocess(blank, z.string().trim().max(600).nullable().default(null)),
  nominations_enabled: z.boolean(),
  nomination_opens_at: iso,
  nomination_closes_at: iso,
  scrutiny_starts_on: z.preprocess(blank, z.string().date().nullable().default(null)),
  scrutiny_ends_on: z.preprocess(blank, z.string().date().nullable().default(null)),
  closed_note: z.preprocess(blank, z.string().trim().max(600).nullable().default(null)),
  prize_individual: z.string().trim().min(2).max(300),
  prize_organization: z.string().trim().min(2).max(300),
  max_upload_mb: z.coerce.number().int().min(1).max(25),
  max_documents: z.coerce.number().int().min(1).max(30),
  allow_video: z.boolean(),
  closed_note_en: z.preprocess(blank, z.string().trim().max(600).nullable().default(null)),
  prize_individual_en: z.preprocess(blank, z.string().trim().max(300).nullable().default(null)),
  prize_organization_en: z.preprocess(blank, z.string().trim().max(300).nullable().default(null)),
  content: pageContent,
  // English page content; empty items fall back to the Marathi text on the website
  content_en: pageContent,
}).superRefine((v, ctx) => {
  if (Date.parse(v.nomination_closes_at) <= Date.parse(v.nomination_opens_at)) {
    ctx.addIssue({ code: "custom", path: ["nomination_closes_at"], message: "Closing must be after opening" });
  }
  if (v.scrutiny_starts_on && v.scrutiny_ends_on && v.scrutiny_ends_on < v.scrutiny_starts_on) {
    ctx.addIssue({ code: "custom", path: ["scrutiny_ends_on"], message: "End must be on or after start" });
  }
});
