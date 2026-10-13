const mongoose = require('mongoose');
const { Schema } = mongoose;

// Postgres source: service_catalog (20260428)
const SERVICE_CATALOG_STATUSES = ['Active', 'Under Review', 'Inactive'];

const serviceCatalogSchema = new Schema({
  serviceName: { type: String, required: true },
  requiredDocuments: { type: String, default: '' },
  processingTime: { type: String, default: '1-2 Days' },
  status: {
    type: String,
    required: true,
    default: 'Active',
    enum: SERVICE_CATALOG_STATUSES, // replaces the Postgres CHECK constraint
  },
  archivedAt: { type: Date, default: null },
}, {
  timestamps: true, // gives createdAt + updatedAt, replaces the set_updated_at trigger
});

// Matches idx_service_catalog_archived — admin list view filters by
// archived vs active services.
serviceCatalogSchema.index({ archivedAt: 1 });

const ServiceCatalog = mongoose.model('ServiceCatalog', serviceCatalogSchema);

module.exports = { ServiceCatalog, SERVICE_CATALOG_STATUSES };