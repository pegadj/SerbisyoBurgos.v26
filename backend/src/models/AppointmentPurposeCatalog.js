const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: appointment_purpose_catalog (20260511)
const appointmentPurposeCatalogSchema = new Schema({
  purposeCode: { type: String, required: true },
  label: { type: String, required: true },
  sortOrder: { type: Number, required: true, default: 0 },
  archivedAt: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Matches idx_appointment_purpose_catalog_archived
appointmentPurposeCatalogSchema.index({ archivedAt: 1 });

// Matches idx_appointment_purpose_code_active — Postgres used a PARTIAL
// unique index (unique purposeCode only WHERE archivedAt IS NULL), so an
// archived row can share a code with a later active one. Mongo partial
// indexes use the same idea via partialFilterExpression.
appointmentPurposeCatalogSchema.index(
  { purposeCode: 1 },
  { unique: true, partialFilterExpression: { archivedAt: null } }
);

module.exports = mongoose.model('AppointmentPurposeCatalog', appointmentPurposeCatalogSchema);