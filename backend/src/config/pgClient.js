const { Pool, types } = require('pg');

// `date` columns (appointment_date, preferred_date, birth_date, ...) come back
// as 'YYYY-MM-DD' strings instead of JS Date objects. The app already treats
// these fields as strings (that's how they were stored in Mongo), so this keeps
// server.js comparisons and JSON responses unchanged.
types.setTypeParser(1082, (v) => v);

// bigint / count(*) come back as strings by default; the app expects numbers.
types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.error('DATABASE_URL is not set. Add it to your .env file / Render environment.');
}

// Render:
//  - Internal Database URL (web service in the same region): no SSL needed.
//  - External Database URL (your laptop, for the one-off migration): SSL required.
// Override with PGSSL=disable | require if you need to force it.
function sslOption() {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require') return { rejectUnauthorized: false };
  try {
    const host = new URL(DATABASE_URL).hostname;
    // External Render hostnames look like dpg-xxxx-a.<region>-postgres.render.com
    if (host.endsWith('.render.com')) return { rejectUnauthorized: false };
  } catch (_) { /* fall through */ }
  return undefined;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslOption(),
  max: Number(process.env.PG_POOL_MAX || 10),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected Postgres pool error:', err.message);
});

async function connectPg() {
  const client = await pool.connect();
  client.release();
  // eslint-disable-next-line no-console
  console.log('Connected to PostgreSQL');
  return pool;
}

module.exports = { pool, connectPg, query: (text, params) => pool.query(text, params) };