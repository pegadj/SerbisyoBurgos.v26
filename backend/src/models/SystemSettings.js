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
}, {
  timestamps: { createdAt: false, updatedAt: 'updatedAt' },
});

const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);

module.exports = { SystemSettings, SINGLETON_ID };