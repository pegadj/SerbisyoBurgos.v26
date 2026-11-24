const { FaqEntry } = require('../db/models');
const FAQ_CATEGORIES = ['service_request', 'document', 'general'];
module.exports = { FaqEntry, FAQ_CATEGORIES };
