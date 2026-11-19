const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: users table (reconstructed from server.js usage) MERGED
// with profiles (20260421_initial_schema + 20260506/07/08/15/16/17 alters).
//
// WHY MERGED: every `.from("profiles")` call in server.js (31 sites) looks
// the row up by email, and every users<->profiles link in the app is also
// by email — never a real foreign key join. Two Postgres tables existed
// mostly because Supabase Auth owned identity separately from your own
// `users` table. Now that we're replacing Supabase Auth entirely, keeping
// them split would just mean two round-trips (and two places that can go
// out of sync) for data that's always read/written together. One
// collection, one lookup, one source of truth.
// 'staff' is the Barangay Secretary: the single barangay-side role. It carries everything the old
// separate 'admin' role did (service catalog, users, analytics, announcements) plus the old staff
// pages (requests, appointments, documents, profiling). The 'admin' role was removed; run
// scripts/migrate-admin-to-staff.js once to convert any existing 'admin' accounts.
const USER_ROLES = ['resident', 'staff', 'system-admin'];
// 'pending'  = self-registered resident awaiting barangay approval (cannot log in yet)
// 'rejected' = registration was reviewed and declined (cannot log in)
// Accounts created before this change keep their stored value ('active', etc.).
const ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'deactivated', 'rejected'];

// 20260506_staff_permissions (LEGACY): per-page switches the old Barangay Admin could toggle.
// The Barangay Secretary now has full access, so these are no longer enforced; the field is kept
// only so existing documents still validate.
const staffPermissionsSchema = new Schema({
  dashboard: { type: Boolean, default: false },
  appointmentScheduling: { type: Boolean, default: false },
  requestProcessing: { type: Boolean, default: false },
  documentGenerator: { type: Boolean, default: false },
  // Resident Profiling tab. server.js reads and writes this permission, so it has to be declared or it is
  // dropped on save. Defaults to true so staff saved before it existed keep the access they already had.
  residentProfiling: { type: Boolean, default: true },
}, { _id: false });

