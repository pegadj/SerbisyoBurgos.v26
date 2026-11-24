-- 001_schema.sql — Serbisyo Burgos: MongoDB -> PostgreSQL (Render)
--
-- Design notes
--  * IDs are uuid. The ETL maps each Mongo ObjectId deterministically to a uuid
--    (00000000 + the 24 hex chars), so re-running the import is idempotent and
--    references stay consistent. New rows get gen_random_uuid().
--  * Enums are text + CHECK (easier to evolve than CREATE TYPE).
--  * 'YYYY-MM-DD' string fields (appointment_date, preferred_date, ...) become
--    real `date` columns. Set a pg type parser so they come back as strings
--    (see src/config/pgClient.js) and server.js keeps working unchanged.
--  * Embedded arrays that were always read with their parent stay as jsonb
--    (status_timeline). Embedded arrays with their own identity ($push/$pull
--    by _id) become child tables (animal_vaccinations).
--  * Mongoose `timestamps` is replaced by a trigger on updated_at.
--  * Mongo TTL index on password reset codes has no equivalent: expired rows
--    must be deleted by the app or a Render cron job (see bottom of file).

BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- files ----
-- Replaces GridFS (bucket "uploads"). Fine for avatars (<=5MB) and ID photos
-- (<=10MB) at barangay scale. If volume grows, move `data` to S3/R2 and keep
-- this table as metadata.
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text        NOT NULL,
  content_type  text,
  category      text,
  uploaded_by   text,
  size_bytes    integer     NOT NULL,
  data          bytea       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                         text        NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash                 text        NOT NULL,
  full_name                     text        NOT NULL,
  role                          text        NOT NULL CHECK (role IN ('resident','staff','system-admin')),
  auth_provider                 text        NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','google')),
  is_active                     boolean     NOT NULL DEFAULT true,
  token_version                 integer     NOT NULL DEFAULT 0,
  failed_login_count            integer     NOT NULL DEFAULT 0,
  last_failed_login_at          timestamptz,
  locked_until                  timestamptz,
  staff_permissions             jsonb,                       -- legacy, no longer enforced
  resident_self_registered      boolean     NOT NULL DEFAULT false,
  contact_number                text,
  avatar_file_id                uuid        REFERENCES files(id) ON DELETE SET NULL,
  account_status                text        NOT NULL DEFAULT 'active'
                                CHECK (account_status IN ('pending','active','suspended','deactivated','rejected')),
  identity_verification_file_id uuid        REFERENCES files(id) ON DELETE SET NULL,
  resident_id                   text        UNIQUE,          -- "SB-00001"; NULL allowed (multiple)
  login_issued                  boolean     NOT NULL DEFAULT true,
  sms_opt_out                   boolean     NOT NULL DEFAULT false,
  must_change_password          boolean     NOT NULL DEFAULT false,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role           ON users (role);
CREATE INDEX idx_users_account_status ON users (account_status);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 1:1 with users (was the embedded `residentProfile` subdocument).
-- Absence of a row == `residentProfile` was undefined in Mongo.
CREATE TABLE resident_profiles (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  philsys_id         text NOT NULL DEFAULT '',
  inhabitant_type    text NOT NULL DEFAULT '' CHECK (inhabitant_type IN ('','Non-Migrant','Migrant','Transient')),
  last_name          text NOT NULL DEFAULT '',
  first_name         text NOT NULL DEFAULT '',
  middle_name        text NOT NULL DEFAULT '',
  suffix             text NOT NULL DEFAULT '',
  birth_place        text NOT NULL DEFAULT '',
  birth_date         date,
  sex                text NOT NULL DEFAULT '' CHECK (sex IN ('','Male','Female')),
  civil_status       text NOT NULL DEFAULT '' CHECK (civil_status IN
                       ('','Single','Married','Widowed','Divorced','Separated','Common Law/ Live-in','Unknown','Annulled')),
  citizenship        text NOT NULL DEFAULT '' CHECK (citizenship IN ('','Filipino','Dual Citizenship','Foreigner')),
  occupation         text NOT NULL DEFAULT '',
  highest_education  text NOT NULL DEFAULT '',
  mother_first_name  text NOT NULL DEFAULT '',
  mother_middle_name text NOT NULL DEFAULT '',
  mother_last_name   text NOT NULL DEFAULT '',
  purok              text NOT NULL DEFAULT '',
  address            text NOT NULL DEFAULT '',
  voter_status       text NOT NULL DEFAULT '' CHECK (voter_status IN ('','Registered','Not Registered')),
  remarks            text NOT NULL DEFAULT '',
  updated_by_email   text NOT NULL DEFAULT '',
  updated_at         timestamptz                      -- set explicitly by the app
);
CREATE INDEX idx_resident_profiles_purok ON resident_profiles (purok);

