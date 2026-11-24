-- "Head of the family" mark in Resident Profiling.
-- Barangay announcement SMS is sent only to residents with this flag set.
-- (The server also runs this statement at startup, so applying it by hand is optional.)
ALTER TABLE resident_profiles
  ADD COLUMN IF NOT EXISTS is_household_head boolean NOT NULL DEFAULT false;
