const { ServiceCatalog } = require('../db/models');
const SERVICE_CATALOG_STATUSES = ['Active', 'Under Review', 'Inactive'];
module.exports = { ServiceCatalog, SERVICE_CATALOG_STATUSES };
