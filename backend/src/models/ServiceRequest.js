const mongoose = require('mongoose');
const { Schema } = mongoose;
const { statusTimelineEntrySchema } = require('./shared/statusTimelineEntry');

// Postgres source: service_requests (20260422_service_requests_realtime,
// 20260422_relax_resident_user_id, 20260502_service_requests_created_at,
// 20260504_staff_status_timeline)
const SERVICE_REQUEST_STATUSES = [
  'Pending',
  'Processing',
  'In Progress',
  'Approved',
  'Ready for Pickup',
  'Completed',
  'Revision Requested',
  'Rejected',
];

const serviceRequestSchema = new Schema({
  referenceNo: { type: String, required: true, unique: true }, // "REQ-####"
  title: { type: String, required: true },
  serviceType: { type: String, required: true },
  purpose: { type: String, default: null }, // optional: what the document is for (e.g. Employment, Scholarship)
  preferredDate: { type: String, required: true }, // YYYY-MM-DD
  preferredTimeSlot: { type: String, required: true },
  status: {
    type: String,
    required: true,
    default: 'Pending',
    enum: SERVICE_REQUEST_STATUSES,
  },
  statusTimeline: { type: [statusTimelineEntrySchema], default: [] },
  // 20260422_relax_resident_user_id made this nullable in Postgres
  // (guest/unauthenticated submissions were allowed at one point) — kept
  // nullable here too rather than required.
  residentUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
});

serviceRequestSchema.index({ residentUserId: 1 });
serviceRequestSchema.index({ status: 1 });
serviceRequestSchema.index({ createdAt: -1 });

module.exports = {
  ServiceRequest: mongoose.model('ServiceRequest', serviceRequestSchema),
  SERVICE_REQUEST_STATUSES,
};