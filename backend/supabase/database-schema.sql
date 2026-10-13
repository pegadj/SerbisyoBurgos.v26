-- SerbisyoBurgos unified schema
-- Supports both resident and admin portals in one database.
-- Target: PostgreSQL

-- =========================
-- Core user/auth tables
-- =========================

CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT,
    role VARCHAR(20) NOT NULL CHECK (role IN ('resident', 'admin', 'staff', 'system-admin')),
    auth_provider VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local', 'google')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resident_profiles (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    contact_number VARCHAR(30),
    address_line TEXT,
    barangay VARCHAR(120),
    city VARCHAR(120),
    province VARCHAR(120),
    postal_code VARCHAR(20),
    is_identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE admin_profiles (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    position_title VARCHAR(120),
    office_phone VARCHAR(30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL UNIQUE,
    ip_address VARCHAR(64),
    user_agent TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ
);

-- =========================
-- Service request workflow
-- =========================

CREATE TABLE service_requests (
    id BIGSERIAL PRIMARY KEY,
    reference_no VARCHAR(30) NOT NULL UNIQUE, -- ex: SB-1234 / REQ-1234
    resident_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    service_type VARCHAR(80) NOT NULL,        -- Barangay Clearance, Permit Application, etc.
    title VARCHAR(150),                        -- Optional title when used by UI
    purpose TEXT,
    description TEXT,
    preferred_date DATE,
    preferred_time_slot VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Processing', 'In Progress', 'Approved', 'Ready for Pickup', 'Completed', 'Revision Requested', 'Rejected')),
    assigned_admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_requests_resident_user_id ON service_requests(resident_user_id);
CREATE INDEX idx_service_requests_status ON service_requests(status);
CREATE INDEX idx_service_requests_submitted_at ON service_requests(submitted_at DESC);

CREATE TABLE request_status_history (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL
        CHECK (status IN ('Pending', 'Processing', 'In Progress', 'Approved', 'Ready for Pickup', 'Completed', 'Revision Requested', 'Rejected')),
    note TEXT,
    changed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_request_status_history_request_id ON request_status_history(request_id);

CREATE TABLE request_attachments (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
    uploaded_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    mime_type VARCHAR(120),
    file_size_bytes BIGINT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================
-- Appointment workflow
-- =========================

CREATE TABLE appointment_slots (
    id BIGSERIAL PRIMARY KEY,
    slot_code VARCHAR(10) NOT NULL UNIQUE,      -- ex: 0900, 1000, 0100
    label VARCHAR(80) NOT NULL,                 -- ex: 09:00 AM - 10:00 AM
    phase_label VARCHAR(80),                    -- ex: Phase 1 Pickup
    is_morning_pickup_only BOOLEAN NOT NULL DEFAULT FALSE,
    default_capacity INT NOT NULL CHECK (default_capacity > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE appointments (
    id BIGSERIAL PRIMARY KEY,
    reference_no VARCHAR(30) NOT NULL UNIQUE,   -- ex: APT-7721
    resident_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    purpose VARCHAR(120) NOT NULL,              -- pickup, consultation, etc.
    appointment_date DATE NOT NULL,
    slot_id BIGINT REFERENCES appointment_slots(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'Pending Review'
        CHECK (status IN ('Pending Review', 'Confirmed', 'Completed', 'Cancelled', 'Rejected')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointments_resident_user_id ON appointments(resident_user_id);
CREATE INDEX idx_appointments_date_status ON appointments(appointment_date, status);

CREATE TABLE appointment_slot_overrides (
    id BIGSERIAL PRIMARY KEY,
    slot_id BIGINT NOT NULL REFERENCES appointment_slots(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    capacity_limit INT NOT NULL CHECK (capacity_limit > 0),
    set_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(slot_id, override_date)
);

-- =========================
-- Documents and bulletin
-- =========================

CREATE TABLE generated_documents (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT REFERENCES service_requests(id) ON DELETE SET NULL,
    resident_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    generated_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL, -- admin/staff
    document_type VARCHAR(80) NOT NULL,         -- Barangay Clearance, Indigency, Residency
    purpose TEXT,
    issue_date DATE NOT NULL,
    file_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bulletin_announcements (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(180) NOT NULL,
    body TEXT NOT NULL,
    posted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(40) NOT NULL CHECK (type IN ('announcement', 'request_status', 'appointment', 'system')),
    title VARCHAR(180) NOT NULL,
    message TEXT NOT NULL,
    related_request_id BIGINT REFERENCES service_requests(id) ON DELETE SET NULL,
    related_appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
    related_announcement_id BIGINT REFERENCES bulletin_announcements(id) ON DELETE SET NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
);

CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);

-- =========================
-- Practical seed slot setup
-- =========================

INSERT INTO appointment_slots (slot_code, label, phase_label, is_morning_pickup_only, default_capacity)
VALUES
('0900', '09:00 AM - 10:00 AM', 'Phase 1 Pickup', TRUE, 10),
('1000', '10:00 AM - 11:00 AM', 'Phase 2 Pickup', TRUE, 10),
('1100', '11:00 AM - 12:00 PM', 'Phase 3 Pickup', TRUE, 10),
('0100', '01:00 PM - 02:00 PM', 'Phase 4', FALSE, 15),
('0300', '03:00 PM - 04:00 PM', 'Phase 5', FALSE, 15),
('0400', '04:00 PM - 05:00 PM', 'Phase 6', FALSE, 15)
ON CONFLICT (slot_code) DO NOTHING;
