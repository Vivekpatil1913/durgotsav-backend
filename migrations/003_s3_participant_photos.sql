-- Participant originals may be stored in Amazon S3 (private bucket). Existing rows keep storage = 'local'
-- and their original_path under storage/originals; nothing is moved or deleted.
ALTER TABLE registration_photos
  ADD COLUMN storage        VARCHAR(10) NOT NULL DEFAULT 'local' CHECK (storage IN ('local', 's3')),
  -- S3 object key, e.g. 12-10-2026/Rahul_Patil_9876543210/Rahul_Patil_9876543210 (1).jpg
  ADD COLUMN storage_key    TEXT,
  -- the "(n)" in the object name; allocated per participant folder and per registration
  ADD COLUMN photo_no       SMALLINT,
  -- file name the participant's browser sent (display only, never used to build paths)
  ADD COLUMN original_name  VARCHAR(255);

CREATE UNIQUE INDEX registration_photos_storage_key_idx ON registration_photos (storage_key) WHERE storage_key IS NOT NULL;

-- Idempotency key sent by the registration form, so a retried submit returns the same registration
ALTER TABLE registrations ADD COLUMN submission_id UUID UNIQUE;
