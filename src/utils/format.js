import { NUMBER_PREFIX } from "../config/edition.js";

const MARATHI_DIGITS = "०१२३४५६७८९";

export const toMarathiDigits = (value) => String(value).replace(/\d/g, (d) => MARATHI_DIGITS[d]);

// Registration number shown to participants, e.g. DGT26-000123 (the prefix follows EDITION_YEAR).
// Plain "123" is accepted on lookup too.
export const formatRegistrationNo = (id) => `${NUMBER_PREFIX}-${String(id).padStart(6, "0")}`;
export const formatCertificateNo = (id) => `AMRUT-${NUMBER_PREFIX}-${String(id).padStart(6, "0")}`;

export function parseRegistrationNo(input) {
  const digits = String(input ?? "")
    .trim()
    .replace(/[०-९]/g, (d) => String(MARATHI_DIGITS.indexOf(d)))
    // Any edition's prefix (DGT26-, DGT27-…), so numbers from earlier years and old links still resolve
    .replace(/^DGT\d{2}(?:-|(?=\d{6}$))/i, "");
  return /^\d{1,9}$/.test(digits) ? Number(digits) : null;
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

export const maskPhone = (phone) => (phone ? `${phone.slice(0, 2)}******${phone.slice(-2)}` : null);
