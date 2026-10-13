/**
 * Seeds baseline reference data into MongoDB.
 *
 * This REPLACES scripts/migrate-to-mongodb.js for this project — since the
 * Supabase account is inaccessible and there were no resident records in
 * it yet, there's nothing real to migrate. This script instead recreates
 * the same starter/default rows your old SQL migrations created
 * automatically (service catalog, FAQ entries, appointment purpose codes,
 * appointment slots), so the app has the reference data it expects on a
 * clean MongoDB database.
 *
 * Safe to re-run: every write is upsert-by-natural-key, so running this
 * again won't create duplicates.
 *
 * Usage:
 *   node scripts/seed-defaults.js
 */

require('dotenv').config();
const { connectMongo, mongoose } = require('../src/config/mongoClient');

const { ServiceCatalog } = require('../src/models/ServiceCatalog');
const { FaqEntry } = require('../src/models/FaqEntry');
const AppointmentPurposeCatalog = require('../src/models/AppointmentPurposeCatalog');
const AppointmentSlot = require('../src/models/AppointmentSlot');
const { SystemSettings, SINGLETON_ID } = require('../src/models/SystemSettings');

// --- Seed data ------------------------------------------------------------
// Sourced from supabase/migrations/20260428_announcements_service_catalog.sql

const SERVICE_CATALOG_DEFAULTS = [
  { serviceName: 'Barangay Clearance', requiredDocuments: 'Valid ID, Cedula', processingTime: '1-2 Days', status: 'Active' },
  { serviceName: 'Certificate of Indigency', requiredDocuments: "Voter's ID or Brgy. ID", processingTime: 'Same Day', status: 'Active' },
];

// Sourced from supabase/migrations/20260503_replace_faq_tagalog.sql (the
// final/active version — two earlier FAQ migrations were superseded by it).
const FAQ_DEFAULTS = [
  {
    category: 'general',
    question: 'What time is the barangay hall open?',
    answer: 'Monday to Friday, 9:00 AM to 5:00 PM.',
    keywords: ['open', 'hours', 'office hours', 'schedule', 'time', 'barangay hall', 'mon', 'fri', 'monday', 'friday', '9am', '5pm'],
    sortOrder: 1,
  },
  {
    category: 'service_request',
    question: 'What requests/services can I do? (Please list all possible requests residents can make.)',
    answer: 'Issuance of certifications, Barangay Clearances, Barangay Indigency, Barangay Residency, and Cedula.',
    keywords: ['services', 'requests', 'list', 'certifications', 'clearance', 'indigency', 'residency', 'cedula', 'sedula'],
    sortOrder: 2,
  },
  {
    category: 'general',
    question: 'Is there a fee to request services? How much is it?',
    answer: 'Yes. The fee is 100.',
    keywords: ['fee', 'price', 'cost', 'how much', '100', 'payment'],
    sortOrder: 3,
  },
  {
    category: 'service_request',
    question: 'How do I track my request? / How will I know if my request is done?',
    answer: 'Go to your "Service Requests" dashboard. There, you will see the "Status" column and you will be able to track your service request.',
    keywords: ['track', 'status', 'progress', 'done', 'service requests', 'dashboard'],
    sortOrder: 4,
  },
  {
    category: 'service_request',
    question: 'How do I cancel the request I made?',
    answer: 'Click the specific request in your "Recent Service Requests" or go to the "Service Requests" dashboard. You will see the "Actions" column. If the status is still Pending or Request for Revisions, you will see a delete option in the "Actions" column. If the request has another status, you must contact the staff directly.',
    keywords: ['cancel', 'delete', 'remove', 'actions', 'pending', 'request for revisions'],
    sortOrder: 5,
  },
  {
    category: 'service_request',
    question: 'How can I view my previous requests? / What if I want to repeat a previous request?',
    answer: 'By clicking on the "Request History" dashboard, you can access your previous services and request again.',
    keywords: ['history', 'previous', 'repeat', 'request again', 'request history'],
    sortOrder: 6,
  },
];