// Resident profiling record — filled in by barangay staff (Resident Profiling tab).
const residentProfileSchema = new Schema({
  // --- RBI (Record of Barangay Inhabitants) template fields ---
  philsysId: { type: String, trim: true, maxlength: 30, default: '' },
  inhabitantType: { type: String, enum: ['', 'Non-Migrant', 'Migrant', 'Transient'], default: '' },
  lastName: { type: String, trim: true, maxlength: 60, default: '' },
  firstName: { type: String, trim: true, maxlength: 60, default: '' },
  middleName: { type: String, trim: true, maxlength: 60, default: '' },
  suffix: { type: String, trim: true, maxlength: 20, default: '' },
  birthPlace: { type: String, trim: true, maxlength: 120, default: '' },
  birthDate: { type: Date, default: null },
  sex: { type: String, enum: ['', 'Male', 'Female'], default: '' },
  civilStatus: {
    type: String,
    enum: ['', 'Single', 'Married', 'Widowed', 'Divorced', 'Separated', 'Common Law/ Live-in', 'Unknown', 'Annulled'],
    default: ''
  },
  citizenship: { type: String, enum: ['', 'Filipino', 'Dual Citizenship', 'Foreigner'], default: '' },
  occupation: { type: String, trim: true, maxlength: 120, default: '' }, // PROFESSION/ OCCUPATION
  highestEducation: { type: String, trim: true, maxlength: 80, default: '' },
  motherFirstName: { type: String, trim: true, maxlength: 60, default: '' },
  motherMiddleName: { type: String, trim: true, maxlength: 60, default: '' },
  motherLastName: { type: String, trim: true, maxlength: 60, default: '' },
  // (Contact number and email address live on the user document itself.)

  // --- Extra barangay fields (not part of the RBI template; used by SMS targeting / documents) ---
  purok: { type: String, trim: true, maxlength: 80, default: '' },
  address: { type: String, trim: true, maxlength: 250, default: '' },
  // Legacy fields: no longer shown in the profiling form, kept so existing data is not lost.
  voterStatus: { type: String, enum: ['', 'Registered', 'Not Registered'], default: '' },
  remarks: { type: String, trim: true, maxlength: 500, default: '' },
  updatedByEmail: { type: String, default: '' },
  updatedAt: { type: Date, default: null },
}, { _id: false });

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // REAL, actively-used credential store now that Supabase Auth is gone —
  // never log it, never return it in any API response, always access via
  // hashPassword/verifyPassword in src/config/auth.js.
  passwordHash: { type: String, required: true, select: false },
  fullName: { type: String, required: true },
  role: { type: String, required: true, enum: USER_ROLES },
  authProvider: { type: String, required: true, default: 'local', enum: ['local', 'google'] },
  isActive: { type: Boolean, required: true, default: true },
  // Replaces Supabase Auth's refresh-token rotation/session invalidation —
  // bumping this invalidates every previously issued refresh token at once
  // (used on password change, account deactivation, or forced logout).
  tokenVersion: { type: Number, required: true, default: 0 },

  // --- sign-in lockout (too many wrong passwords) ---
  failedLoginCount: { type: Number, default: 0 },
  lastFailedLoginAt: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },

  // --- from profiles (20260421 base) ---
  // (email/role above already cover the base profiles columns)

  // --- from profiles (20260506_staff_permissions) ---
  staffPermissions: { type: staffPermissionsSchema, default: undefined },

  // --- from profiles (20260507_resident_self_registered) ---
  residentSelfRegistered: { type: Boolean, required: true, default: false },

  // --- from profiles (20260508_profiles_contact_number) ---
  contactNumber: { type: String, default: null },

  // --- from profiles (20260515_resident_profile_avatars) ---
  // Was a Supabase Storage public URL (avatar_url). GridFS has no public
  // URL equivalent, so this now stores a GridFS file id (see
  // src/config/upload.js) served through your own /files/:id route.
  avatarFileId: { type: Schema.Types.ObjectId, default: null },

  // --- from profiles (20260516_profiles_account_status) ---
  accountStatus: {
    type: String,
    required: true,
    default: 'active',
    enum: ACCOUNT_STATUSES,
  },

  // --- from profiles (20260517_profiles_identity_verification) ---
  // Was identity_verification_url (Supabase Storage public URL) — same
  // GridFS-file-id treatment as avatarFileId above.
  identityVerificationFileId: { type: Schema.Types.ObjectId, default: null },

  // --- Barangay-issued resident accounts (staff-created / RBI import) ---
  // server.js reads and writes these three, so they have to be in the schema (Mongoose silently drops
  // fields that are not declared).
  // Unique Resident ID (e.g. "SB-00001"); residents can sign in with it instead of an e-mail.
  residentId: { type: String, trim: true, unique: true, sparse: true },
  // false for RBI-imported records that staff have not issued a login for yet.
  loginIssued: { type: Boolean, default: true },
  // Resident opted out of SMS announcements.
  smsOptOut: { type: Boolean, default: false },
  // true while the password was chosen by someone else (staff-issued, reset by staff, set by an admin):
  // the resident must set their own before they can use the portal. Cleared when they change it.
  mustChangePassword: { type: Boolean, default: false },

  // --- Resident Profiling tab (staff-maintained) ---
  residentProfile: { type: residentProfileSchema, default: undefined },
}, {
  timestamps: true,
});

// Frequent lookup pattern throughout server.js: filter by role, sorted or
// paginated for admin/staff listing screens.
userSchema.index({ role: 1 });
// Matches profiles_account_status_check enforcement — used at resident
// login to block suspended/deactivated accounts.
userSchema.index({ accountStatus: 1 });

module.exports = { User: mongoose.model('User', userSchema), USER_ROLES, ACCOUNT_STATUSES };