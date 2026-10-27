-- Amrut Durgotsav 2026 — migration 026
-- How many people built the replica together. The registration form asks every participant type except
-- "individual" (family, group, society, school, college, organisation), so the world-record tally can count people,
-- not just registrations. Individuals and registrations made before this migration keep it NULL.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS members_count INTEGER
  CONSTRAINT registrations_members_count_check CHECK (members_count BETWEEN 1 AND 100000);
