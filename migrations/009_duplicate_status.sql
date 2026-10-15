-- Adds the 'duplicate' review status: an admin marks a registration whose photo was already
-- submitted in another registration (परिशिष्ट-अ §3.4 — the same photo may not be reused).
ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check
  CHECK (status IN ('pending', 'info_requested', 'verified', 'rejected', 'duplicate'));
