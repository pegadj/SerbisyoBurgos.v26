const { Appointment } = require('../db/models');
const APPOINTMENT_STATUSES = ['Pending Review', 'Processing', 'Ready for Pickup', 'Confirmed', 'Completed', 'Cancelled', 'Rejected'];
module.exports = { Appointment, APPOINTMENT_STATUSES };