-- --------------------------------------------------------- appointments ----
CREATE TABLE appointment_slots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_code                text    NOT NULL UNIQUE,
  label                    text    NOT NULL,
  phase_label              text,
  is_morning_pickup_only   boolean NOT NULL DEFAULT false,
  default_capacity         integer NOT NULL DEFAULT 0,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointment_slots_active ON appointment_slots (is_active);

CREATE TABLE appointment_slot_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id        uuid    NOT NULL REFERENCES appointment_slots(id) ON DELETE CASCADE,
  override_date  date    NOT NULL,
  -- NULL when the row only records a manual closure (no capacity change).
  capacity_limit integer,
  -- server.js reads/writes `isClosed` on this record (staff "close slot" button), but the old
  -- Mongoose schema never declared it, so strict mode silently dropped it. Declared here so the
  -- feature really persists.
  is_closed      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slot_id, override_date)
);
CREATE TRIGGER trg_slot_overrides_updated BEFORE UPDATE ON appointment_slot_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE appointment_purposes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_code  text    NOT NULL,
  label         text    NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Same semantics as the Mongo partial unique index: unique among non-archived.
CREATE UNIQUE INDEX uq_appointment_purposes_code_active ON appointment_purposes (purpose_code) WHERE archived_at IS NULL;

CREATE TABLE appointments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no     text NOT NULL UNIQUE,                                   -- "APT-####"
  resident_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  purpose          text NOT NULL,
  notes            text,
  appointment_date date NOT NULL,
  slot_id          uuid REFERENCES appointment_slots(id) ON DELETE SET NULL,
  slot_label       text,
  status           text NOT NULL DEFAULT 'Pending Review' CHECK (status IN
                     ('Pending Review','Processing','Ready for Pickup','Confirmed','Completed','Cancelled','Rejected')),
  status_timeline  jsonb NOT NULL DEFAULT '[]'::jsonb,                     -- [{status, at, note}]
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_resident   ON appointments (resident_user_id);
CREATE INDEX idx_appointments_date_status ON appointments (appointment_date, status);
CREATE INDEX idx_appointments_slot_date  ON appointments (slot_id, appointment_date);

-- ------------------------------------------------------ service requests ----
CREATE TABLE service_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_no        text NOT NULL UNIQUE,                                -- "REQ-####"
  title               text NOT NULL,
  service_type        text NOT NULL,
  purpose             text,
  preferred_date      date NOT NULL,
  preferred_time_slot text NOT NULL,
  status              text NOT NULL DEFAULT 'Pending' CHECK (status IN
                        ('Pending','Processing','In Progress','Approved','Ready for Pickup',
                         'Completed','Revision Requested','Rejected','Cancelled')),
  status_timeline     jsonb NOT NULL DEFAULT '[]'::jsonb,
  resident_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_requests_resident ON service_requests (resident_user_id);