// Sourced from supabase/migrations/20260511_appointment_purpose_catalog.sql
const PURPOSE_CATALOG_DEFAULTS = [
  { purposeCode: 'in-person', label: 'In-person Document Processing', sortOrder: 1 },
  { purposeCode: 'pickup', label: 'Document / ID Pickup', sortOrder: 2 },
  { purposeCode: 'consultation', label: 'Face-to-Face Consultation', sortOrder: 3 },
];

// NOT from a migration — appointment_slots was never version-controlled in
// Postgres (see the note in src/models/AppointmentSlot.js). Reconstructed
// from the hardcoded values in staff/appointment-scheduling.html, which is
// the closest thing to a source of truth that still exists. Double check
// these against what your staff actually expect before relying on them —
// this is a best-effort reconstruction, not a confirmed export.
const APPOINTMENT_SLOT_DEFAULTS = [
  { slotCode: '0900', label: '09:00 AM - 10:00 AM', phaseLabel: 'Phase 1', isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: '1000', label: '10:00 AM - 11:00 AM', phaseLabel: 'Phase 2', isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: '1100', label: '11:00 AM - 12:00 PM', phaseLabel: 'Phase 3', isMorningPickupOnly: true, defaultCapacity: 10 },
  { slotCode: '0100', label: '01:00 PM - 02:00 PM', phaseLabel: 'Phase 4', isMorningPickupOnly: false, defaultCapacity: 15 },
  { slotCode: '0300', label: '03:00 PM - 04:00 PM', phaseLabel: 'Phase 5', isMorningPickupOnly: false, defaultCapacity: 15 },
  { slotCode: '0400', label: '04:00 PM - 05:00 PM', phaseLabel: 'Phase 6', isMorningPickupOnly: false, defaultCapacity: 15 },
];

// --- Seeding logic ----------------------------------------------------------

async function main() {
  console.log('Connecting to MongoDB...');
  await connectMongo();

  await seedIfEmpty(ServiceCatalog, SERVICE_CATALOG_DEFAULTS, 'service catalog');
  await seedIfEmpty(FaqEntry, FAQ_DEFAULTS, 'FAQ entries');
  await seedIfEmpty(AppointmentPurposeCatalog, PURPOSE_CATALOG_DEFAULTS, 'appointment purpose catalog');
  await seedAppointmentSlots();
  await seedSystemSettings();

  console.log('\nSeeding complete.');
  await mongoose.disconnect();
  process.exit(0);
}

// Mirrors the old SQL migrations' `where not exists (...)` guard — only
// seeds if the collection is completely empty, so it never overwrites
// real data your team has since added through the app.
async function seedIfEmpty(Model, defaults, label) {
  const count = await Model.countDocuments();
  if (count > 0) {
    console.log(`Skipping ${label} — ${count} row(s) already exist.`);
    return;
  }
  await Model.insertMany(defaults);
  console.log(`Seeded ${defaults.length} ${label} row(s).`);
}

async function seedAppointmentSlots() {
  const count = await AppointmentSlot.countDocuments();
  if (count > 0) {
    console.log(`Skipping appointment slots — ${count} row(s) already exist.`);
    return;
  }
  await AppointmentSlot.insertMany(
    APPOINTMENT_SLOT_DEFAULTS.map((slot) => ({ ...slot, isActive: true }))
  );
  console.log(`Seeded ${APPOINTMENT_SLOT_DEFAULTS.length} appointment slot row(s).`);
  console.log('  NOTE: these times/capacities were reconstructed from the staff UI,');
  console.log('  not pulled from real data — confirm with your team before relying on them.');
}

async function seedSystemSettings() {
  await SystemSettings.findOneAndUpdate(
    { _id: SINGLETON_ID },
    { $setOnInsert: { environment: 'production' } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  console.log('System settings singleton ready.');
}

main().catch((err) => {
  console.error('\nSeeding failed:', err);
  process.exit(1);
});