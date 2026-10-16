-- Amrut Durgotsav 2026 — migration 021
-- Shivdurg award: scrutiny of applications now runs until 5 November (was 3 November).
-- Only touches the seeded value, so a date already changed from the admin panel is left alone.

UPDATE award_editions
   SET scrutiny_ends_on = '2026-11-05'
 WHERE year = 2026 AND scrutiny_ends_on = '2026-11-03';
