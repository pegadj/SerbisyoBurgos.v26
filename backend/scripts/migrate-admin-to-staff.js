/**
 * One-time migration: the separate "admin" (Barangay Administrator) role was merged into "staff"
 * (Barangay Secretary). Run this ONCE against your database after deploying the updated backend,
 * otherwise any existing 'admin' account can no longer sign in.
 *
 * Usage:
 *   node scripts/migrate-admin-to-staff.js            # preview only (changes nothing)
 *   node scripts/migrate-admin-to-staff.js --apply    # actually convert the accounts
 *
 * What it does:
 *   - Every user with role 'admin' becomes role 'staff'.
 *   - tokenVersion is bumped so their old sessions stop working and they sign in again.
 * Announcements posted earlier by an admin keep their stored postedByRole ('admin'); the backend
 * treats 'admin' and 'staff' the same when residents view announcements, so nothing else changes.
 */
require('dotenv').config();
const { connectMongo, mongoose } = require('../src/config/mongoClient');
const { User } = require('../src/models/User');

async function main() {
  const apply = process.argv.includes('--apply');
  await connectMongo();

  // Use the raw collection: the User model no longer lists 'admin' as a valid role.
  const users = User.collection;
  const legacy = await users.find({ role: 'admin' }, { projection: { email: 1, fullName: 1 } }).toArray();

  if (!legacy.length) {
    console.log("No accounts with role 'admin' found. Nothing to migrate.");
  } else {
    console.log(`Found ${legacy.length} account(s) with role 'admin':`);
    legacy.forEach((u) => console.log(`  - ${u.email}  (${u.fullName || 'no name'})`));

    if (!apply) {
      console.log("\nPreview only. Re-run with --apply to convert them to role 'staff'.");
    } else {
      const result = await users.updateMany(
        { role: 'admin' },
        { $set: { role: 'staff' }, $inc: { tokenVersion: 1 } }
      );
      console.log(`\nConverted ${result.modifiedCount} account(s) to role 'staff' (Barangay Secretary).`);
    }
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
