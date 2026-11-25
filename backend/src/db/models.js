'use strict';
// Table/column definitions for the query layer (src/db/engine.js).
// Column names are the camelCase field names snake_cased (see db/migrations/001_schema.sql);
// only the options below deviate from the plain mapping.
const { defineModel } = require('./engine');

// text column that is NOT NULL DEFAULT '' (Mongoose allowed null writes; coerce them to '')
const S = { t: 'text', nullAs: '' };
// NOT NULL DEFAULT '' text with the old schema's `trim: true, maxlength: N`
const L = (max) => ({ t: 'text', nullAs: '', trim: true, max });
// required text with trim + maxlength
const R = (max) => ({ t: 'text', trim: true, max });

// timestamps stored as ISO strings inside jsonb -> Dates again, as Mongoose returned them
const timeline = {
  t: 'jsonb',
  out: (arr) => (Array.isArray(arr) ? arr.map((e) => ({ status: e.status, at: e.at ? new Date(e.at) : null, note: e.note ?? null })) : []),
};
// 'YYYY-MM-DD' column that callers treat as a Date (new Date(x).toISOString())
const dateObj = { t: 'date', out: (v) => (typeof v === 'string' ? new Date(`${v}T00:00:00Z`) : v) };

const User = defineModel({
  name: 'User',
  table: 'users',
  fields: {
    email: { t: 'text', lower: true, trim: true },
    passwordHash: { t: 'text', hidden: true },
    fullName: { t: 'text', trim: true },
    role: 'text',
    authProvider: 'text',
    isActive: 'bool',
    tokenVersion: 'int',
    failedLoginCount: 'int',
    lastFailedLoginAt: 'ts',
    lockedUntil: 'ts',
    staffPermissions: 'jsonb',
    residentSelfRegistered: 'bool',
    contactNumber: { t: 'text', trim: true },
    avatarFileId: 'uuid',
    accountStatus: 'text',
    identityVerificationFileId: 'uuid',
    residentId: { t: 'text', trim: true, emptyAsNull: true },
    loginIssued: 'bool',
    smsOptOut: 'bool',
    mustChangePassword: 'bool',
    createdAt: 'ts',
    updatedAt: 'ts',
  },
  embedded: {
    residentProfile: {
      table: 'resident_profiles',
      fk: 'user_id',
      alias: 'rp',
      fields: {
        philsysId: L(30), inhabitantType: S, lastName: L(60), firstName: L(60), middleName: L(60), suffix: L(20), birthPlace: L(120),
        birthDate: dateObj, sex: S, civilStatus: S, citizenship: S, occupation: L(120), highestEducation: L(80),
        motherFirstName: L(60), motherMiddleName: L(60), motherLastName: L(60), purok: L(80), address: L(250), voterStatus: S,
        remarks: L(500), householdNo: L(40), isHouseholdHead: 'bool', updatedByEmail: S, updatedAt: 'ts',
      },
    },
  },
});

const Appointment = defineModel({
  name: 'Appointment',
  table: 'appointments',
  fields: {
    referenceNo: 'text', residentUserId: 'uuid', purpose: 'text', notes: 'text', appointmentDate: 'date',
    slotId: 'uuid', slotLabel: 'text', status: 'text', statusTimeline: timeline, createdAt: 'ts',
  },
});

const ServiceRequest = defineModel({
  name: 'ServiceRequest',
  table: 'service_requests',
  fields: {
    referenceNo: 'text', title: 'text', serviceType: 'text', purpose: 'text', preferredDate: 'date',
    preferredTimeSlot: 'text', status: 'text', statusTimeline: timeline, residentUserId: 'uuid',
    createdAt: 'ts', updatedAt: 'ts',
  },
});

const ServiceCatalog = defineModel({
  name: 'ServiceCatalog',
  table: 'service_catalog',
  fields: {
    serviceName: 'text', requiredDocuments: S, processingTime: 'text', status: 'text',
    templateHtml: S, templateFileName: S, templateUpdatedAt: 'ts',
    archivedAt: 'ts', createdAt: 'ts', updatedAt: 'ts',
  },
});

const AppointmentSlot = defineModel({
  name: 'AppointmentSlot',
  table: 'appointment_slots',
  fields: {
    slotCode: 'text', label: 'text', phaseLabel: 'text', isMorningPickupOnly: 'bool',
    defaultCapacity: 'int', isActive: 'bool', createdAt: 'ts',
  },
});

