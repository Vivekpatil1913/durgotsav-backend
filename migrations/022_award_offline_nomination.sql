-- Amrut Durgotsav 2026 — migration 022
-- Shivdurg award: nominations are accepted online or offline, so step 1 of the process says so.
-- Only touches the seeded wording, so text already edited from the admin panel is left alone.

UPDATE award_editions
   SET content = jsonb_set(content, '{process,0}', '"ऑनलाइन / ऑफलाइन नामनिर्देशन सादर करणे"')
 WHERE year = 2026 AND content #>> '{process,0}' = 'ऑनलाइन नामनिर्देशन सादर करणे';

UPDATE award_editions
   SET content_en = jsonb_set(content_en, '{process,0}', '"Online / offline nomination"')
 WHERE year = 2026 AND content_en #>> '{process,0}' = 'Online nomination';
