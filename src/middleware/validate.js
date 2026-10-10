import { badRequest } from "../utils/errors.js";

// validate({ body, query, params }) — each a zod schema. Parsed (coerced, defaulted) values replace the originals.
export const validate = (schemas) => (req, res, next) => {
  const details = {};
  for (const part of ["params", "query", "body"]) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) {
      // req.query is a getter in Express 5-style routers; define to be safe across versions
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    } else {
      for (const issue of result.error.issues) details[issue.path.join(".") || part] = issue.message;
    }
  }
  if (Object.keys(details).length) return next(badRequest("Please correct the highlighted fields", details));
  next();
};
