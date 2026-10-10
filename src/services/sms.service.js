import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { maskPhone } from "../utils/format.js";

// PDF §2.8: the certificate download link is sent to the registered mobile number.
// No SMS provider was supplied for 2026, so only the "log" driver exists. To add one (MSG91, Twilio,
// Gupshup…), add a driver here that returns true once the provider accepts the message.
const drivers = {
  log: async (phone, message) => {
    logger.info({ phone: maskPhone(phone), message }, "SMS (log driver — not actually sent)");
    return false;
  },
};

export async function sendSms(phone, message) {
  return drivers[env.SMS_DRIVER](phone, message);
}
