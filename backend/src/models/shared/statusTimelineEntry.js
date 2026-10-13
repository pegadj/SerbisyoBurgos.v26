const { Schema } = require('mongoose');

// Shared by Appointment and ServiceRequest — replaces the jsonb
// status_timeline column added in 20260504_staff_status_timeline.sql.
// This was already a jsonb array of {status, at, note} objects, so it
// maps onto Mongo as a native subdocument array with no format change —
// timelineForApiResponse()/buildNextTimelineFromRow() logic in server.js
// can stay almost identical, just reading/writing this field instead.
const statusTimelineEntrySchema = new Schema({
  status: { type: String, required: true },
  at: { type: Date, required: true },
  note: { type: String, default: null },
}, { _id: false });

module.exports = { statusTimelineEntrySchema };