// Festival edition — the ONLY value to change in the API for the next year's festival (2027, 2028 …).
// Emails, SMS, certificate PDF details, download file names, the sitemap and registration / certificate numbers
// follow it, and admin text saying {year} is filled in for the public site.
// Keep it equal to EDITION_YEAR in frontend/ and admin/ src/config/edition.js: GET /api/settings reports it as
// edition_year, and the admin console warns when they differ.
// Kept free of imports, so any module (utils/format.js included) can use it.
export const EDITION_YEAR = 2026;

const MARATHI_DIGITS = "०१२३४५६७८९";

// "२०२६" — the same year in Marathi digits
export const EDITION_YEAR_MR = String(EDITION_YEAR).replace(/\d/g, (d) => MARATHI_DIGITS[d]);

// "DGT26" — prefix of registration numbers (DGT26-000123) and certificate numbers (AMRUT-DGT26-000123)
export const NUMBER_PREFIX = `DGT${String(EDITION_YEAR).slice(-2)}`;

// Admin-managed text may say {year} (e.g. "अमृत दुर्गोत्सव {year}") so it needs no yearly edits:
// English fields (*_en) get Latin digits, the others Marathi digits.
export function fillYear(value, key = "") {
  if (typeof value === "string") return value.replaceAll("{year}", key.endsWith("_en") ? String(EDITION_YEAR) : EDITION_YEAR_MR);
  if (Array.isArray(value)) return value.map((v) => fillYear(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillYear(v, k)]));
  return value;
}
