#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-shot data migration: MongoDB (Atlas) -> PostgreSQL (Render).
 *
 * Usage (run from the backend repo root):
 *   node scripts/migrate-mongo-to-postgres.js --dry-run --init-schema   # rehearsal, rolls back
 *   node scripts/migrate-mongo-to-postgres.js --truncate                # real import, wipes target first
 *
 * Env:  MONGODB_URI   source (read-only use; nothing is written to Mongo)
 *       DATABASE_URL  target — use Render's EXTERNAL Database URL when running from your laptop
 *
 * Flags:
 *   --dry-run      Do everything inside a transaction, print the report, then ROLLBACK.
 *   --truncate     Empty all target tables first (required if the target already has data).
 *   --init-schema  Apply every db/migrations/*.sql first (empty database only; otherwise use scripts/migrate-db.js).
 *                  NOTE: DDL is committed even with --dry-run.
 *
 * Properties:
 *   - Single transaction: it either fully imports or leaves the target untouched.
 *   - Deterministic IDs: Mongo ObjectId -> uuid ("00000000" + 24 hex). References never need a lookup
 *     map, and re-running after --truncate yields the same IDs.
 *   - Mongo enforced no foreign keys, so dangling references are nulled and reported, never crashed on.
 *   - Invalid enum values / bad dates are coerced or rejected and listed in the WARNINGS section.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// Mongoose pluralises model names to these collection names.
const SRC = {
  users: 'users',
  appointments: 'appointments',
  serviceRequests: 'servicerequests',
  animals: 'animalrecords',
  drafts: 'announcementdrafts',
  purposes: 'appointmentpurposecatalogs',
  slots: 'appointmentslots',
  overrides: 'appointmentslotoverrides',
  authAudit: 'authauditevents',
  announcements: 'communityannouncements',
  faq: 'faqentries',
  portalAudit: 'portalauditevents',
  catalog: 'servicecatalogs',
  settings: 'systemsettings',
  resetCodes: 'passwordresetcodes',
  gridFiles: 'uploads.files',
};

// ------------------------------------------------------------------ helpers
const warnings = [];
function warn(table, id, msg) {
  warnings.push({ table, id: id == null ? '?' : String(id), msg });
}

/** ObjectId (or 24-hex string) -> uuid string, or null. */
function toUuid(v) {
  if (v == null || v === '') return null;
  const hex = String(v).toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(hex)) return null;
  const h = '00000000' + hex;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Postgres text cannot contain NUL bytes.
const stripNul = (s) => s.replace(/\u0000/g, '');
const str = (v, d = '') => (v == null ? d : stripNul(String(v)));
const strOrNull = (v) => (v == null || v === '' ? null : stripNul(String(v)));
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : d);
const ts = (v) => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const json = (v) => stripNul(JSON.stringify(v)).replace(/\\u0000/g, '');

/** Date | 'YYYY-MM-DD...' -> 'YYYY-MM-DD' (real calendar date) or null. Mirrors the app's
 *  `new Date(x).toISOString().slice(0, 10)` convention for resident birth dates. */
function dateOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function oneOf(table, id, field, v, allowed, fallback) {
  if (allowed.includes(v)) return v;
  warn(table, id, `${field}=${JSON.stringify(v)} is not allowed; using ${JSON.stringify(fallback)}`);
  return fallback;
}

function timeline(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e) => e && e.status)
    .map((e) => ({ status: str(e.status), at: ts(e.at)?.toISOString() ?? null, note: strOrNull(e.note) }));
}

// ----------------------------------------------------------------- mappers
// Each mapper returns a row object (keys = column names), an array of rows, or null to skip.
// `ctx` carries the sets of IDs already imported so foreign keys can be validated.

