-- Amrut Durgotsav 2026 — migration 027
-- Optional WhatsApp number, asked for every participant type. The form fills it from the mobile number when the
-- participant ticks "same as mobile". NULL when not given (and for registrations made before this migration).

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(10)
  CONSTRAINT registrations_whatsapp_number_check CHECK (whatsapp_number ~ '^[6-9][0-9]{9}$');
