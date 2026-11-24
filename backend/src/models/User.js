const { User } = require('../db/models');
const USER_ROLES = ['resident', 'staff', 'system-admin'];
const ACCOUNT_STATUSES = ['pending', 'active', 'suspended', 'deactivated', 'rejected'];
module.exports = { User, USER_ROLES, ACCOUNT_STATUSES };
