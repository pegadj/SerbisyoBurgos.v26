const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: appointment_slots — NOT captured in any migration file
// (it was created directly via the Supabase dashboard/SQL editor and never
// version-controlled). Fields below are reconstructed from actual server.js
// usage (GET /appointment-slots, select "id, slot_code, label,
// default_capacity, is_active, is_morning_pickup_only, phase_label").
const appointmentSlotSchema = new Schema({
  slotCode: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  phaseLabel: { type: String, default: null },
  isMorningPickupOnly: { type: Boolean, default: false },
  defaultCapacity: { type: Number, required: true, default: 0 },
  isActive: { type: Boolean, required: true, default: true },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

appointmentSlotSchema.index({ isActive: 1 });

module.exports = mongoose.model('AppointmentSlot', appointmentSlotSchema);