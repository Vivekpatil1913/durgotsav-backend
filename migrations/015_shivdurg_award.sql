-- Amrut Durgotsav 2026 — migration 015
-- अमृत शिवदुर्ग भूषण पुरस्कार: award editions (admin-configurable dates/content), committee, winners,
-- nominators, nominations (individual + organization), repeatable work details, evidence and review history.
-- Additive only: no existing table is changed except roles.permissions (new module keys merged in).

-- ---------------------------------------------------------------- editions (one row per award year)
CREATE TABLE award_editions (
  id                    SERIAL       PRIMARY KEY,
  year                  INTEGER      NOT NULL UNIQUE CHECK (year BETWEEN 2000 AND 2100),
  reference_prefix      VARCHAR(12)  NOT NULL,                -- e.g. ASBP26 → ASBP26-I-000001
  title                 VARCHAR(200) NOT NULL,
  title_en              VARCHAR(200),
  tagline               VARCHAR(600),
  tagline_en            VARCHAR(600),
  is_current            BOOLEAN      NOT NULL DEFAULT false,  -- the edition the website shows
  nominations_enabled   BOOLEAN      NOT NULL DEFAULT true,   -- master switch
  nomination_opens_at   TIMESTAMPTZ  NOT NULL,
  nomination_closes_at  TIMESTAMPTZ  NOT NULL,
  scrutiny_starts_on    DATE,
  scrutiny_ends_on      DATE,
  closed_note           VARCHAR(600),
  prize_individual      VARCHAR(300) NOT NULL,
  prize_organization    VARCHAR(300) NOT NULL,
  -- Long-form page content: { intro, objectives[], eligibility[], instructions[], documents[], process[], faqs[{q,a}], help }
  content               JSONB        NOT NULL DEFAULT '{}',
  max_upload_mb         INTEGER      NOT NULL DEFAULT 10 CHECK (max_upload_mb BETWEEN 1 AND 25),
  max_documents         INTEGER      NOT NULL DEFAULT 10 CHECK (max_documents BETWEEN 1 AND 30),
  allow_video           BOOLEAN      NOT NULL DEFAULT false,  -- MP4 / WebM evidence
  updated_by            INTEGER      REFERENCES admins(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (nomination_closes_at > nomination_opens_at)
);
CREATE UNIQUE INDEX uq_award_editions_current ON award_editions(is_current) WHERE is_current;
CREATE TRIGGER award_editions_updated_at BEFORE UPDATE ON award_editions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- committee & public winners list
CREATE TABLE award_committee_members (
  id          SERIAL       PRIMARY KEY,
  edition_id  INTEGER      NOT NULL REFERENCES award_editions(id) ON DELETE CASCADE,
  name        VARCHAR(160) NOT NULL,
  designation VARCHAR(300),
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX idx_award_committee_edition ON award_committee_members(edition_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER award_committee_members_updated_at BEFORE UPDATE ON award_committee_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- nominators (kept apart from nominees)
CREATE TABLE award_nominators (
  id          SERIAL       PRIMARY KEY,
  full_name   VARCHAR(160) NOT NULL,
  mobile      VARCHAR(10)  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_award_nominators_mobile ON award_nominators(mobile);

-- ---------------------------------------------------------------- nominations (common header)
CREATE TABLE award_nominations (
  id                      SERIAL       PRIMARY KEY,
  edition_id              INTEGER      NOT NULL REFERENCES award_editions(id) ON DELETE RESTRICT,
  nominator_id            INTEGER      NOT NULL REFERENCES award_nominators(id) ON DELETE RESTRICT,
  category                VARCHAR(20)  NOT NULL CHECK (category IN ('individual', 'organization')),
  reference_no            VARCHAR(30)  UNIQUE,                 -- set in the same transaction as the insert
  status                  VARCHAR(20)  NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'under_review', 'shortlisted', 'selected', 'not_selected')),
  submission_id           UUID         NOT NULL UNIQUE,        -- client idempotency key
  nominee_name            VARCHAR(250) NOT NULL,               -- person or organization (listing/search)
  mobile                  VARCHAR(10)  NOT NULL,               -- nominee / organization contact
  email                   VARCHAR(160) NOT NULL,
  address                 TEXT         NOT NULL,
  district_id             INTEGER      NOT NULL REFERENCES districts(id),
  taluka_id               INTEGER      NOT NULL REFERENCES talukas(id),
  work_started_year       INTEGER      NOT NULL CHECK (work_started_year BETWEEN 1900 AND 2100),
  work_categories         TEXT[]       NOT NULL DEFAULT '{}',
  work_category_other     VARCHAR(300),
  declaration_place       VARCHAR(120) NOT NULL,
  declaration_date        DATE         NOT NULL,
  declaration_name        VARCHAR(160) NOT NULL,
  declaration_accepted_at TIMESTAMPTZ  NOT NULL,
  ip_address              INET,
  user_agent              VARCHAR(400),
  submitted_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status_changed_at       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_award_nominations_list     ON award_nominations(edition_id, submitted_at DESC);
CREATE INDEX idx_award_nominations_status   ON award_nominations(edition_id, status);
CREATE INDEX idx_award_nominations_category ON award_nominations(edition_id, category);
CREATE INDEX idx_award_nominations_district ON award_nominations(district_id, taluka_id);
CREATE INDEX idx_award_nominations_work     ON award_nominations USING GIN (work_categories);
CREATE INDEX idx_award_nominations_nominator ON award_nominations(nominator_id);
-- Final selection: at most one winner per category per award year
CREATE UNIQUE INDEX uq_award_nominations_winner ON award_nominations(edition_id, category) WHERE status = 'selected';
CREATE TRIGGER award_nominations_updated_at BEFORE UPDATE ON award_nominations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Individual nominee (व्यक्ती)
CREATE TABLE award_individual_nominees (
  nomination_id           INTEGER      PRIMARY KEY REFERENCES award_nominations(id) ON DELETE CASCADE,
  full_name               VARCHAR(160) NOT NULL,
  father_or_husband_name  VARCHAR(160) NOT NULL,
  date_of_birth           DATE         NOT NULL,
  conservation_work       TEXT         NOT NULL,   -- गड-दुर्ग संवर्धनासाठी केलेल्या कार्याची माहिती
  lectures_awareness      TEXT,                    -- व्याख्याने, जनजागृती, प्रशिक्षण, मार्गदर्शन
  external_references     TEXT                     -- बाह्य संदर्भ (articles, websites, media)
);

-- Organization nominee (संस्था)
CREATE TABLE award_organization_nominees (
  nomination_id           INTEGER      PRIMARY KEY REFERENCES award_nominations(id) ON DELETE CASCADE,
  org_type                VARCHAR(30)  NOT NULL
                          CHECK (org_type IN ('public_trust', 'registered_society', 'society', 'company', 'ngo', 'other')),
  org_type_other          VARCHAR(160),
  established_on          DATE,
  established_year        INTEGER      NOT NULL CHECK (established_year BETWEEN 1800 AND 2100),
  registration_no         VARCHAR(120),
  registration_date       DATE,
  registration_authority  VARCHAR(200),
  pan                     VARCHAR(10),
  website                 VARCHAR(500),
  pincode                 VARCHAR(6)   NOT NULL,
  conservation_details    TEXT         NOT NULL,   -- संवर्धन आणि संरक्षणासाठी केलेल्या कामाचा तपशील
  research_documentation  TEXT,
  research_tools          TEXT[]       NOT NULL DEFAULT '{}',
  youth_participation     TEXT,
  volunteer_count         INTEGER      CHECK (volunteer_count >= 0),
  media_publicity         TEXT,
  distinctive_features    TEXT         NOT NULL
);

-- Authorized officials of an organization (repeatable)
CREATE TABLE award_nomination_officials (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  name          VARCHAR(160) NOT NULL,
  designation   VARCHAR(160) NOT NULL,
  email         VARCHAR(160) NOT NULL,
  mobile        VARCHAR(10)  NOT NULL,
  address       TEXT         NOT NULL
);
CREATE INDEX idx_award_officials_nomination ON award_nomination_officials(nomination_id, sort_order);

-- Notable works (individual) / major initiatives (organization)
CREATE TABLE award_nomination_activities (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  title         VARCHAR(250) NOT NULL,
  fort_name     VARCHAR(250),
  work_type     VARCHAR(250),
  period        VARCHAR(120),
  details       TEXT,
  beneficiaries INTEGER      CHECK (beneficiaries >= 0)
);
CREATE INDEX idx_award_activities_nomination ON award_nomination_activities(nomination_id, sort_order);

-- Research, writing and publications
CREATE TABLE award_nomination_publications (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  title         VARCHAR(300) NOT NULL,
  pub_type      VARCHAR(120),
  publisher     VARCHAR(250),
  year          INTEGER      CHECK (year BETWEEN 1900 AND 2100),
  details       TEXT
);
CREATE INDEX idx_award_publications_nomination ON award_nomination_publications(nomination_id, sort_order);

-- Awards, honours and certificates received
CREATE TABLE award_nomination_honours (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  title         VARCHAR(300) NOT NULL,
  awarded_by    VARCHAR(250),
  year          INTEGER      CHECK (year BETWEEN 1900 AND 2100),
  details       TEXT
);
CREATE INDEX idx_award_honours_nomination ON award_nomination_honours(nomination_id, sort_order);

-- Evidence: an uploaded file, an external link, or both. Files live in private storage, never in the DB.
CREATE TABLE award_nomination_documents (
  id             SERIAL       PRIMARY KEY,
  nomination_id  INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  title          VARCHAR(250),
  doc_type       VARCHAR(40),
  description    TEXT,
  external_url   VARCHAR(1000),
  storage        VARCHAR(10)  CHECK (storage IN ('local', 's3')),
  storage_key    VARCHAR(500),               -- relative path (local) or object key (s3)
  original_name  VARCHAR(255),
  mime_type      VARCHAR(100),
  size_bytes     INTEGER,
  sha256         CHAR(64),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (external_url IS NOT NULL OR storage_key IS NOT NULL)
);
CREATE INDEX idx_award_documents_nomination ON award_nomination_documents(nomination_id, sort_order);

-- Status workflow history (audit trail of every change)
CREATE TABLE award_nomination_status_history (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  from_status   VARCHAR(20),
  to_status     VARCHAR(20)  NOT NULL,
  remarks       TEXT,
  admin_id      INTEGER      REFERENCES admins(id) ON DELETE SET NULL,
  ip_address    INET,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_award_status_history_nomination ON award_nomination_status_history(nomination_id, created_at);

-- Committee review notes / remarks
CREATE TABLE award_nomination_remarks (
  id            SERIAL       PRIMARY KEY,
  nomination_id INTEGER      NOT NULL REFERENCES award_nominations(id) ON DELETE CASCADE,
  admin_id      INTEGER      REFERENCES admins(id) ON DELETE SET NULL,
  body          TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_award_remarks_nomination ON award_nomination_remarks(nomination_id, created_at);

-- Public "previous winners" list (admin-managed; may reference a selected nomination)
CREATE TABLE award_winners (
  id            SERIAL       PRIMARY KEY,
  year          INTEGER      CHECK (year BETWEEN 1900 AND 2100),
  category      VARCHAR(20)  NOT NULL CHECK (category IN ('individual', 'organization')),
  name          VARCHAR(250) NOT NULL,
  description   TEXT,
  nomination_id INTEGER      REFERENCES award_nominations(id) ON DELETE SET NULL,
  sort_order    INTEGER      NOT NULL DEFAULT 0,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_award_winners_active ON award_winners(sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER award_winners_updated_at BEFORE UPDATE ON award_winners FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- seed: 2026 edition (values from the Developer Requirements document)
INSERT INTO award_editions (
  year, reference_prefix, title, title_en, tagline, tagline_en, is_current, nominations_enabled,
  nomination_opens_at, nomination_closes_at, scrutiny_starts_on, scrutiny_ends_on, closed_note,
  prize_individual, prize_organization, content
) VALUES (
  2026, 'ASBP26',
  'अमृत शिवदुर्ग भूषण पुरस्कार २०२६',
  'Amrut Shivdurg Bhushan Puraskar 2026',
  'महाराष्ट्रातील गडदुर्गांचा इतिहास, संशोधन, जतन व संवर्धनासाठी उल्लेखनीय कार्य करणाऱ्या व्यक्ती आणि संस्थांचा सन्मान.',
  'Honouring individuals and organisations doing remarkable work for the history, research, preservation and conservation of Maharashtra''s forts.',
  true, true,
  '2026-10-16T00:00:00+05:30', '2026-10-31T23:59:59+05:30', '2026-11-02', '2026-11-03',
  'नामनिर्देशनाची मुदत संपली आहे. निवड प्रक्रियेबाबतची माहिती लवकरच प्रसिद्ध केली जाईल.',
  '₹५१,००० रोख + सन्मानपत्र + स्मृतिचिन्ह',
  '₹५१,००० रोख + सन्मानपत्र + स्मृतिचिन्ह',
  '{
    "intro": "छत्रपती शिवाजी महाराजांच्या स्वराज्याचे साक्षीदार असलेले गडदुर्ग हा महाराष्ट्राचा अमूल्य वारसा आहे. या गडदुर्गांचा इतिहास, संशोधन, दस्तऐवजीकरण, जतन, संवर्धन व जनजागृती यासाठी निःस्वार्थपणे कार्य करणाऱ्या व्यक्ती आणि संस्थांच्या कार्याची दखल घेऊन त्यांचा गौरव करण्यासाठी महाराष्ट्र संशोधन, उन्नती व प्रशिक्षण प्रबोधिनी (अमृत) तर्फे ‘अमृत शिवदुर्ग भूषण पुरस्कार’ प्रदान करण्यात येतो.",
    "objectives": [
      "गडदुर्ग संवर्धन, संरक्षण व स्वच्छतेसाठी कार्य करणाऱ्यांचा सन्मान करणे.",
      "गडदुर्गांच्या इतिहासाचे संशोधन व दस्तऐवजीकरण करणाऱ्यांना प्रोत्साहन देणे.",
      "गडदुर्गांविषयी जनजागृती, लेखन, छायाचित्रण व माध्यमांतून प्रसार करणाऱ्या कार्याला चालना देणे.",
      "युवक, विद्यार्थी व स्वयंसेवकांचा वारसा संवर्धनातील सहभाग वाढवणे."
    ],
    "eligibility": [
      "गड-दुर्ग क्षेत्रात उल्लेखनीय कार्य करणारी व्यक्ती ‘व्यक्तिगत विभागात’ नामनिर्देशित करता येईल.",
      "गड-दुर्ग क्षेत्रात कार्य करणारी नोंदणीकृत / अनोंदणीकृत संस्था ‘संस्थात्मक विभागात’ नामनिर्देशित करता येईल.",
      "नामनिर्देशन स्वतः किंवा इतर कोणत्याही व्यक्तीकडून करता येईल; नामनिर्देशकाचे नाव व संपर्क क्रमांक आवश्यक आहे.",
      "सादर केलेल्या कार्याचे पुरावे (कागदपत्रे, छायाचित्रे, लिंक्स) तपासणीसाठी उपलब्ध असणे आवश्यक आहे."
    ],
    "instructions": [
      "नामनिर्देशनाचा प्रकार (व्यक्ती / संस्था) निवडा. एका अर्जात एकाच नामनिर्देशितीची माहिती भरा.",
      "तारांकित (*) माहिती भरणे अनिवार्य आहे.",
      "कार्याचे पुरावे PDF, JPG किंवा PNG स्वरूपात अपलोड करा किंवा संबंधित लिंक द्या.",
      "अर्ज सादर करण्यापूर्वी ‘पुनरावलोकन’ पानावर सर्व माहिती तपासा. सादर केल्यानंतर अर्जात बदल करता येणार नाही.",
      "अर्ज सादर झाल्यावर मिळणारा संदर्भ क्रमांक जपून ठेवा."
    ],
    "documents": [
      "संस्थेचे नोंदणी प्रमाणपत्र (संस्थात्मक विभागासाठी, लागू असल्यास)",
      "कार्याशी संबंधित कागदपत्रे व अहवाल",
      "छायाचित्रे / चित्रफिती",
      "वृत्तपत्रातील कात्रणे, लेख, पुस्तके",
      "प्राप्त पुरस्कार व प्रमाणपत्रे",
      "माहितीपट, संकेतस्थळ व समाजमाध्यमांवरील लिंक्स"
    ],
    "process": [
      "ऑनलाइन नामनिर्देशन सादर करणे",
      "अर्जांची छाननी",
      "समितीकडून पुनरावलोकन व निवड",
      "पुरस्कार घोषणा व वितरण"
    ],
    "faqs": [
      {"q": "एकापेक्षा जास्त व्यक्ती / संस्थांचे नामनिर्देशन करता येईल का?", "a": "होय. प्रत्येक नामनिर्देशितीसाठी स्वतंत्र अर्ज भरावा."},
      {"q": "अर्ज सादर केल्यानंतर बदल करता येतील का?", "a": "नाही. अर्ज सादर करण्यापूर्वी पुनरावलोकन पानावर सर्व माहिती तपासा."},
      {"q": "कोणती कागदपत्रे अपलोड करता येतील?", "a": "PDF, JPG व PNG फाइल्स अपलोड करता येतील. मोठ्या चित्रफितींसाठी YouTube / Drive लिंक द्यावी."},
      {"q": "निवडीबाबतचा अंतिम निर्णय कोणाचा असेल?", "a": "पुरस्कार निवड प्रक्रियेसंदर्भात अमृत संस्थेचा / समितीचा निर्णय अंतिम राहील."}
    ],
    "help": "नामनिर्देशनाबाबत अडचण असल्यास संपर्क पानावरील ई-मेल किंवा हेल्पलाइनवर संपर्क साधा."
  }'
);

INSERT INTO award_winners (year, category, name, description, sort_order) VALUES
  (NULL, 'individual',   'श्री. प्र. के. घाणेकर', 'व्यक्तिगत विभाग', 1),
  (NULL, 'organization', 'सह्याद्री प्रतिष्ठान',  'संस्थात्मक विभाग', 2);

-- ---------------------------------------------------------------- RBAC: new modules on built-in roles
UPDATE roles SET permissions = permissions || '{
  "shivdurg_award":        {"read": true, "write": true},
  "shivdurg_award_config": {"read": true, "write": true}
}'::jsonb WHERE slug = 'admin';