const ROLES = ['resident', 'staff', 'system-admin'];
const ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'deactivated', 'rejected'];
const APPOINTMENT_STATUSES = ['Pending Review', 'Processing', 'Ready for Pickup', 'Confirmed', 'Completed', 'Cancelled', 'Rejected'];
const REQUEST_STATUSES = ['Pending', 'Processing', 'In Progress', 'Approved', 'Ready for Pickup', 'Completed', 'Revision Requested', 'Rejected', 'Cancelled'];
const CATALOG_STATUSES = ['Active', 'Under Review', 'Inactive'];
const FAQ_CATEGORIES = ['service_request', 'document', 'general'];
const SITE_INFO_DEFAULTS = {
  barangayName: 'Burgos',
  municipality: 'San Marcelino',
  province: 'Zambales',
  contactNumber: '09489454674',
  officeHours: 'Mon-Fri 9AM - 5PM',
  address: '353 National Highway, Barangay Burgos, Covered Court, San Marcelino, Zambales',
  signatoryName: 'HON. LILIBETH C. BALLON',
  signatoryTitle: 'Acting Punong Barangay',
};

function fkOrNull(table, id, field, rawRef, knownSet) {
  const u = toUuid(rawRef);
  if (!u) return null;
  if (!knownSet.has(u)) {
    warn(table, id, `${field} -> ${rawRef} does not exist; set to NULL`);
    return null;
  }
  return u;
}

