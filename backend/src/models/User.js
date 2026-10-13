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
const USER_ROLES = ['resident', 'admin', 'staff', 'system-admin'];
const ACCOUNT_STATUSES = ['active', 'suspended', 'deactivated'];

// 20260506_staff_permissions — jsonb shape, documented in the migration
// comment as: { dashboard, appointmentScheduling, requestProcessing, documentGenerator }
const staffPermissionsSchema = new Schema({
  dashboard: { type: Boolean, default: false },
  appointmentScheduling: { type: Boolean, default: false },
  requestProcessing: { type: Boolean, default: false },
  documentGenerator: { type: Boolean, default: false },
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