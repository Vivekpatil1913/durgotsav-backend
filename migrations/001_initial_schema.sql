-- Amrut Durgotsav 2026 — initial schema
-- Status values use CHECK constraints (not PG enums) so they can be extended by a later migration easily.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- admins
CREATE TABLE admins (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(160) NOT NULL,
  password_hash  TEXT NOT NULL,
  role           VARCHAR(20) NOT NULL DEFAULT 'moderator'
                 CHECK (role IN ('super_admin', 'admin', 'moderator')),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX admins_email_unique ON admins (LOWER(email)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- districts (lookup)
CREATE TABLE districts (
  id          SMALLSERIAL PRIMARY KEY,
  name_mr     VARCHAR(80) NOT NULL UNIQUE,
  name_en     VARCHAR(80) NOT NULL UNIQUE,
  sort_order  SMALLINT NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- forts
CREATE TABLE forts (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(80) NOT NULL,
  name_mr       VARCHAR(120) NOT NULL,
  name_en       VARCHAR(120) NOT NULL,
  location_mr   VARCHAR(160),
  state         VARCHAR(60) NOT NULL DEFAULT 'महाराष्ट्र',
  fort_type     VARCHAR(20) NOT NULL DEFAULT 'hill'
                CHECK (fort_type IN ('hill', 'hill-forest', 'coastal', 'island')),
  elevation_m   INTEGER,
  tagline       VARCHAR(200),
  summary       TEXT,
  history       TEXT,
  facts         JSONB NOT NULL DEFAULT '[]'::jsonb,
  latitude      NUMERIC(9, 6),
  longitude     NUMERIC(9, 6),
  cover_image   TEXT,
  is_unesco     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX forts_slug_unique ON forts (slug) WHERE deleted_at IS NULL;
CREATE INDEX forts_listing_idx ON forts (is_active, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE fort_images (
  id          SERIAL PRIMARY KEY,
  fort_id     INTEGER NOT NULL REFERENCES forts (id) ON DELETE CASCADE,
  image_path  TEXT NOT NULL,
  caption     VARCHAR(200),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fort_images_fort_idx ON fort_images (fort_id, sort_order);

-- ---------------------------------------------------------------- registrations
CREATE TABLE registrations (
  id                 SERIAL PRIMARY KEY,
  participant_type   VARCHAR(20) NOT NULL DEFAULT 'individual'
                     CHECK (participant_type IN ('individual', 'family', 'housing_society', 'organization', 'group', 'school', 'college')),
  name               VARCHAR(150) NOT NULL,
  organization_name  VARCHAR(200),
  phone              VARCHAR(10) NOT NULL,
  email              VARCHAR(160),
  district_id        SMALLINT REFERENCES districts (id),
  -- participants outside Maharashtra (PDF §5.1: anyone in the world) leave district empty
  country            VARCHAR(80) NOT NULL DEFAULT 'India',
  city               VARCHAR(120),
  fort_id            INTEGER REFERENCES forts (id) ON DELETE SET NULL,
  replica_notes      VARCHAR(500),
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'info_requested', 'verified', 'rejected')),
  review_note        VARCHAR(500),
  reviewed_by        INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMPTZ,
  consent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source             VARCHAR(10) NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'legacy', 'admin')),
  legacy_id          INTEGER UNIQUE,
  ip_address         VARCHAR(64),
  user_agent         VARCHAR(300),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX registrations_status_idx   ON registrations (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX registrations_district_idx ON registrations (district_id) WHERE deleted_at IS NULL;
CREATE INDEX registrations_fort_idx     ON registrations (fort_id) WHERE deleted_at IS NULL;
CREATE INDEX registrations_phone_idx    ON registrations (phone);
CREATE INDEX registrations_created_idx  ON registrations (created_at DESC);

CREATE TABLE registration_photos (
  id                     SERIAL PRIMARY KEY,
  registration_id        INTEGER NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
  -- relative to storage/originals (private)
  original_path          TEXT,
  -- relative public URLs under /uploads (WebP, EXIF stripped)
  image_path             TEXT NOT NULL,
  thumb_path             TEXT NOT NULL,
  width                  INTEGER,
  height                 INTEGER,
  size_bytes             INTEGER,
  mime_type              VARCHAR(40),
  sha256                 CHAR(64),
  dhash                  CHAR(16),
  duplicate_of_photo_id  INTEGER REFERENCES registration_photos (id) ON DELETE SET NULL,
  -- optional automated score carried over from the 2025 system; informational only
  ai_score               NUMERIC(5, 2),
  is_current             BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX registration_photos_reg_idx      ON registration_photos (registration_id) WHERE is_current;
CREATE INDEX registration_photos_sha_idx      ON registration_photos (sha256);
CREATE INDEX registration_photos_dhash_idx    ON registration_photos (dhash);
CREATE INDEX registration_photos_featured_idx ON registration_photos (is_featured) WHERE is_featured AND is_current;

-- ---------------------------------------------------------------- certificates (अभिनंदन पत्र)
CREATE TABLE certificates (
  id                  SERIAL PRIMARY KEY,
  registration_id     INTEGER NOT NULL UNIQUE REFERENCES registrations (id) ON DELETE CASCADE,
  certificate_no      VARCHAR(40) NOT NULL UNIQUE,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_by           INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  revoked_at          TIMESTAMPTZ,
  revoked_by          INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  revoke_reason       VARCHAR(300),
  emailed_at          TIMESTAMPTZ,
  sms_sent_at         TIMESTAMPTZ,
  download_count      INTEGER NOT NULL DEFAULT 0,
  last_downloaded_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX certificates_issued_idx ON certificates (issued_at DESC);

-- ---------------------------------------------------------------- CMS content
CREATE TABLE events (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  start_date   DATE,
  end_date     DATE,
  -- free text when the PDF gives a relative time, e.g. "पडताळणी पूर्ण झाल्यानंतर"
  date_label   VARCHAR(160),
  icon         VARCHAR(40),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE videos (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  youtube_url  TEXT NOT NULL,
  thumbnail    TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE announcements (
  id            SERIAL PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  body          TEXT,
  link_url      TEXT,
  link_label    VARCHAR(80),
  published_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE testimonials (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(150) NOT NULL,
  designation  VARCHAR(250),
  message      TEXT NOT NULL,
  photo        TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE faqs (
  id          SERIAL PRIMARY KEY,
  question    VARCHAR(300) NOT NULL,
  answer      TEXT NOT NULL,
  category    VARCHAR(60),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- Long-form pages: mission, privacy, terms, rules
CREATE TABLE pages (
  id                SERIAL PRIMARY KEY,
  slug              VARCHAR(80) NOT NULL UNIQUE,
  title             VARCHAR(200) NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  meta_description  VARCHAR(300),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by        INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- contact enquiries
CREATE TABLE contact_enquiries (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  email       VARCHAR(160),
  phone       VARCHAR(15),
  subject     VARCHAR(200),
  message     TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'spam')),
  admin_note  VARCHAR(500),
  ip_address  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX contact_enquiries_status_idx ON contact_enquiries (status, created_at DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- settings & audit
CREATE TABLE site_settings (
  key         VARCHAR(80) PRIMARY KEY,
  value       JSONB NOT NULL,
  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by  INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    INTEGER REFERENCES admins (id) ON DELETE SET NULL,
  action      VARCHAR(60) NOT NULL,
  entity      VARCHAR(60) NOT NULL,
  entity_id   VARCHAR(60),
  meta        JSONB,
  ip_address  VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx  ON audit_logs (entity, entity_id);

-- ---------------------------------------------------------------- updated_at triggers
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['admins','forts','registrations','certificates','events','videos','announcements',
                           'testimonials','faqs','pages','contact_enquiries','site_settings']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
