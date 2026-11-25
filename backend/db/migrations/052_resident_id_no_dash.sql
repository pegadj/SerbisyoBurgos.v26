node scripts/migrate-db.js-- Resident IDs change format from "SB-00021" to "SB00021" (no dash).
-- Residents now log in with the Resident ID only. Run with:  node scripts/migrate-db.js
UPDATE users          SET resident_id       = replace(resident_id, 'SB-', 'SB')       WHERE resident_id       LIKE 'SB-%';
UPDATE animal_records SET owner_resident_id = replace(owner_resident_id, 'SB-', 'SB') WHERE owner_resident_id LIKE 'SB-%';
