-- Stores the taluka the participant picks on the registration form, so admins can filter by it.
-- Registrations made before this migration keep taluka_id NULL.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS taluka_id INT REFERENCES talukas(id);

CREATE INDEX IF NOT EXISTS registrations_taluka_idx ON registrations (taluka_id) WHERE deleted_at IS NULL;
