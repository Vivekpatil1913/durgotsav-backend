-- Amrut Durgotsav 2026 — migration 019
-- Website visitor counter. One row per day (IST) instead of one global row, so concurrent visits don't all
-- queue on the same row lock, and "today" comes for free. A visit = one browser session (the website sends
-- POST /api/visits once per tab session).

CREATE TABLE IF NOT EXISTS site_visits (
  day    DATE   PRIMARY KEY,
  visits BIGINT NOT NULL DEFAULT 0
);
