import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const paths = {
  root,
  // Processed, EXIF-free images that are safe to serve publicly
  uploads: path.join(root, "uploads"),
  // Original participant uploads (may contain EXIF/GPS) — never served statically
  privateStorage: path.join(root, "storage", "originals"),
  certificateAssets: path.join(root, "assets", "certificate"),
  migrations: path.join(root, "migrations"),
};
