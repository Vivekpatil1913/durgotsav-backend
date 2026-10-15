-- Amrut Durgotsav 2026 — migration 004
-- Adds a divisions master table and upgrades the districts lookup table to a full CMS resource.

-- ---------------------------------------------------------------- divisions
CREATE TABLE divisions (
  id          SMALLSERIAL  PRIMARY KEY,
  name_mr     VARCHAR(80)  NOT NULL,
  name_en     VARCHAR(80)  NOT NULL,
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE TRIGGER divisions_updated_at BEFORE UPDATE ON divisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO divisions (name_mr, name_en, sort_order) VALUES
  ('कोकण',               'Konkan',                    1),
  ('नाशिक',              'Nashik',                    2),
  ('पुणे',               'Pune',                      3),
  ('छत्रपती संभाजीनगर', 'Chhatrapati Sambhajinagar', 4),
  ('अमरावती',            'Amravati',                  5),
  ('नागपूर',             'Nagpur',                    6);

-- ---------------------------------------------------------------- upgrade districts
-- The existing districts table is a bare lookup with no CMS columns.
-- We add the standard soft-delete / active-flag columns and a division FK.
ALTER TABLE districts
  ADD COLUMN IF NOT EXISTS division_id   SMALLINT    REFERENCES divisions(id),
  ADD COLUMN IF NOT EXISTS division_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;

CREATE TRIGGER districts_updated_at BEFORE UPDATE ON districts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- seed 36 districts
-- ON CONFLICT (name_en) keeps the migration idempotent if districts were manually populated.
INSERT INTO districts (name_mr, name_en, division_id, division_name, sort_order) VALUES
-- Konkan (7)
('पालघर',              'Palghar',                      1, 'Konkan',                     1),
('ठाणे',               'Thane',                        1, 'Konkan',                     2),
('मुंबई शहर',          'Mumbai City',                  1, 'Konkan',                     3),
('मुंबई उपनगर',        'Mumbai Suburban',               1, 'Konkan',                     4),
('रायगड',              'Raigad',                       1, 'Konkan',                     5),
('रत्नागिरी',          'Ratnagiri',                    1, 'Konkan',                     6),
('सिंधुदुर्ग',         'Sindhudurg',                   1, 'Konkan',                     7),
-- Nashik (5)
('नाशिक',              'Nashik',                       2, 'Nashik',                     8),
('धुळे',               'Dhule',                        2, 'Nashik',                     9),
('नंदुरबार',           'Nandurbar',                    2, 'Nashik',                    10),
('जळगाव',              'Jalgaon',                      2, 'Nashik',                    11),
('अहिल्यानगर',         'Ahilyanagar',                  2, 'Nashik',                    12),
-- Pune (5)
('पुणे',               'Pune',                         3, 'Pune',                      13),
('सोलापूर',            'Solapur',                      3, 'Pune',                      14),
('सातारा',             'Satara',                       3, 'Pune',                      15),
('सांगली',             'Sangli',                       3, 'Pune',                      16),
('कोल्हापूर',          'Kolhapur',                     3, 'Pune',                      17),
-- Chhatrapati Sambhajinagar (8)
('छत्रपती संभाजीनगर', 'Chhatrapati Sambhajinagar',    4, 'Chhatrapati Sambhajinagar', 18),
('जालना',              'Jalna',                        4, 'Chhatrapati Sambhajinagar', 19),
('बीड',                'Beed',                         4, 'Chhatrapati Sambhajinagar', 20),
('धाराशिव',            'Dharashiv',                    4, 'Chhatrapati Sambhajinagar', 21),
('लातूर',              'Latur',                        4, 'Chhatrapati Sambhajinagar', 22),
('नांदेड',             'Nanded',                       4, 'Chhatrapati Sambhajinagar', 23),
('हिंगोली',            'Hingoli',                      4, 'Chhatrapati Sambhajinagar', 24),
('परभणी',              'Parbhani',                     4, 'Chhatrapati Sambhajinagar', 25),
-- Amravati (5)
('अमरावती',            'Amravati',                     5, 'Amravati',                  26),
('बुलढाणा',            'Buldhana',                     5, 'Amravati',                  27),
('वाशिम',              'Washim',                       5, 'Amravati',                  28),
('अकोला',              'Akola',                        5, 'Amravati',                  29),
('यवतमाळ',             'Yavatmal',                     5, 'Amravati',                  30),
-- Nagpur (6)
('नागपूर',             'Nagpur',                       6, 'Nagpur',                    31),
('वर्धा',              'Wardha',                       6, 'Nagpur',                    32),
('भंडारा',             'Bhandara',                     6, 'Nagpur',                    33),
('गोंदिया',            'Gondia',                       6, 'Nagpur',                    34),
('चंद्रपूर',           'Chandrapur',                   6, 'Nagpur',                    35),
('गडचिरोली',           'Gadchiroli',                   6, 'Nagpur',                    36)
ON CONFLICT (name_en) DO UPDATE SET
  division_id   = EXCLUDED.division_id,
  division_name = EXCLUDED.division_name,
  sort_order    = EXCLUDED.sort_order;
