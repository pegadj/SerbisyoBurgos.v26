const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: appointment_slot_overrides — also not in migration files,
// reconstructed from PUT /admin/appointment-slot-overrides usage
// (slot_id, override_date, capacity_limit; upserted together).
const appointmentSlotOverrideSchema = new Schema({
  slotId: { type: Schema.Types.ObjectId, ref: 'AppointmentSlot', required: true },
  overrideDate: { type: String, required: true }, // stored as YYYY-MM-DD, same as parseLocalDateString output
  capacityLimit: { type: Number, required: true },
}, {
  timestamps: true,
});

// Composite unique — one override per slot per date, matches the Postgres
// upsert target (slot_id, override_date).
appointmentSlotOverrideSchema.index({ slotId: 1, overrideDate: 1 }, { unique: true });

module.exports = mongoose.model('AppointmentSlotOverride', appointmentSlotOverrideSchema);