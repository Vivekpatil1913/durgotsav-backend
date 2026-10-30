-- Amrut Durgotsav 2026 — migration 029
-- दुर्गवीर numbers start at 10000 (AMRUT's decision): the first certificate is दुर्गवीर क्र. 10000, then 10001 …
-- Certificates numbered by migration 028 move up in the same order (1 → 10000, 2 → 10001 …). In production 028 and
-- 029 run in one deploy, before any certificate with a दुर्गवीर number has been emailed.

-- Two steps through negative values, so no row ever takes a number another row still holds (UNIQUE is checked per row)
UPDATE certificates SET durgveer_no = -durgveer_no WHERE durgveer_no < 10000;
UPDATE certificates SET durgveer_no = 9999 - durgveer_no WHERE durgveer_no < 0;

-- Continue after the highest number; 10000 when there are no certificates yet
SELECT setval('certificates_durgveer_no_seq', GREATEST(COALESCE(MAX(durgveer_no) + 1, 10000), 10000), false) FROM certificates;
ALTER SEQUENCE certificates_durgveer_no_seq MINVALUE 10000 START WITH 10000;
ALTER TABLE certificates ADD CONSTRAINT certificates_durgveer_no_min CHECK (durgveer_no >= 10000);
