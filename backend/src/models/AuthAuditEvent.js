const { AuthAuditEvent } = require('../db/models');
const AUTH_AUDIT_ACTIONS = ['login', 'register', 'password_change', 'password_reset_requested', 'password_reset', 'account_approved', 'account_rejected'];
module.exports = { AuthAuditEvent, AUTH_AUDIT_ACTIONS };
