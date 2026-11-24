require('dotenv').config();

const { connectPg, pool } = require('../src/config/pgClient');

// Verify the database connection by running a minimal query and listing tables.
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Run `npm run check:env`.');
  }

  await connectPg();
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const version = (await pool.query('SHOW server_version')).rows[0].server_version;

  console.log('PostgreSQL connection OK.');
  console.log(`Server version: ${version}`);
  console.log(`Tables found: ${rows[0].n}${rows[0].n === 0 ? '  (empty — apply db/migrations/001_schema.sql)' : ''}`);

  await pool.end();
}

// Report connection test failure and exit with a non-zero status code.
main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});