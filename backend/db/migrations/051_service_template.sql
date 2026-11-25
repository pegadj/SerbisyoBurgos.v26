-- Service templates: staff can upload a Word (.docx) body template per service (Portal Configuration).
-- The Document Generator then lists that service and prints it inside the fixed barangay letterhead.
-- Run with:  node scripts/migrate-db.js

ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS template_html text,
  ADD COLUMN IF NOT EXISTS template_file_name text,
  ADD COLUMN IF NOT EXISTS template_updated_at timestamptz;
