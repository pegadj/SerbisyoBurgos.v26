const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: system_settings (20260512, 20260513) — single-row table
// enforced there via `id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1)`.
// Mongo has no CHECK-on-primary-key equivalent, so the singleton is
// enforced in application code instead: always use the fixed _id below
// with findOneAndUpdate({ _id: SINGLETON_ID }, ..., { upsert: true }),
// never call .create() directly on this model.
const SINGLETON_ID = 'system_settings_singleton';

const systemSettingsSchema = new Schema({
  _id: { type: String, default: SINGLETON_ID },
  environment: {
    type: String,
    required: true,
    default: 'production',
    enum: ['production', 'maintenance'],
  },
  // Barangay details shown on the public pages and printed on documents.
  // Defaults match what used to be typed into the pages, so nothing changes until an admin edits them.
  siteInfo: {
    barangayName: { type: String, trim: true, maxlength: 80, default: 'Burgos' },
    municipality: { type: String, trim: true, maxlength: 80, default: 'San Marcelino' },
    province: { type: String, trim: true, maxlength: 80, default: 'Zambales' },
    contactNumber: { type: String, trim: true, maxlength: 40, default: '09489454674' },
    officeHours: { type: String, trim: true, maxlength: 120, default: 'Mon-Fri 9AM - 5PM' },
    address: {
      type: String, trim: true, maxlength: 250,
      default: '353 National Highway, Barangay Burgos, Covered Court, San Marcelino, Zambales',
    },
    signatoryName: { type: String, trim: true, maxlength: 120, default: 'HON. LILIBETH C. BALLON' },
    signatoryTitle: { type: String, trim: true, maxlength: 120, default: 'Acting Punong Barangay' },
  },
}, {
  timestamps: { createdAt: false, updatedAt: 'updatedAt' },
});

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

module.exports = { SystemSettings, SINGLETON_ID };