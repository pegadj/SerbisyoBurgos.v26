const mongoose = require('mongoose');
const { Schema } = mongoose;

// Replaces Supabase Auth's internal audit_log_entries table, which
// automatically logged login/signup events and was read via a custom RPC
// (see the old backend/supabase/migrations/20260509_auth_audit_log_rpc.sql).
// That table doesn't exist in MongoDB — Auth itself is gone — so this
// collection is written to explicitly at each real auth event (login,
// registration, password change) instead of being populated automatically.
const AUTH_AUDIT_ACTIONS = ['login', 'register', 'password_change'];

const authAuditEventSchema = new Schema({
  action: { type: String, required: true, enum: AUTH_AUDIT_ACTIONS },
  email: { type: String, required: true },
  role: { type: String, default: null },
  ip: { type: String, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

authAuditEventSchema.index({ createdAt: -1 });

module.exports = { AuthAuditEvent: mongoose.model('AuthAuditEvent', authAuditEventSchema), AUTH_AUDIT_ACTIONS };