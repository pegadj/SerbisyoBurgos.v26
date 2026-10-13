const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: faq_entries (20260501, 20260502, 20260503)
const FAQ_CATEGORIES = ['service_request', 'document', 'general'];

const faqEntrySchema = new Schema({
  category: {
    type: String,
    required: true,
    enum: FAQ_CATEGORIES, // replaces the Postgres CHECK constraint
  },
  question: { type: String, required: true },
  answer: { type: String, required: true },
  // Postgres used text[] + a GIN index for keyword lookup. Mongo has no
  // GIN equivalent, but a standard multikey index on an array field gives
  // the same "does this array contain X" query performance.
  keywords: { type: [String], default: [] },
  isActive: { type: Boolean, required: true, default: true },
  sortOrder: { type: Number, required: true, default: 0 },
}, {
  timestamps: true,
});

// Matches idx_faq_entries_category_active_sort — the chatbot's main
// lookup path (active FAQs in a category, in display order).
faqEntrySchema.index({ category: 1, isActive: 1, sortOrder: 1 });

// Matches idx_faq_entries_keywords (GIN) — Mongo auto-creates a multikey
// index on array fields, this just makes it explicit and queryable via
// keywords: { $in: [...] } the same way the old code checked overlap.
faqEntrySchema.index({ keywords: 1 });

module.exports = { FaqEntry: mongoose.model('FaqEntry', faqEntrySchema), FAQ_CATEGORIES };