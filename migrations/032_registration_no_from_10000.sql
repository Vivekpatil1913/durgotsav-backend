-- Amrut Durgotsav 2026 — migration 032
-- Registration numbers start at 10000 (AMRUT's decision): the first form submitted is DGT26-010000, then 010001 …
-- (the दुर्गवीर number on the certificate already starts at 10000 — migration 029).
-- Rows numbered below 10000 keep their numbers; new ones continue after the highest, never below 10000.
-- MINVALUE / START make it stick: a fresh start with TRUNCATE … RESTART IDENTITY begins again at 10000.
SELECT setval('registrations_id_seq', GREATEST(COALESCE(MAX(id) + 1, 10000), 10000), false) FROM registrations;
ALTER SEQUENCE registrations_id_seq MINVALUE 10000 START WITH 10000;
