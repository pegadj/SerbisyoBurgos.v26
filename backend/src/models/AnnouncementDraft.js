const mongoose = require('mongoose');
const { Schema } = mongoose;

// Unpublished announcement drafts (admin side). Kept separate from
// CommunityAnnouncement so drafts never appear on the resident bulletin board.
// Fields are intentionally optional: a draft may be saved half-written.
const announcementDraftSchema = new Schema({
  category: { type: String, default: 'Community News' },
  title: { type: String, default: '' },
  body: { type: String, default: '' },
  sendSms: { type: Boolean, default: true },
  smsAudience: { type: String, enum: ['all', 'puroks'], default: 'all' },
  smsPuroks: { type: [String], default: [] },
  createdByRole: { type: String, default: 'admin' },
  createdById: { type: String, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

announcementDraftSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('AnnouncementDraft', announcementDraftSchema);