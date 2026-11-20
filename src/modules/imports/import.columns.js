// Sheet columns of a bulk registration import, and how a row's raw cells become a registration's fields.
import { query } from "../../db/pool.js";
import { latinDigits } from "../../utils/format.js";

// Column order of the sample template (and of the CSV / Excel reports)
export const TEMPLATE_COLUMNS = ["Full Name", "Mobile Number", "District", "Photo URL", "Photo File Name"];

// Header spellings accepted for each field, compared after normalizeHeader() (case, spaces and punctuation ignored)
const HEADER_ALIASES = {
  name: ["fullname", "name", "participantname", "participant", "नाव", "पूर्णनाव", "संपूर्णनाव"],
  phone: ["mobilenumber", "mobile", "mobileno", "phone", "phonenumber", "phoneno", "contactnumber", "contactno", "contact",
    "मोबाईलनंबर", "मोबाईल", "मोबाइल", "मोबाइलनंबर", "मोबाईलक्रमांक"],
  district: ["district", "location", "districtname", "जिल्हा"],
  photoUrl: ["photourl", "photo", "photolink", "imageurl", "image", "imagelink", "फोटो", "छायाचित्र"],
  photoFile: ["photofilename", "photofile", "filename", "imagefilename", "imagefile", "imagename", "photoname"],
};
export const REQUIRED_FIELDS = { name: "Full Name", phone: "Mobile Number", district: "District" };

const normalizeHeader = (text) => String(text ?? "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
const HEADER_LOOKUP = new Map(Object.entries(HEADER_ALIASES).flatMap(([field, names]) => names.map((n) => [n, field])));

/**
 * Column index of each field in the header row (cells: array of header texts). Unknown columns are ignored; the first
 * column of a field wins. Throws a message for the admin when a mandatory column is missing.
 */
export function mapHeader(cells) {
  const columns = {};
  cells.forEach((cell, index) => {
    const field = HEADER_LOOKUP.get(normalizeHeader(cell));
    if (field && columns[field] === undefined) columns[field] = index;
  });
  const missing = Object.entries(REQUIRED_FIELDS).filter(([field]) => columns[field] === undefined).map(([, label]) => label);
  if (missing.length) {
    throw new ImportFileError(`The sheet has no ${missing.join(", ")} column. The first row must hold the column names: ${TEMPLATE_COLUMNS.join(", ")} (download the sample template)`);
  }
  return columns;
}

// The whole import cannot run (unreadable file, missing columns): shown to the admin as the import's error
export class ImportFileError extends Error {}

// ---------------------------------------------------------------- cell values

/** A cell's value as trimmed text, whatever Excel stored (number, rich text, hyperlink, formula result, date). */
export function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value).trim();
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text ?? "").join("").trim();
    if ("result" in value) return cellText(value.result);
    if ("hyperlink" in value) return cellText(value.hyperlink || value.text);
    if ("text" in value) return cellText(value.text);
    if ("error" in value) return "";
  }
  return String(value).trim();
}

// ---------------------------------------------------------------- field rules

export const NAME_MAX = 150; // registrations.name

export function normalizeName(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The 10-digit mobile number in a cell, or null. Accepts what people type in sheets: spaces, dashes, brackets, dots,
 * a +91 / 91 / 0 prefix, Marathi digits, and numbers Excel stored as numbers.
 */
export function normalizeMobile(text) {
  let digits = latinDigits(String(text ?? "")).replace(/[\s\-().]/g, "");
  if (/^\+?91\d{10}$/.test(digits)) digits = digits.slice(-10);
  else if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

// One key for "the same person" in the duplicate check: mobile number + name, ignoring case and spacing
export const personKey = (phone, name) => `${phone}|${normalizeName(name).toLowerCase()}`;

// ---------------------------------------------------------------- districts

const normalizeDistrict = (text) => String(text ?? "").toLowerCase()
  .replace(/\b(district|dist)\b\.?/g, "").replace(/जिल्हा/g, "")
  .replace(/[^\p{L}\p{M}\p{N}]/gu, "");

// Older and common spellings → the district's English name in the districts table
const DISTRICT_ALIASES = {
  mumbai: "Mumbai City", bombay: "Mumbai City", mumbaicity: "Mumbai City", "मुंबई": "Mumbai City",
  mumbaisuburb: "Mumbai Suburban", mumbaisuburbs: "Mumbai Suburban", mumbaiupnagar: "Mumbai Suburban",
  ahmednagar: "Ahilyanagar", ahmadnagar: "Ahilyanagar", ahilyanagar: "Ahilyanagar", "अहमदनगर": "Ahilyanagar",
  aurangabad: "Chhatrapati Sambhajinagar", sambhajinagar: "Chhatrapati Sambhajinagar", chhsambhajinagar: "Chhatrapati Sambhajinagar",
  chatrapatisambhajinagar: "Chhatrapati Sambhajinagar", "औरंगाबाद": "Chhatrapati Sambhajinagar", "औरंगाबादछत्रपतीसंभाजीनगर": "Chhatrapati Sambhajinagar",
  osmanabad: "Dharashiv", "उस्मानाबाद": "Dharashiv",
  bid: "Beed", gondiya: "Gondia", buldana: "Buldhana", raigarh: "Raigad", nasik: "Nashik", poona: "Pune",
  sholapur: "Solapur", thana: "Thane", kolhapur: "Kolhapur", jalana: "Jalna", yeotmal: "Yavatmal", wasim: "Washim",
};

/**
 * Maharashtra districts by every accepted spelling (English, Marathi, aliases) → { id, division_id, name_en, name_mr }.
 * Read once per import (36 rows).
 */
export async function loadDistricts() {
  const { rows } = await query(
    "SELECT id, division_id, name_en, name_mr FROM districts WHERE deleted_at IS NULL AND is_active ORDER BY id",
  );
  const byKey = new Map();
  for (const d of rows) {
    byKey.set(normalizeDistrict(d.name_en), d);
    byKey.set(normalizeDistrict(d.name_mr), d);
  }
  const byEnglish = new Map(rows.map((d) => [d.name_en, d]));
  for (const [alias, english] of Object.entries(DISTRICT_ALIASES)) {
    const d = byEnglish.get(english);
    if (d && !byKey.has(normalizeDistrict(alias))) byKey.set(normalizeDistrict(alias), d);
  }
  return { list: rows, find: (text) => byKey.get(normalizeDistrict(text)) ?? null };
}
