const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: portal_audit_events (20260510) — the app-level audit
// trail for business actions (resident requests, status changes, etc.),
// distinct from Supabase Auth's own login/signup audit log and distinct
// from the auto-generated record_version table (see Appointment.js note
// and the Phase 3 plan for how those two get replaced).
//
// RLS was ENABLED on this table in Postgres (unlike community_announcements
// etc. which disabled it) — meaning Postgres itself, not just the API, was
// restricting reads. Since Mongo has no RLS, every route reading this
// collection needs an explicit requireRole('admin', 'system-admin') guard
// (see src/config/auth.js) — don't rely on "it was safe before."
const portalAuditEventSchema = new Schema({
  action: { type: String, required: true },
  description: { type: String, required: true },
  performedByEmail: { type: String, default: null },
  performedByName: { type: String, default: null },
  performedByRole: { type: String, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Matches idx_portal_audit_events_created_at (desc) — audit UI always
// lists newest first.
portalAuditEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PortalAuditEvent', portalAuditEventSchema);