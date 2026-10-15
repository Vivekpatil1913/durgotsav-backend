-- A registration may carry up to two current photos: position 1 is the main photo (used for the
-- album, certificates, duplicate review and every single-photo join), position 2 is an optional
-- second view of the replica. Existing rows are all position 1.
ALTER TABLE registration_photos ADD COLUMN IF NOT EXISTS position SMALLINT NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE registration_photos ADD CONSTRAINT registration_photos_position_chk CHECK (position IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- At most one current photo per slot, so joins on "is_current AND position = 1" stay one row per registration.
CREATE UNIQUE INDEX IF NOT EXISTS registration_photos_current_slot_uq
  ON registration_photos (registration_id, position) WHERE is_current;
