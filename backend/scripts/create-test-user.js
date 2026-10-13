/**
 * Creates (or resets) a test user directly in MongoDB, bypassing the
 * registration routes — useful right now specifically because the
 * registration/login routes themselves haven't been migrated yet (Phase 3
 * is still in progress). Once those routes are migrated, this script
 * becomes optional (you could just register normally), but it's still
 * handy for quickly creating a system-admin without going through the UI.
 *
 * Usage:
 *   node scripts/create-test-user.js <email> <password> <role>
 *
 * role is one of: resident | staff | admin | system-admin
 *
 * Examples:
 *   node scripts/create-test-user.js admin@test.com Passw0rd123! system-admin
 *   node scripts/create-test-user.js juan@test.com Passw0rd123! resident
 */

require('dotenv').config();
const { connectMongo, mongoose } = require('../src/config/mongoClient');
const { hashPassword } = require('../src/config/auth');
const { User, USER_ROLES } = require('../src/models/User');

async function main() {
  const [, , email, password, role] = process.argv;

  if (!email || !password || !role) {
    console.error('Usage: node scripts/create-test-user.js <email> <password> <role>');
    console.error(`role must be one of: ${USER_ROLES.join(', ')}`);
    process.exit(1);
  }

  if (!USER_ROLES.includes(role)) {
    console.error(`Invalid role "${role}". Must be one of: ${USER_ROLES.join(', ')}`);
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  await connectMongo();

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  const isStaffLike = role === 'staff' || role === 'admin' || role === 'system-admin';

  const user = await User.findOneAndUpdate(
    { email: normalizedEmail },
    {
      $set: {
        email: normalizedEmail,
        passwordHash,
        fullName: normalizedEmail.split('@')[0],
        role,
        authProvider: 'local',
        isActive: true,
        accountStatus: 'active',
        // Staff/admin/system-admin get full permissions by default, matching
        // defaultStaffPermissionsAllTrue() in server.js for new staff accounts.
        staffPermissions: isStaffLike
          ? { dashboard: true, appointmentScheduling: true, requestProcessing: true, documentGenerator: true }
          : undefined,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`\nUser ready:`);
  console.log(`  email: ${user.email}`);
  console.log(`  role:  ${user.role}`);
  console.log(`  _id:   ${user._id}`);
  console.log(`\nLog in with this email + the password you passed in.`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create user:', err);
  process.exit(1);
});