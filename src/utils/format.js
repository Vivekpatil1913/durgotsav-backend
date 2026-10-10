const MARATHI_DIGITS = "०१२३४५६७८९";

export const toMarathiDigits = (value) => String(value).replace(/\d/g, (d) => MARATHI_DIGITS[d]);

// Registration number shown to participants, e.g. DGT26-000123. Plain "123" is accepted on lookup too.
export const formatRegistrationNo = (id) => `DGT26-${String(id).padStart(6, "0")}`;
export const formatCertificateNo = (id) => `AMRUT-DGT26-${String(id).padStart(6, "0")}`;

export function parseRegistrationNo(input) {
  const digits = String(input ?? "")
    .trim()
    .replace(/[०-९]/g, (d) => String(MARATHI_DIGITS.indexOf(d)))
    .replace(/^DGT26-?/i, "");
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
