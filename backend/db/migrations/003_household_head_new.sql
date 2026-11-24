-- Household identification for Resident Profiling.
--   household_no       : Household No. taken from the barangay's household records
--   is_household_head  : the one resident per household who receives announcement SMS
-- (The server also runs these statements at startup, so applying them by hand is optional.)
ALTER TABLE resident_profiles ADD COLUMN IF NOT EXISTS household_no text NOT NULL DEFAULT '';
ALTER TABLE resident_profiles ADD COLUMN IF NOT EXISTS is_household_head boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS resident_profiles_household_no_idx ON resident_profiles (household_no);
-- At most one head per household number.
CREATE UNIQUE INDEX IF NOT EXISTS resident_profiles_one_head_per_household
  ON resident_profiles (household_no) WHERE is_household_head AND household_no <> '';
