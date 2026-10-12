// S3 object keys for participant originals:
//   DD-MM-YYYY/FirstName_LastName_Mobile/FirstName_LastName_Mobile (n).ext
// The date is the registration day in India (Asia/Kolkata), computed on the server.

const IST_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" });

export function istDateFolder(date = new Date()) {
  const p = Object.fromEntries(IST_DATE.formatToParts(date).map((part) => [part.type, part.value]));
  return `${p.day}-${p.month}-${p.year}`;
}

// Letters (any script, incl. Devanagari vowel signs) and digits only: no "/", "..", spaces or control characters.
const cleanWord = (w) => w.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "");

// "Rahul Suresh Patil", "9876543210" -> "Rahul_Patil_9876543210". A single-word name is used as is.
export function participantFolderName(fullName, phone) {
  const words = String(fullName ?? "").split(/\s+/).map(cleanWord).filter(Boolean);
  const parts = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  const name = Array.from(parts.join("_") || "Participant").slice(0, 80).join("");
  const mobile = String(phone ?? "").replace(/\D/g, "");
  return mobile ? `${name}_${mobile}` : name;
}

export const EXTENSIONS = { jpeg: "jpg", png: "png", webp: "webp" };

export function photoObjectKey({ dateFolder, folder, number, ext }) {
  if (!Number.isInteger(number) || number < 1) throw new Error("Photo number must be a positive integer");
  const fileName = `${folder} (${number}).${ext}`;
  return { key: `${dateFolder}/${folder}/${fileName}`, fileName };
}
