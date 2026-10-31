import crypto from "node:crypto";
import { env } from "../../config/env.js";

// Participant links (SMS, the pop-up after registering, the mobile lookup): /c/<registration id in base 36>.<signature>.
// The link names a registration: it shows the registration's status and, once an admin has approved it, its certificate.
// The signature is an HMAC of the registration id, so a link cannot be guessed from a registration number, needs no
// database row and never expires.
const KEY = crypto.createHash("sha256").update(`certificate-link:${env.JWT_SECRET}`).digest();
const SIGNATURE_LENGTH = 16; // base64url characters = 96 bits
export const TOKEN_PATTERN = /^[0-9a-z]{1,8}\.[A-Za-z0-9_-]{16}$/;

const sign = (value) => crypto.createHmac("sha256", KEY).update(value).digest("base64url").slice(0, SIGNATURE_LENGTH);
const sameSignature = (given, expected) =>
  given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));

export const certificateToken = (registrationId) => `${Number(registrationId).toString(36)}.${sign(`certificate:${registrationId}`)}`;

// Registration id, or null for a malformed / forged token
export function parseCertificateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const [idPart, signature] = token.split(".");
  const id = parseInt(idPart, 36);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  return sameSignature(signature, sign(`certificate:${id}`)) ? id : null;
}

// The website page that shows one registration's status and certificate
export const certificateLink = (registrationId) => `${env.SITE_URL}/c/${certificateToken(registrationId)}`;

// Printed as a QR code on the certificate: opens the website's verification with the number filled in
export const verifyLink = (certificateNo) => `${env.SITE_URL}/certificate?tab=verify&no=${encodeURIComponent(certificateNo)}`;

// ---------------------------------------------------------------- mobile lookup session

// One CAPTCHA unlocks a mobile number's list for 30 minutes: further pages are fetched with this signed, expiring
// token instead of a new tick each time (a number may hold any number of registrations). Stateless, so any API
// instance accepts it. <phone>.<expiry in base 36>.<signature>
const LOOKUP_MINUTES = 30;
export const LOOKUP_TOKEN_PATTERN = /^[6-9]\d{9}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{16}$/;

export function lookupToken(phone, now = Date.now()) {
  const expires = Math.floor(now / 1000 + LOOKUP_MINUTES * 60).toString(36);
  return `${phone}.${expires}.${sign(`lookup:${phone}:${expires}`)}`;
}

// The mobile number the token unlocks, or null when it is forged or expired
export function parseLookupToken(token, now = Date.now()) {
  if (typeof token !== "string" || !LOOKUP_TOKEN_PATTERN.test(token)) return null;
  const [phone, expires, signature] = token.split(".");
  if (parseInt(expires, 36) * 1000 < now) return null;
  return sameSignature(signature, sign(`lookup:${phone}:${expires}`)) ? phone : null;
}
