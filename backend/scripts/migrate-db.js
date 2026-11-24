#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Applies any database migrations in db/migrations/*.sql that have not been applied yet, in filename order.
 * Works without psql. Safe to run any number of times.
 *
 *   node scripts/migrate-db.js
 *
 * It remembers what it applied in a `schema_migrations` table. If the database already contains the original
 * schema (001, applied by hand or by --init-schema before this runner existed), 001 is recorded as applied
 * instead of being run again.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/pgClient');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`No .sql files found in ${DIR}`);

  const client = await pool.connect();
  try {
    const hadTracking = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t !== null;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    if (!hadTracking) {
      const hasUsers = (await client.query("SELECT to_regclass('public.users') AS t")).rows[0].t !== null;
      if (hasUsers && files.includes('001_schema.sql')) {
        await client.query("INSERT INTO schema_migrations (filename) VALUES ('001_schema.sql') ON CONFLICT DO NOTHING");
        console.log('Found an existing schema: recorded 001_schema.sql as already applied.');
      }
    }

    const done = new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));
    const pending = files.filter((f) => !done.has(f));
    if (!pending.length) {
      console.log('Database is up to date. Nothing to apply.');
      return;
    }
    for (const f of pending) {
      process.stdout.write(`Applying ${f} … `);
      try {
        await client.query(fs.readFileSync(path.join(DIR, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
        console.log('done');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.log('FAILED');
        throw e;
      }
    }
    console.log(`Applied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message || err);
  process.exit(1);
});
