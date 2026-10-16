-- Amrut Durgotsav 2026 — migration 020
-- Visitor counter: count each visitor once per day (IST) instead of once per tab session.
-- site_visitor_days holds a hash of who has already been counted today; site_visits keeps the running totals.
-- Rows older than yesterday are pruned by the API, so this table stays at about two days of visitors.

CREATE TABLE IF NOT EXISTS site_visitor_days (
  day          DATE     NOT NULL,
  visitor_hash CHAR(64) NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);