const AppointmentSlotOverride = defineModel({
  name: 'AppointmentSlotOverride',
  table: 'appointment_slot_overrides',
  fields: { slotId: 'uuid', overrideDate: 'date', capacityLimit: 'int', isClosed: 'bool', createdAt: 'ts', updatedAt: 'ts' },
});

const AppointmentPurposeCatalog = defineModel({
  name: 'AppointmentPurposeCatalog',
  table: 'appointment_purposes',
  fields: { purposeCode: 'text', label: 'text', sortOrder: 'int', archivedAt: 'ts', createdAt: 'ts' },
});

const CommunityAnnouncement = defineModel({
  name: 'CommunityAnnouncement',
  table: 'community_announcements',
  fields: { category: 'text', title: 'text', body: 'text', isActive: 'bool', archivedAt: 'ts', postedByRole: 'text', createdAt: 'ts' },
});

const AnnouncementDraft = defineModel({
  name: 'AnnouncementDraft',
  table: 'announcement_drafts',
  fields: {
    category: 'text', title: S, body: S, sendSms: 'bool', smsAudience: 'text', smsPuroks: 'texts',
    createdByRole: 'text', createdById: 'text', createdAt: 'ts', updatedAt: 'ts',
  },
});

const FaqEntry = defineModel({
  name: 'FaqEntry',
  table: 'faq_entries',
  fields: {
    category: 'text', question: 'text', answer: 'text', keywords: 'texts', isActive: 'bool',
    sortOrder: 'int', createdAt: 'ts', updatedAt: 'ts',
  },
});

const PasswordResetCode = defineModel({
  name: 'PasswordResetCode',
  table: 'password_reset_codes',
  fields: { userId: 'uuid', codeHash: 'text', expiresAt: 'ts', attempts: 'int', requestIp: 'text', createdAt: 'ts' },
});

const AuthAuditEvent = defineModel({
  name: 'AuthAuditEvent',
  table: 'auth_audit_events',
  fields: { action: 'text', email: 'text', role: 'text', ip: 'text', createdAt: 'ts' },
});

const PortalAuditEvent = defineModel({
  name: 'PortalAuditEvent',
  table: 'portal_audit_events',
  fields: {
    action: 'text', description: 'text', performedByEmail: 'text', performedByName: 'text',
    performedByRole: 'text', metadata: 'jsonb', createdAt: 'ts',
  },
});

const SystemSettings = defineModel({
  name: 'SystemSettings',
  table: 'system_settings',
  idType: 'text',
  fields: { environment: 'text', siteInfo: 'jsonb', updatedAt: 'ts' },
});

// One row per pet. `vaccinated` is a simple yes/no flag (the per-dose history table `animal_vaccinations`
// is no longer used by the app).
const AnimalRecord = defineModel({
  name: 'AnimalRecord',
  table: 'animal_records',
  fields: {
    animalCode: 'text', ownerUserId: 'uuid', ownerResidentId: L(40), ownerName: R(120), ownerContact: L(30), ownerAddress: L(250),
    name: R(80), species: 'text', speciesOther: L(60), breed: L(80), color: L(60), sex: 'text', birthDate: 'date',
    vaccinated: 'bool',
    archivedAt: 'ts', createdByEmail: S, createdAt: 'ts', updatedAt: 'ts',
  },
});

const SmsLog = defineModel({
  name: 'SmsLog',
  table: 'sms_log',
  fields: {
    purpose: 'text', recipient: 'text', residentUserId: 'uuid', message: 'text', status: 'text',
    error: 'text', relatedType: 'text', relatedId: 'text', createdByEmail: 'text', createdAt: 'ts',
  },
});

const Survey = defineModel({
  name: 'Survey',
  table: 'surveys',
  fields: { kind: 'text', title: 'text', description: S, questions: 'jsonb', isActive: 'bool', createdByEmail: S, createdAt: 'ts' },
});

const SurveyResponse = defineModel({
  name: 'SurveyResponse',
  table: 'survey_responses',
  fields: { surveyId: 'uuid', residentUserId: 'uuid', answers: 'jsonb', createdAt: 'ts' },
});

module.exports = {
  User, Appointment, ServiceRequest, ServiceCatalog, AppointmentSlot, AppointmentSlotOverride,
  AppointmentPurposeCatalog, CommunityAnnouncement, AnnouncementDraft, FaqEntry, PasswordResetCode,
  AuthAuditEvent, PortalAuditEvent, SystemSettings, AnimalRecord, SmsLog, Survey, SurveyResponse,
};