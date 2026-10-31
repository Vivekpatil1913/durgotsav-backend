-- Amrut Durgotsav 2026 — migration 039
-- While the registration form is closed, the website now writes the dates itself from Admin → Settings → Registration
-- dates (Opens / Closes): "online registration will begin between <Opens> and <Closes>", and after the closing date
-- "registration closed on <Closes>". The notice is an optional extra line under them ({opens} / {closes} stand for the
-- dates). The first seeded notice named a fixed date (५ नोव्हेंबर २०२६) that does not follow the settings, so it is
-- cleared; a notice an admin wrote differently is kept as it is.
UPDATE site_settings
SET value = jsonb_set(value, '{note}', '""'::jsonb), updated_at = NOW()
WHERE key = 'registration'
  AND value->>'note' = 'दुर्गोत्सवासाठी ऑनलाइन नोंदणी ५ नोव्हेंबर २०२६ पासून सुरू होईल.';
