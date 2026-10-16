-- Amrut Durgotsav 2026 — migration 023
-- Shivdurg award: previous winners get a photo (felicitation picture) shown on their card.
-- Seeds the 2026 felicitation photos for the two seeded winners; photos already set from the admin panel are left alone.

ALTER TABLE award_winners ADD COLUMN photo VARCHAR(500);

UPDATE award_winners SET photo = '/images/award/winner-pk-ghanekar-1200.webp'
 WHERE name = 'श्री. प्र. के. घाणेकर' AND photo IS NULL;
UPDATE award_winners SET photo = '/images/award/winner-sahyadri-pratishthan-1200.webp'
 WHERE name = 'सह्याद्री प्रतिष्ठान' AND photo IS NULL;
