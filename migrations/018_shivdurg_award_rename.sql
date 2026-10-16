-- Amrut Durgotsav 2026 — migration 018
-- The award is named "शिवदुर्ग भूषण पुरस्कार २०२६ / Shivdurg Bhushan Puraskar 2026" (without "अमृत / Amrut").
-- Renames the seeded title and the award name inside the page text. References to AMRUT, the organiser, stay.

UPDATE award_editions SET
  title    = replace(title, 'अमृत शिवदुर्ग भूषण पुरस्कार', 'शिवदुर्ग भूषण पुरस्कार'),
  title_en = replace(title_en, 'Amrut Shivdurg Bhushan Puraskar', 'Shivdurg Bhushan Puraskar'),
  content    = replace(content::text, 'अमृत शिवदुर्ग भूषण पुरस्कार', 'शिवदुर्ग भूषण पुरस्कार')::jsonb,
  content_en = replace(content_en::text, 'Amrut Shivdurg Bhushan Puraskar', 'Shivdurg Bhushan Puraskar')::jsonb
WHERE title LIKE '%अमृत शिवदुर्ग%' OR title_en LIKE '%Amrut Shivdurg%'
   OR content::text LIKE '%अमृत शिवदुर्ग%' OR content_en::text LIKE '%Amrut Shivdurg%';
