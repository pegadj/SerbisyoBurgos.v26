/**
 * Mints a valid access token for an existing MongoDB user, without going
 * through the actual /login route (which hasn't been migrated off
 * Supabase Auth yet — see the note in the chat response this came with).
 *
 * This lets you test today's migrated routes (the ones behind
 * requireResidentPortalUser / requireStaffPortalUser / requireSystemAdminUser)
 * with a real Bearer token, before login itself is rewritten.
 *
 * Usage:
 *   node scripts/mint-test-token.js <email>
 */

require('dotenv').config();
const { connectMongo, mongoose } = require('../src/config/mongoClient');
const { signAccessToken } = require('../src/config/auth');
const { User } = require('../src/models/User');

async function main() {
  const [, , email] = process.argv;
  if (!email) {
    console.error('Usage: node scripts/mint-test-token.js <email>');
    process.exit(1);
  }

  await connectMongo();

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) {
    console.error(`No user found with email "${email}". Run create-test-user.js first.`);
    process.exit(1);
  }

  const token = signAccessToken(user);

  console.log(`\nAccess token for ${user.email} (role: ${user.role}):\n`);
  console.log(token);
  console.log(`\nUse it like:`);
  console.log(`  curl -H "Authorization: Bearer ${token}" http://localhost:${process.env.PORT || 4000}/resident/service-catalog`);
  console.log(`\nExpires in ${process.env.JWT_ACCESS_TTL || '15m'} — re-run this script for a fresh one.`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to mint token:', err);
  process.exit(1);
});