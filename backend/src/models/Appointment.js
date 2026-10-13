const mongoose = require('mongoose');
const { Schema } = mongoose;
const { statusTimelineEntrySchema } = require('./shared/statusTimelineEntry');

// Postgres source: appointments table (not in migration files — reconstructed
// from server.js insert/select payloads) + status_timeline/status CHECK from
// 20260504_staff_status_timeline.sql.
const APPOINTMENT_STATUSES = [
  'Pending Review',
  'Processing',
  'Ready for Pickup',
  'Confirmed',
  'Completed',
  'Cancelled',
  'Rejected',
];

const appointmentSchema = new Schema({
  referenceNo: { type: String, required: true, unique: true }, // "APT-####"
  residentUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  purpose: { type: String, required: true },
  notes: { type: String, default: null },
  appointmentDate: { type: String, required: true }, // YYYY-MM-DD, matches parseLocalDateString
  // Old schema had slot_id (FK) + a join to appointment_slots(label) on read.
  // Denormalizing slotLabel here avoids a populate() on every list view —
  // slots change rarely, so this trades a tiny bit of staleness risk for
  // simpler/faster reads. Keep it in sync in the booking route.
  slotId: { type: Schema.Types.ObjectId, ref: 'AppointmentSlot', default: null },
  slotLabel: { type: String, default: null },
  status: {
    type: String,
    required: true,
    default: 'Pending Review',
    enum: APPOINTMENT_STATUSES,
  },
  statusTimeline: { type: [statusTimelineEntrySchema], default: [] },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Matches idx_appointments_resident_user_id
appointmentSchema.index({ residentUserId: 1 });
// Matches idx_appointments_date_status (used heavily by the slot
// availability check: appointments on a date, excluding Rejected/Cancelled)
appointmentSchema.index({ appointmentDate: 1, status: 1 });
// Supports the booked-count-per-slot query in GET /appointment-slots
appointmentSchema.index({ slotId: 1, appointmentDate: 1 });

module.exports = { Appointment: mongoose.model('Appointment', appointmentSchema), APPOINTMENT_STATUSES };