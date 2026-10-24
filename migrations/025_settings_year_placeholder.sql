-- Amrut Durgotsav 2026 — migration 025
-- Settings text can say {year}; the public API fills in EDITION_YEAR (src/config/edition.js).
-- Turns the edition year in the seeded titles into {year}, so they follow the next edition without edits.
-- Only the phrase "दुर्गोत्सव २०२६" is replaced: anything else an admin wrote is left alone.

UPDATE site_settings
   SET value = jsonb_set(value, '{title}', to_jsonb(replace(value->>'title', 'दुर्गोत्सव २०२६', 'दुर्गोत्सव {year}')))
 WHERE key = 'hero' AND value->>'title' LIKE '%दुर्गोत्सव २०२६%';

UPDATE site_settings
   SET value = jsonb_set(value, '{site_name}', to_jsonb(replace(value->>'site_name', 'दुर्गोत्सव २०२६', 'दुर्गोत्सव {year}')))
 WHERE key = 'seo' AND value->>'site_name' LIKE '%दुर्गोत्सव २०२६%';

UPDATE site_settings
   SET value = jsonb_set(value, '{default_title}', to_jsonb(replace(value->>'default_title', 'दुर्गोत्सव २०२६', 'दुर्गोत्सव {year}')))
 WHERE key = 'seo' AND value->>'default_title' LIKE '%दुर्गोत्सव २०२६%';

UPDATE site_settings
   SET value = jsonb_set(value, '{body}', to_jsonb(replace(value->>'body', 'दुर्गोत्सव २०२६', 'दुर्गोत्सव {year}')))
 WHERE key = 'world_record' AND value->>'body' LIKE '%दुर्गोत्सव २०२६%';
