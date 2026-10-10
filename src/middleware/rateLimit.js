import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

const make = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit: env.isTest ? 10_000 : limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message } },
  });

export const apiLimiter = make(15, 600, "Too many requests, please slow down");
export const loginLimiter = make(15, 10, "Too many login attempts. Try again in 15 minutes");
export const registerLimiter = make(60, 15, "Too many registrations from this network. Try again later");
// Certificate/status lookups need registration no + mobile; this stops mobile-number guessing
export const lookupLimiter = make(15, 40, "Too many lookups. Try again in a few minutes");
export const contactLimiter = make(60, 8, "Too many messages. Try again later");
