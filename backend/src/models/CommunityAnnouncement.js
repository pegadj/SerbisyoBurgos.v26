const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: community_announcements (20260428, 20260505)
// - RLS was disabled in Postgres (API-trusted table) — no extra access
//   guard needed at the schema level, same as before.
const communityAnnouncementSchema = new Schema({
  category: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  isActive: { type: Boolean, required: true, default: true },
  // Added 20260505 — which portal role posted this (admin vs staff),
  // so residents can filter admin bulletins separately.
  postedByRole: { type: String, default: 'admin' },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Matches idx_community_announcements_created_at (desc) — bulletin feed
// is always queried newest-first.
communityAnnouncementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CommunityAnnouncement', communityAnnouncementSchema);