const TABLES = [
  {
    table: 'users',
    src: SRC.users,
    cols: ['id', 'email', 'password_hash', 'full_name', 'role', 'auth_provider', 'is_active', 'token_version',
      'failed_login_count', 'last_failed_login_at', 'locked_until', 'staff_permissions',
      'resident_self_registered', 'contact_number', 'avatar_file_id', 'account_status',
      'identity_verification_file_id', 'resident_id', 'login_issued', 'sms_opt_out', 'must_change_password',
      'created_at', 'updated_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      const email = str(d.email).trim().toLowerCase();
      if (!id || !email || !d.passwordHash || !d.fullName || !ROLES.includes(d.role)) {
        warn('users', d._id, 'REJECTED: missing id/email/passwordHash/fullName or invalid role');
        return null;
      }
      ctx.userIds.add(id);
      const created = ts(d.createdAt) || new Date();
      return {
        id,
        email,
        password_hash: str(d.passwordHash),
        full_name: str(d.fullName),
        role: d.role,
        auth_provider: oneOf('users', d._id, 'authProvider', d.authProvider ?? 'local', ['local', 'google'], 'local'),
        is_active: bool(d.isActive, true),
        token_version: int(d.tokenVersion, 0),
        failed_login_count: int(d.failedLoginCount, 0),
        last_failed_login_at: ts(d.lastFailedLoginAt),
        locked_until: ts(d.lockedUntil),
        staff_permissions: d.staffPermissions && typeof d.staffPermissions === 'object' ? json(d.staffPermissions) : null,
        resident_self_registered: bool(d.residentSelfRegistered, false),
        contact_number: strOrNull(d.contactNumber),
        avatar_file_id: fkOrNull('users', d._id, 'avatarFileId', d.avatarFileId, ctx.fileIds),
        account_status: oneOf('users', d._id, 'accountStatus', d.accountStatus ?? 'active', ACCOUNT_STATUSES, 'active'),
        identity_verification_file_id: fkOrNull('users', d._id, 'identityVerificationFileId', d.identityVerificationFileId, ctx.fileIds),
        resident_id: strOrNull(str(d.residentId).trim()),
        login_issued: bool(d.loginIssued, true),
        sms_opt_out: bool(d.smsOptOut, false),
        must_change_password: bool(d.mustChangePassword, false),
        created_at: created,
        updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'resident_profiles',
    src: SRC.users,
    cols: ['user_id', 'philsys_id', 'inhabitant_type', 'last_name', 'first_name', 'middle_name', 'suffix',
      'birth_place', 'birth_date', 'sex', 'civil_status', 'citizenship', 'occupation', 'highest_education',
      'mother_first_name', 'mother_middle_name', 'mother_last_name', 'purok', 'address', 'voter_status',
      'remarks', 'updated_by_email', 'updated_at'],
    map(d, ctx) {
      const p = d.residentProfile;
      const userId = toUuid(d._id);
      if (!p || typeof p !== 'object' || !userId || !ctx.userIds.has(userId)) return null;
      const t = 'resident_profiles';
      let birth = null;
      if (p.birthDate != null && p.birthDate !== '') {
        birth = dateOnly(p.birthDate);
        if (!birth) warn(t, d._id, `birthDate=${JSON.stringify(p.birthDate)} is not a valid date; set to NULL`);
      }
      return {
        user_id: userId,
        philsys_id: str(p.philsysId),
        inhabitant_type: oneOf(t, d._id, 'inhabitantType', p.inhabitantType ?? '', ['', 'Non-Migrant', 'Migrant', 'Transient'], ''),
        last_name: str(p.lastName),
        first_name: str(p.firstName),
        middle_name: str(p.middleName),
        suffix: str(p.suffix),
        birth_place: str(p.birthPlace),
        birth_date: birth,
        sex: oneOf(t, d._id, 'sex', p.sex ?? '', ['', 'Male', 'Female'], ''),
        civil_status: oneOf(t, d._id, 'civilStatus', p.civilStatus ?? '',
          ['', 'Single', 'Married', 'Widowed', 'Divorced', 'Separated', 'Common Law/ Live-in', 'Unknown', 'Annulled'], ''),
        citizenship: oneOf(t, d._id, 'citizenship', p.citizenship ?? '', ['', 'Filipino', 'Dual Citizenship', 'Foreigner'], ''),
        occupation: str(p.occupation),
        highest_education: str(p.highestEducation),
        mother_first_name: str(p.motherFirstName),
        mother_middle_name: str(p.motherMiddleName),
        mother_last_name: str(p.motherLastName),
        purok: str(p.purok),
        address: str(p.address),
        voter_status: oneOf(t, d._id, 'voterStatus', p.voterStatus ?? '', ['', 'Registered', 'Not Registered'], ''),
        remarks: str(p.remarks),
        updated_by_email: str(p.updatedByEmail),
        updated_at: ts(p.updatedAt),
      };
    },
  },
  {
    table: 'appointment_slots',
    src: SRC.slots,
    cols: ['id', 'slot_code', 'label', 'phase_label', 'is_morning_pickup_only', 'default_capacity', 'is_active', 'created_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      if (!id || !d.slotCode || !d.label) { warn('appointment_slots', d._id, 'REJECTED: missing slotCode/label'); return null; }
      ctx.slotIds.add(id);
      return {
        id, slot_code: str(d.slotCode), label: str(d.label), phase_label: strOrNull(d.phaseLabel),
        is_morning_pickup_only: bool(d.isMorningPickupOnly, false), default_capacity: int(d.defaultCapacity, 0),
        is_active: bool(d.isActive, true), created_at: ts(d.createdAt) || new Date(),
      };
    },
  },
  {
    table: 'appointment_slot_overrides',
    src: SRC.overrides,
    cols: ['id', 'slot_id', 'override_date', 'capacity_limit', 'is_closed', 'created_at', 'updated_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      const slotId = toUuid(d.slotId);
      const date = dateOnly(d.overrideDate);
      if (!id || !slotId || !ctx.slotIds.has(slotId) || !date) {
        warn('appointment_slot_overrides', d._id, 'REJECTED: missing/unknown slotId or invalid overrideDate'); return null;
      }
      const created = ts(d.createdAt) || new Date();
      return { id, slot_id: slotId, override_date: date, capacity_limit: int(d.capacityLimit, 0), is_closed: d.isClosed === true, created_at: created, updated_at: ts(d.updatedAt) || created };
    },
  },
  {
    table: 'appointment_purposes',
    src: SRC.purposes,
    cols: ['id', 'purpose_code', 'label', 'sort_order', 'archived_at', 'created_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.purposeCode || !d.label) { warn('appointment_purposes', d._id, 'REJECTED: missing purposeCode/label'); return null; }
      return { id, purpose_code: str(d.purposeCode), label: str(d.label), sort_order: int(d.sortOrder, 0), archived_at: ts(d.archivedAt), created_at: ts(d.createdAt) || new Date() };
    },
  },
  {
    table: 'service_catalog',
    src: SRC.catalog,
    cols: ['id', 'service_name', 'required_documents', 'processing_time', 'status', 'archived_at', 'created_at', 'updated_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.serviceName) { warn('service_catalog', d._id, 'REJECTED: missing serviceName'); return null; }
      const created = ts(d.createdAt) || new Date();
      return {
        id, service_name: str(d.serviceName), required_documents: str(d.requiredDocuments),
        processing_time: str(d.processingTime, '1-2 Days'),
        status: oneOf('service_catalog', d._id, 'status', d.status ?? 'Active', CATALOG_STATUSES, 'Active'),
        archived_at: ts(d.archivedAt), created_at: created, updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'appointments',
    src: SRC.appointments,
    cols: ['id', 'reference_no', 'resident_user_id', 'purpose', 'notes', 'appointment_date', 'slot_id', 'slot_label', 'status', 'status_timeline', 'created_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      const date = dateOnly(d.appointmentDate);
      if (!id || !d.referenceNo || !d.purpose || !date) {
        warn('appointments', d._id, `REJECTED: missing referenceNo/purpose or invalid appointmentDate (${JSON.stringify(d.appointmentDate)})`); return null;
      }
      return {
        id, reference_no: str(d.referenceNo),
        resident_user_id: fkOrNull('appointments', d._id, 'residentUserId', d.residentUserId, ctx.userIds),
        purpose: str(d.purpose), notes: strOrNull(d.notes), appointment_date: date,
        slot_id: fkOrNull('appointments', d._id, 'slotId', d.slotId, ctx.slotIds),
        slot_label: strOrNull(d.slotLabel),
        status: oneOf('appointments', d._id, 'status', d.status ?? 'Pending Review', APPOINTMENT_STATUSES, 'Pending Review'),
        status_timeline: json(timeline(d.statusTimeline)),
        created_at: ts(d.createdAt) || new Date(),
      };
    },
  },
  {
    table: 'service_requests',
    src: SRC.serviceRequests,
    cols: ['id', 'reference_no', 'title', 'service_type', 'purpose', 'preferred_date', 'preferred_time_slot', 'status', 'status_timeline', 'resident_user_id', 'created_at', 'updated_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      const date = dateOnly(d.preferredDate);
      if (!id || !d.referenceNo || !d.title || !d.serviceType || !d.preferredTimeSlot || !date) {
        warn('service_requests', d._id, `REJECTED: missing required field or invalid preferredDate (${JSON.stringify(d.preferredDate)})`); return null;
      }
      const created = ts(d.createdAt) || new Date();
      return {
        id, reference_no: str(d.referenceNo), title: str(d.title), service_type: str(d.serviceType),
        purpose: strOrNull(d.purpose), preferred_date: date, preferred_time_slot: str(d.preferredTimeSlot),
        status: oneOf('service_requests', d._id, 'status', d.status ?? 'Pending', REQUEST_STATUSES, 'Pending'),
        status_timeline: json(timeline(d.statusTimeline)),
        resident_user_id: fkOrNull('service_requests', d._id, 'residentUserId', d.residentUserId, ctx.userIds),
        created_at: created, updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'animal_records',
    src: SRC.animals,
    cols: ['id', 'animal_code', 'owner_user_id', 'owner_resident_id', 'owner_name', 'owner_contact', 'owner_address', 'name',
      'species', 'species_other', 'breed', 'color', 'sex', 'birth_date', 'archived_at', 'created_by_email', 'created_at', 'updated_at'],
    map(d, ctx) {
      const id = toUuid(d._id);
      if (!id || !d.animalCode || !d.ownerName || !d.name) { warn('animal_records', d._id, 'REJECTED: missing animalCode/ownerName/name'); return null; }
      ctx.animalIds.add(id);
      const created = ts(d.createdAt) || new Date();
      return {
        id, animal_code: str(d.animalCode),
        owner_user_id: fkOrNull('animal_records', d._id, 'ownerUserId', d.ownerUserId, ctx.userIds),
        owner_resident_id: str(d.ownerResidentId), owner_name: str(d.ownerName), owner_contact: str(d.ownerContact),
        owner_address: str(d.ownerAddress), name: str(d.name),
        species: oneOf('animal_records', d._id, 'species', d.species, ['Dog', 'Cat', 'Other'], 'Other'),
        species_other: str(d.speciesOther), breed: str(d.breed), color: str(d.color),
        sex: oneOf('animal_records', d._id, 'sex', d.sex ?? 'Unknown', ['Male', 'Female', 'Unknown'], 'Unknown'),
        birth_date: dateOnly(d.birthDate), archived_at: ts(d.archivedAt), created_by_email: str(d.createdByEmail),
        created_at: created, updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'animal_vaccinations',
    src: SRC.animals,
    cols: ['id', 'animal_id', 'vaccine', 'date_given', 'next_due_date', 'batch_no', 'administered_by', 'remarks', 'recorded_by_email', 'created_at'],
    map(d, ctx) {
      const animalId = toUuid(d._id);
      if (!animalId || !ctx.animalIds.has(animalId) || !Array.isArray(d.vaccinations)) return null;
      return d.vaccinations.map((v) => {
        const given = dateOnly(v?.dateGiven);
        if (!v || !v.vaccine || !given) { warn('animal_vaccinations', d._id, 'REJECTED: vaccination missing vaccine or valid dateGiven'); return null; }
        return {
          id: toUuid(v._id) || crypto.randomUUID(), animal_id: animalId, vaccine: str(v.vaccine), date_given: given,
          next_due_date: dateOnly(v.nextDueDate), batch_no: str(v.batchNo), administered_by: str(v.administeredBy),
          remarks: str(v.remarks), recorded_by_email: str(v.recordedByEmail), created_at: ts(v.createdAt) || ts(d.createdAt) || new Date(),
        };
      });
    },
  },
  {
    table: 'community_announcements',
    src: SRC.announcements,
    cols: ['id', 'category', 'title', 'body', 'is_active', 'archived_at', 'posted_by_role', 'created_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.category || !d.title || !d.body) { warn('community_announcements', d._id, 'REJECTED: missing category/title/body'); return null; }
      return { id, category: str(d.category), title: str(d.title), body: str(d.body), is_active: bool(d.isActive, true), archived_at: ts(d.archivedAt), posted_by_role: str(d.postedByRole, 'admin'), created_at: ts(d.createdAt) || new Date() };
    },
  },
  {
    table: 'announcement_drafts',
    src: SRC.drafts,
    cols: ['id', 'category', 'title', 'body', 'send_sms', 'sms_audience', 'sms_puroks', 'created_by_role', 'created_by_id', 'created_at', 'updated_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id) return null;
      const created = ts(d.createdAt) || new Date();
      return {
        id, category: str(d.category, 'Community News'), title: str(d.title), body: str(d.body), send_sms: bool(d.sendSms, true),
        sms_audience: oneOf('announcement_drafts', d._id, 'smsAudience', d.smsAudience ?? 'all', ['all', 'puroks'], 'all'),
        sms_puroks: Array.isArray(d.smsPuroks) ? d.smsPuroks.map((x) => str(x)) : [],
        created_by_role: str(d.createdByRole, 'admin'), created_by_id: strOrNull(d.createdById),
        created_at: created, updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'faq_entries',
    src: SRC.faq,
    cols: ['id', 'category', 'question', 'answer', 'keywords', 'is_active', 'sort_order', 'created_at', 'updated_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.question || !d.answer || !FAQ_CATEGORIES.includes(d.category)) { warn('faq_entries', d._id, 'REJECTED: missing question/answer or invalid category'); return null; }
      const created = ts(d.createdAt) || new Date();
      return {
        id, category: d.category, question: str(d.question), answer: str(d.answer),
        keywords: Array.isArray(d.keywords) ? d.keywords.map((x) => str(x)) : [],
        is_active: bool(d.isActive, true), sort_order: int(d.sortOrder, 0), created_at: created, updated_at: ts(d.updatedAt) || created,
      };
    },
  },
  {
    table: 'auth_audit_events',
    src: SRC.authAudit,
    cols: ['id', 'action', 'email', 'role', 'ip', 'created_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.action || !d.email) { warn('auth_audit_events', d._id, 'REJECTED: missing action/email'); return null; }
      return { id, action: str(d.action), email: str(d.email), role: strOrNull(d.role), ip: strOrNull(d.ip), created_at: ts(d.createdAt) || new Date() };
    },
  },
  {
    table: 'portal_audit_events',
    src: SRC.portalAudit,
    cols: ['id', 'action', 'description', 'performed_by_email', 'performed_by_name', 'performed_by_role', 'metadata', 'created_at'],
    map(d) {
      const id = toUuid(d._id);
      if (!id || !d.action || d.description == null) { warn('portal_audit_events', d._id, 'REJECTED: missing action/description'); return null; }
      return {
        id, action: str(d.action), description: str(d.description), performed_by_email: strOrNull(d.performedByEmail),
        performed_by_name: strOrNull(d.performedByName), performed_by_role: strOrNull(d.performedByRole),
        metadata: json(d.metadata && typeof d.metadata === 'object' ? d.metadata : {}), created_at: ts(d.createdAt) || new Date(),
      };
    },
  },
  {
    table: 'system_settings',
    src: SRC.settings,
    cols: ['id', 'environment', 'site_info', 'updated_at'],
    map(d) {
      return {
        id: 'system_settings_singleton',
        environment: oneOf('system_settings', d._id, 'environment', d.environment ?? 'production', ['production', 'maintenance'], 'production'),
        site_info: json({ ...SITE_INFO_DEFAULTS, ...(d.siteInfo || {}) }),
        updated_at: ts(d.updatedAt) || new Date(),
      };
    },
  },
];

// Tables in truncate order (children first is unnecessary with CASCADE, but be explicit).
const ALL_TABLES = ['files', ...TABLES.map((t) => t.table), 'password_reset_codes'];

// ------------------------------------------------------------- DB plumbing
async function bulkInsert(client, table, cols, rows, batch = 200) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const values = [];
    const tuples = slice.map((row, r) => {
      const ph = cols.map((c, k) => {
        values.push(row[c]);
        return `$${r * cols.length + k + 1}`;
      });
      return `(${ph.join(',')})`;
    });
    // ON CONFLICT DO NOTHING (no target) also swallows duplicate-unique rows; the report below
    // compares "mapped" vs "inserted" so any silently dropped duplicate is surfaced.
    const res = await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
      values,
    );
    inserted += res.rowCount;
  }
  return inserted;
}

function downloadToBuffer(bucket, objectId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    bucket.openDownloadStream(objectId)
      .on('data', (c) => chunks.push(c))
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function migrateFiles({ db, client, bucket, ctx }) {
  const FILE_COLS = ['id', 'filename', 'content_type', 'category', 'uploaded_by', 'size_bytes', 'data', 'created_at'];
  const docs = await db.collection(SRC.gridFiles).find({}).toArray();
  const stat = { table: 'files', source: docs.length, mapped: 0, inserted: 0 };
  let pending = [];
  const flush = async () => {
    if (pending.length) { stat.inserted += await bulkInsert(client, 'files', FILE_COLS, pending, 5); pending = []; }
  };
  for (const d of docs) {
    const id = toUuid(d._id);
    if (!id) { warn('files', d._id, 'REJECTED: unusable _id'); continue; }
    let buf;
    try {
      buf = await downloadToBuffer(bucket, d._id);
    } catch (e) {
      warn('files', d._id, `REJECTED: could not read GridFS chunks (${e.message})`);
      continue;
    }
    ctx.fileIds.add(id);
    stat.mapped += 1;
    pending.push({
      id, filename: str(d.filename, 'file'), content_type: strOrNull(d.contentType ?? d.metadata?.contentType),
      category: strOrNull(d.metadata?.category), uploaded_by: strOrNull(d.metadata?.uploadedBy),
      size_bytes: buf.length, data: buf, created_at: ts(d.uploadDate) || new Date(),
    });
    if (pending.length >= 5) await flush();
  }
  await flush();
  return stat;
}

// -------------------------------------------------------------------- main
async function run({ db, pool, opts, bucketFactory }) {
  const ctx = { fileIds: new Set(), userIds: new Set(), slotIds: new Set(), animalIds: new Set() };
  const stats = [];
  const cache = new Map();
  const readAll = async (name) => {
    if (!cache.has(name)) cache.set(name, await db.collection(name).find({}).toArray());
    return cache.get(name);
  };

  // Sanity: warn if a collection we expect isn't there (e.g. non-default collection naming).
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [key, name] of Object.entries(SRC)) {
    if (!existing.has(name) && key !== 'resetCodes') warn('(source)', name, 'collection not found in MongoDB — 0 rows will be imported from it');
  }

  const client = await pool.connect();
  try {
    if (opts.initSchema) {
      // Every migration file, in order (001_schema.sql, 002_sms_log.sql, ...). Use this on an EMPTY database;
      // if the schema already exists, run `node scripts/migrate-db.js` instead.
      console.log('Applying schema…');
      for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      }
    }

    await client.query('BEGIN');

    // Refuse to import into a non-empty target unless told to wipe it.
    const nonEmpty = [];
    for (const t of ALL_TABLES) { // sequential: a single pg client cannot run queries in parallel
      if (Number((await client.query(`SELECT count(*) FROM ${t}`)).rows[0].count) > 0) nonEmpty.push(t);
    }
    if (nonEmpty.length && !opts.truncate) {
      throw new Error(`Target is not empty (${nonEmpty.join(', ')}). Re-run with --truncate to wipe it first.\n` +
        'Tip: run this import BEFORE seed scripts so defaults are not duplicated.');
    }
    if (opts.truncate) {
      await client.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      await client.query('ALTER SEQUENCE resident_id_seq RESTART');
      console.log('Target tables truncated.');
    }

    // 1) files (GridFS) — must precede users (FK).
    console.log('Importing files from GridFS…');
    stats.push(await migrateFiles({ db, client, bucket: bucketFactory(db), ctx }));

    // 2) relational tables in dependency order.
    for (const t of TABLES) {
      const docs = await readAll(t.src);
      const rows = [];
      for (const d of docs) {
        for (const r of [].concat(t.map(d, ctx))) if (r) rows.push(r);
      }
      const inserted = rows.length ? await bulkInsert(client, t.table, t.cols, rows) : 0;
      stats.push({ table: t.table, source: t.table === 'animal_vaccinations'
        ? docs.reduce((n, d) => n + (Array.isArray(d.vaccinations) ? d.vaccinations.length : 0), 0)
        : t.table === 'resident_profiles' ? docs.filter((d) => d.residentProfile).length : docs.length,
        mapped: rows.length, inserted });
      console.log(`  ${t.table}: ${inserted}/${rows.length}`);
    }

    // 3) password reset codes are short-lived (TTL) — intentionally not migrated.
    const resetN = existing.has(SRC.resetCodes) ? await db.collection(SRC.resetCodes).countDocuments({}) : 0;
    if (resetN) console.log(`  (skipped ${resetN} password reset codes — users simply request a new one)`);

    // 4) Move the resident-ID sequence past the highest imported SB-##### so nextval() never collides.
    const maxSb = (await client.query(
      "SELECT COALESCE(max(substring(resident_id from 4)::int), 0) AS m FROM users WHERE resident_id ~ '^SB-[0-9]{5}$'")).rows[0].m;
    if (maxSb > 0) await client.query('SELECT setval(\'resident_id_seq\', $1, true)', [maxSb]);

    // 5) Verification, still inside the transaction.
    for (const s of stats) s.pg = Number((await client.query(`SELECT count(*) FROM ${s.table}`)).rows[0].count);
    const roleMongo = {};
    for (const u of await readAll(SRC.users)) roleMongo[u.role] = (roleMongo[u.role] || 0) + 1;
    const rolePg = Object.fromEntries((await client.query('SELECT role, count(*)::int AS n FROM users GROUP BY role')).rows.map((r) => [r.role, r.n]));

    printReport({ stats, roleMongo, rolePg, maxSb, dryRun: opts.dryRun });

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN: transaction rolled back. Nothing was written.');
    } else {
      await client.query('COMMIT');
      console.log('\nCOMMITTED. Migration complete.');
    }
    return { stats, warnings };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function printReport({ stats, roleMongo, rolePg, maxSb }) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n=== REPORT ===');
  console.log(pad('table', 28) + pad('mongo', 8) + pad('mapped', 8) + pad('inserted', 10) + pad('pg', 8) + 'status');
  for (const s of stats) {
    const ok = s.source === s.mapped && s.mapped === s.inserted && s.inserted === s.pg;
    console.log(pad(s.table, 28) + pad(s.source, 8) + pad(s.mapped, 8) + pad(s.inserted, 10) + pad(s.pg, 8) + (ok ? 'OK' : 'CHECK (see warnings)'));
  }
  console.log('\nUsers by role  mongo:', JSON.stringify(roleMongo), ' pg:', JSON.stringify(rolePg));
  if (maxSb) console.log(`resident_id_seq advanced to ${maxSb} (next resident = SB-${String(maxSb + 1).padStart(5, '0')})`);

  if (warnings.length) {
    console.log(`\n=== WARNINGS (${warnings.length}) ===`);
    for (const w of warnings.slice(0, 100)) console.log(`  [${w.table}] ${w.id}: ${w.msg}`);
    if (warnings.length > 100) console.log(`  … and ${warnings.length - 100} more`);
  } else {
    console.log('\nNo warnings.');
  }
  if (stats.some((s) => s.mapped !== s.inserted)) process.exitCode = 2; // rows dropped by a unique conflict
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const opts = { dryRun: args.has('--dry-run'), truncate: args.has('--truncate'), initSchema: args.has('--init-schema') };

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const { MongoClient, GridFSBucket } = require('mongodb');
  const { pool } = require('../src/config/pgClient');
  const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  try {
    console.log(`Mode: ${opts.dryRun ? 'DRY RUN' : 'REAL IMPORT'}${opts.truncate ? ' + truncate' : ''}${opts.initSchema ? ' + init-schema' : ''}`);
    await run({ db: mongo.db(), pool, opts, bucketFactory: (db) => new GridFSBucket(db, { bucketName: 'uploads' }) });
  } finally {
    await mongo.close();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nMIGRATION FAILED (nothing was committed):', err.message || err);
    process.exit(1);
  });
}

module.exports = { run, toUuid, dateOnly, TABLES };