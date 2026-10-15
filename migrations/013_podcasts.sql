-- Podcast episodes shown on the home page and /videos (YouTube video ids).
CREATE TABLE podcasts (
  id           SERIAL PRIMARY KEY,
  youtube_id   VARCHAR(11)  NOT NULL,
  title_mr     VARCHAR(300) NOT NULL,
  title_en     VARCHAR(300) NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX podcasts_live_idx ON podcasts (sort_order, id) WHERE deleted_at IS NULL;
CREATE TRIGGER podcasts_updated_at BEFORE UPDATE ON podcasts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Episodes recorded during Durgotsav 2025 (previously hard-coded in the frontend)
INSERT INTO podcasts (youtube_id, title_mr, title_en, sort_order) VALUES
  ('a1e7gGWgisQ', 'शिवछत्रपतींचे गडदुर्ग रहस्य – प्र. के. घाणेकर यांची ज्ञानगाथा | भाग पहिला', 'Secrets of Shivaji Maharaj''s Forts – The Knowledge Saga of P. K. Ghanekar | Part 1', 1),
  ('q6-J8HfxacY', 'शिवछत्रपतींचे गडदुर्ग रहस्य – प्र. के. घाणेकर यांची ज्ञानगाथा | भाग दुसरा', 'Secrets of Shivaji Maharaj''s Forts – The Knowledge Saga of P. K. Ghanekar | Part 2', 2),
  ('ERUZw50VpSI', 'छत्रपतींच्या दुर्गांमागची कथा: शौर्य आणि संस्कारांचा प्रवास', 'The Story Behind Chhatrapati''s Forts: A Journey of Valour and Values', 3),
  ('Jvdb3nCGpsc', 'Inside AMRUT’s Guinness Record: Official Remarks by Mr. Praveen Patel', 'Inside AMRUT’s Guinness Record: Official Remarks by Mr. Praveen Patel', 4),
  ('SOxzZ50gEoM', 'SHIVABA RAJA – By AMRUT', 'SHIVABA RAJA – By AMRUT', 5);
