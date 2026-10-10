// Errors thrown on purpose by services. Anything else is treated as a 500 and its message hidden.
export class AppError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, message, { code: "BAD_REQUEST", details });
export const unauthorized = (message = "Authentication required") => new AppError(401, message, { code: "UNAUTHORIZED" });
export const forbidden = (message = "You do not have permission for this action") => new AppError(403, message, { code: "FORBIDDEN" });
export const notFound = (message = "Not found") => new AppError(404, message, { code: "NOT_FOUND" });
export const conflict = (message, code = "CONFLICT") => new AppError(409, message, { code });

// Wraps an async route handler so rejected promises reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
