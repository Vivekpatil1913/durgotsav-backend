import nodemailer from "nodemailer";
import { EDITION_YEAR_MR } from "../config/edition.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let transporter;
function transport() {
  if (!env.mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    // Reuse connections: bulk certificate delivery does not open a new TLS session per email
    pool: true,
    maxConnections: env.CERTIFICATE_WORKER_CONCURRENCY,
    maxMessages: 100,
    // Fail rather than hang, so a stuck connection cannot hold a queued certificate past its lease
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
  return transporter;
}

// Returns nodemailer's info ({ messageId, response, … }) once SMTP accepted the mail,
// false when email is switched off (logged instead).
export async function sendMail({ to, subject, html, attachments }) {
  const t = transport();
  if (!t) {
    logger.info({ to, subject }, "Email disabled (SMTP_PASSWORD empty) — message not sent");
    return false;
  }
  return t.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, subject, html, attachments });
}

// Closes pooled SMTP connections (scripts call this so the process can exit)
export function closeMail() {
  transporter?.close();
  transporter = undefined;
}

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Shared branded wrapper for transactional emails
export function emailLayout(bodyHtml) {
  return `<!doctype html><html lang="mr"><body style="margin:0;background:#f6efe3;font-family:'Noto Sans Devanagari',Arial,sans-serif;color:#2a1a0e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" style="max-width:560px;background:#fffaf2;border-radius:16px;overflow:hidden;border:1px solid #ecd9bb">
  <tr><td style="background:#a85a17;padding:20px 28px;color:#fff;font-size:20px;font-weight:700">अमृत दुर्गोत्सव ${EDITION_YEAR_MR}</td></tr>
  <tr><td style="padding:28px;font-size:15px;line-height:1.7">${bodyHtml}</td></tr>
  <tr><td style="padding:16px 28px;background:#f3e6cf;font-size:12px;color:#6b5743">महाराष्ट्र संशोधन, उन्नती व प्रशिक्षण प्रबोधिनी (अमृत), पुणे</td></tr>
  </table></td></tr></table></body></html>`;
}
