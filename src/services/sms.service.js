import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { maskPhone } from "../utils/format.js";

// SRS v2.1 §7: the certificate download link is sent to the registered mobile number.
// "log" only writes the SMS to the server log (no provider configured). "http" calls the gateway URL in SMS_HTTP_URL,
// with {phone} and {message} filled in — the usual shape of Indian bulk-SMS APIs (MSG91, Fast2SMS, Textlocal …),
// whose API key, sender id and DLT template id go into that URL. A driver returns { status, response }.
const drivers = {
  log: async (phone, message) => {
    logger.info({ phone: maskPhone(phone), message }, "SMS (log driver — not actually sent)");
    return { status: "logged", response: null };
  },
  http: async (phone, message) => {
    const url = env.SMS_HTTP_URL.replaceAll("{phone}", encodeURIComponent(phone)).replaceAll("{message}", encodeURIComponent(message));
    const res = await fetch(url, { method: env.SMS_HTTP_METHOD, signal: AbortSignal.timeout(10_000) });
    const response = (await res.text()).slice(0, 500);
    if (!res.ok) throw Object.assign(new Error(`SMS gateway answered HTTP ${res.status}`), { response });
    return { status: "sent", response };
  },
};

// Never throws: { status: 'sent' | 'logged' | 'failed', provider, response, error }
export async function sendSms(phone, message) {
  const provider = env.SMS_DRIVER;
  try {
    return { provider, ...(await drivers[provider](phone, message)), error: null };
  } catch (err) {
    logger.error({ err, phone: maskPhone(phone) }, "SMS could not be sent");
    return { provider, status: "failed", response: err.response ?? null, error: err.message.slice(0, 300) };
  }
}
