-- Official AMRUT social profiles (adds LinkedIn and Google; keeps any X link already set).
UPDATE site_settings
SET value = value || '{
  "instagram": "https://www.instagram.com/mahaamrut_official",
  "facebook": "https://www.facebook.com/share/19FwaH93Lk/",
  "youtube": "https://youtube.com/@mahaamrutpune",
  "linkedin": "https://in.linkedin.com/in/academy-of-maharashtra-research-upliftment-and-training-718924289",
  "google": "https://share.google/ZinoE7EGsy6S4yzEE"
}'::jsonb
WHERE key = 'social';
