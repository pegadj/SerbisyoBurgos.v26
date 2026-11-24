-- Animal Vaccine Tracker: track whether each pet is vaccinated (yes/no) instead of per-dose history.
-- Run with:  node scripts/migrate-db.js
-- (Renumber this file to follow your latest migration if 050 doesn't fit your sequence.)

ALTER TABLE animal_records
  ADD COLUMN IF NOT EXISTS vaccinated boolean NOT NULL DEFAULT false;

-- Keep existing data meaningful: a pet that already had at least one recorded dose counts as vaccinated.
UPDATE animal_records
   SET vaccinated = true
 WHERE id IN (SELECT animal_id FROM animal_vaccinations);

-- The old animal_vaccinations table is intentionally left in place (no data is deleted);
-- the app no longer reads or writes it.
