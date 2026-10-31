import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const paths = {
  root,
  // Processed, EXIF-free images that are safe to serve publicly. UPLOADS_DIR moves them (tests: uploads/ is committed)
  uploads: process.env.UPLOADS_DIR || path.join(root, "uploads"),
  // Original participant uploads (may contain EXIF/GPS) — never served statically. ORIGINALS_DIR moves them
  privateStorage: process.env.ORIGINALS_DIR || path.join(root, "storage", "originals"),
  // Shivdurg Bhushan award evidence (local storage driver) — private, served only to authorised admins
  awardDocuments: process.env.AWARD_DOCUMENTS_DIR || path.join(root, "storage", "award-documents"),
  certificateAssets: path.join(root, "assets", "certificate"),
  migrations: path.join(root, "migrations"),
};
