const { ServiceRequest } = require('../db/models');
const SERVICE_REQUEST_STATUSES = ['Pending', 'Processing', 'In Progress', 'Approved', 'Ready for Pickup', 'Completed', 'Revision Requested', 'Rejected', 'Cancelled'];
module.exports = { ServiceRequest, SERVICE_REQUEST_STATUSES };
