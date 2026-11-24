#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Backs up the whole database to one JSON file - no pg_dump needed, it uses the same DATABASE_URL as the app.
 *
 *   node scripts/backup-db.js                 -> backups/backup-YYYY-MM-DD_HH-MM-SS.json
 *   node scripts/backup-db.js my-backup.json  -> that file name instead
 *
 * Every table in the public schema is saved (users, residents, requests, files, ...). Put the file somewhere
 * safe. It contains personal data and password hashes: do NOT commit it to git or share it.
 * Restore with:  node scripts/restore-db.js <file>
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/pgClient');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (check your .env).');
  const out = process.argv[2] || path.join(__dirname, '..', 'backups', `backup-${stamp()}.json`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

  const db = await pool.connect();
  try {
    const { rows: tables } = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    // One consistent snapshot of all tables.
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = {};
    for (const { table_name: t } of tables) {
      // json_agg lets Postgres encode every type (uuid, timestamptz, jsonb, arrays, bytea) so restore is exact.
      const r = await db.query(`SELECT coalesce(json_agg(x), '[]'::json) AS d FROM "${t}" x`);
      data[t] = r.rows[0].d;
      console.log(`  ${t.padEnd(30)} ${String(data[t].length).padStart(6)} rows`);
    }
    await db.query('COMMIT');

    fs.writeFileSync(out, JSON.stringify({ format: 'sb-json-backup-1', createdAt: new Date().toISOString(), tables: data }));
    const mb = (fs.statSync(out).size / 1048576).toFixed(2);
    console.log(`\nBackup saved: ${path.resolve(out)} (${mb} MB)`);
    console.log('Keep it private (personal data + password hashes). Do not commit it to git.');
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('\nBackup FAILED:', e.message); process.exit(1); });