CREATE INDEX idx_service_requests_status   ON service_requests (status);
CREATE INDEX idx_service_requests_created  ON service_requests (created_at DESC);
CREATE TRIGGER trg_service_requests_updated BEFORE UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_catalog (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name       text NOT NULL,
  required_documents text NOT NULL DEFAULT '',
  processing_time    text NOT NULL DEFAULT '1-2 Days',
  status             text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Under Review','Inactive')),
  archived_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_service_catalog_archived ON service_catalog (archived_at);
CREATE TRIGGER trg_service_catalog_updated BEFORE UPDATE ON service_catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------- animals ----
CREATE TABLE animal_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_code       text NOT NULL UNIQUE,                                  -- "ANM-####"
  owner_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  owner_resident_id text NOT NULL DEFAULT '',
  owner_name        text NOT NULL,
  owner_contact     text NOT NULL DEFAULT '',
  owner_address     text NOT NULL DEFAULT '',
  name              text NOT NULL,
  species           text NOT NULL CHECK (species IN ('Dog','Cat','Other')),
  species_other     text NOT NULL DEFAULT '',
  breed             text NOT NULL DEFAULT '',
  color             text NOT NULL DEFAULT '',
  sex               text NOT NULL DEFAULT 'Unknown' CHECK (sex IN ('Male','Female','Unknown')),
  birth_date        date,
  archived_at       timestamptz,
  created_by_email  text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_animal_records_archived_created ON animal_records (archived_at, created_at DESC);
CREATE INDEX idx_animal_records_owner            ON animal_records (owner_user_id);
CREATE TRIGGER trg_animal_records_updated BEFORE UPDATE ON animal_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- $push -> INSERT, $pull -> DELETE ... WHERE id = $1 AND animal_id = $2
CREATE TABLE animal_vaccinations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  animal_id          uuid NOT NULL REFERENCES animal_records(id) ON DELETE CASCADE,
  vaccine            text NOT NULL,
  date_given         date NOT NULL,
  next_due_date      date,
  batch_no           text NOT NULL DEFAULT '',
  administered_by    text NOT NULL DEFAULT '',
  remarks            text NOT NULL DEFAULT '',
  recorded_by_email  text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_animal_vaccinations_animal ON animal_vaccinations (animal_id, date_given);

-- ------------------------------------------------------- announcements ----
CREATE TABLE community_announcements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category       text NOT NULL,
  title          text NOT NULL,
  body           text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  archived_at    timestamptz,
  posted_by_role text DEFAULT 'admin',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_community_announcements_created ON community_announcements (created_at DESC);

CREATE TABLE announcement_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text NOT NULL DEFAULT 'Community News',
  title           text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  send_sms        boolean NOT NULL DEFAULT true,
  sms_audience    text NOT NULL DEFAULT 'all' CHECK (sms_audience IN ('all','puroks')),
  sms_puroks      text[] NOT NULL DEFAULT '{}',
  created_by_role text DEFAULT 'admin',
  created_by_id   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_announcement_drafts_updated ON announcement_drafts (updated_at DESC);
CREATE TRIGGER trg_announcement_drafts_updated BEFORE UPDATE ON announcement_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------ faq ----
CREATE TABLE faq_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL CHECK (category IN ('service_request','document','general')),
  question    text NOT NULL,
  answer      text NOT NULL,
  keywords    text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_faq_entries_lookup   ON faq_entries (category, is_active, sort_order);
CREATE INDEX idx_faq_entries_keywords ON faq_entries USING gin (keywords);
CREATE TRIGGER trg_faq_entries_updated BEFORE UPDATE ON faq_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------- auth ----
CREATE TABLE password_reset_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  request_ip  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_codes_user    ON password_reset_codes (user_id);
CREATE INDEX idx_password_reset_codes_expires ON password_reset_codes (expires_at);

-- ---------------------------------------------------------------- audit ----
CREATE TABLE auth_audit_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action      text NOT NULL,   -- login | register | password_change | password_reset_requested | password_reset | account_approved | account_rejected
  email       text NOT NULL,
  role        text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_audit_created ON auth_audit_events (created_at DESC);

CREATE TABLE portal_audit_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action              text NOT NULL,
  description         text NOT NULL,
  performed_by_email  text,
  performed_by_name   text,
  performed_by_role   text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_audit_created ON portal_audit_events (created_at DESC);
CREATE INDEX idx_portal_audit_action  ON portal_audit_events (action);

-- ------------------------------------------------------------- settings ----
CREATE TABLE system_settings (
  id           text PRIMARY KEY DEFAULT 'system_settings_singleton' CHECK (id = 'system_settings_singleton'),
  environment  text NOT NULL DEFAULT 'production' CHECK (environment IN ('production','maintenance')),
  site_info    jsonb NOT NULL DEFAULT jsonb_build_object(
                 'barangayName',  'Burgos',
                 'municipality',  'San Marcelino',
                 'province',      'Zambales',
                 'contactNumber', '09489454674',
                 'officeHours',   'Mon-Fri 9AM - 5PM',
                 'address',       '353 National Highway, Barangay Burgos, Covered Court, San Marcelino, Zambales',
                 'signatoryName', 'HON. LILIBETH C. BALLON',
                 'signatoryTitle','Acting Punong Barangay'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_system_settings_updated BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------ sequences ----
-- resident_id: replaces generateResidentId()'s read-max-then-add-one, which can
--   hand two concurrent requests the same ID. ETL sets this past the current max.
--   Usage: 'SB-' || lpad(nextval('resident_id_seq')::text, 5, '0')
-- request/appointment refs: replace Math.random() 4-digit codes, which collide
--   (birthday problem: ~50% odds of a duplicate by ~120 records) and the current
--   code has no retry on the unique index. Start at 10000 to stay above all
--   existing 4-digit refs. OPTIONAL behaviour change (refs become 5+ digits).
CREATE SEQUENCE resident_id_seq;
CREATE SEQUENCE request_ref_seq     START 10000;
CREATE SEQUENCE appointment_ref_seq START 10000;

COMMIT;

-- Housekeeping for the Mongo TTL index (run on a Render Cron Job, e.g. hourly,
-- or opportunistically at the start of the forgot-password route):
--   DELETE FROM password_reset_codes WHERE expires_at < now();
