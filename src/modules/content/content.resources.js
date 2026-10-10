import { z } from "zod";
import { createCrud } from "../shared/crud.factory.js";
import { bool, date, datetime, longText, sortOrder, text, url } from "../shared/fields.js";

const YOUTUBE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)[\w-]{11}/;

export const events = createCrud({
  table: "events",
  entity: "event",
  searchable: ["title", "description", "date_label"],
  filters: { is_active: "bool" },
  order: "sort_order ASC, start_date ASC NULLS LAST, id ASC",
  schema: z.object({
    title: text(200, { required: true }),
    description: longText(4000),
    start_date: date(),
    end_date: date(),
    date_label: text(160),
    icon: text(40),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
});

export const videos = createCrud({
  table: "videos",
  entity: "video",
  searchable: ["title", "description"],
  filters: { is_active: "bool" },
  schema: z.object({
    title: text(200, { required: true }),
    description: longText(4000),
    youtube_url: z.string().trim().regex(YOUTUBE, "Enter a YouTube video link"),
    thumbnail: url(),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
});

export const announcements = createCrud({
  table: "announcements",
  entity: "announcement",
  searchable: ["title", "body"],
  filters: { is_active: "bool", is_pinned: "bool" },
  hasSortOrder: false,
  order: "is_pinned DESC, published_at DESC, id DESC",
  schema: z.object({
    title: text(200, { required: true }),
    body: longText(8000),
    link_url: url(),
    link_label: text(80),
    published_at: datetime().transform((v) => v ?? new Date()),
    is_pinned: bool(false),
    is_active: bool(true),
  }),
});

export const testimonials = createCrud({
  table: "testimonials",
  entity: "testimonial",
  searchable: ["name", "designation", "message"],
  filters: { is_active: "bool" },
  schema: z.object({
    name: text(150, { required: true }),
    designation: text(250),
    message: text(6000, { required: true }),
    photo: url(),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
});

export const faqs = createCrud({
  table: "faqs",
  entity: "faq",
  searchable: ["question", "answer", "category"],
  filters: { is_active: "bool", category: "string" },
  schema: z.object({
    question: text(300, { required: true }),
    answer: text(6000, { required: true }),
    category: text(60),
    sort_order: sortOrder(),
    is_active: bool(true),
  }),
});

export const pages = createCrud({
  table: "pages",
  entity: "page",
  searchable: ["title", "slug"],
  filters: { is_active: "bool" },
  softDelete: false,
  hasSortOrder: false,
  order: "slug ASC",
  actions: ["list", "get", "create", "update", "toggle"],
  schema: z.object({
    slug: z.string().trim().regex(/^[a-z0-9-]{2,80}$/, "Lowercase letters, digits and - only"),
    title: text(200, { required: true }),
    title_en: text(200).optional(),
    body: z.string().max(100000).default(""),
    body_en: z.string().max(100000).default(""),
    meta_description: text(300),
    is_active: bool(true),
  }),
});

export const enquiries = createCrud({
  table: "contact_enquiries",
  entity: "enquiry",
  searchable: ["name", "email", "phone", "subject", "message"],
  filters: { status: "string" },
  hasSortOrder: false,
  order: "created_at DESC",
  actions: ["list", "get", "update", "delete", "restore"],
  roles: ["admin", "moderator"],
  schema: z.object({}),
  updateSchema: z.object({
    status: z.enum(["new", "in_progress", "resolved", "spam"]).optional(),
    admin_note: text(500),
  }),
});
