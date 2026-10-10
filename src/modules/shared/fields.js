import { z } from "zod";

// Admin form helpers: empty strings become null so optional columns are cleared rather than set to "".
const emptyToNull = (v) => (typeof v === "string" && v.trim() === "" ? null : v);

export const text = (max, { required = false, min = 1 } = {}) =>
  required ? z.string().trim().min(min, "Required").max(max) : z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

export const longText = (max = 20000) => text(max);

export const url = () =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(500)
      .refine((v) => v.startsWith("/uploads/") || /^https?:\/\//.test(v) || v.startsWith("/"), "Must be a URL or uploaded file")
      .nullable().optional(),
  );

export const date = () => z.preprocess(emptyToNull, z.string().date("Use YYYY-MM-DD").nullable().optional());
export const datetime = () => z.preprocess(emptyToNull, z.coerce.date().nullable().optional());
export const int = () => z.preprocess(emptyToNull, z.coerce.number().int().nullable().optional());
export const num = () => z.preprocess(emptyToNull, z.coerce.number().nullable().optional());
export const bool = (def) => z.boolean().default(def);
export const sortOrder = () => z.coerce.number().int().default(0);
