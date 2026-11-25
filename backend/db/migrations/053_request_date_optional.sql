-- Preferred date / time slot are now optional on a service request: staff text the resident when the
-- document is ready for pickup, so residents no longer have to pick a slot. Run with:  node scripts/migrate-db.js
ALTER TABLE service_requests ALTER COLUMN preferred_date DROP NOT NULL;
ALTER TABLE service_requests ALTER COLUMN preferred_time_slot DROP NOT NULL;
