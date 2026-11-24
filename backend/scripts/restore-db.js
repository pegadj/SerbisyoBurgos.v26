#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Restores a backup made by scripts/backup-db.js. The tables in the backup are EMPTIED first and then refilled,
 * so the database ends up exactly as it was when the backup was taken. Tables that are not in the backup are left alone.
 *
 *   node scripts/restore-db.js backups/backup-2026-11-24_10-00-00.json           preview only
 *   node scripts/restore-db.js backups/backup-2026-11-24_10-00-00.json --yes     really restore (asks you to type RESTORE)
 *
 * The database must already have its tables (run `node scripts/migrate-db.js` on a brand-new database first).
 * Everything runs in one transaction: if anything fails, nothing is changed.
 */
require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const { pool } = require('../src/config/pgClient');

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const YES = process.argv.includes('--yes');

function maskedTarget() {
  try { const u = new URL(process.env.DATABASE_URL); return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; }
  catch (_e) { return '(DATABASE_URL)'; }
}

async function confirm() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question('\nType RESTORE (capitals) to replace the data in this database: ', res));
  rl.close();
  return a.trim() === 'RESTORE';
}

/** Parents before children, so foreign keys are satisfied while inserting. */
async function insertOrder(db, names) {
  const { rows } = await db.query(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class p ON p.oid = k.confrelid
      WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace`
  );
  const deps = new Map(names.map((n) => [n, new Set()]));
  rows.forEach((r) => { if (r.child !== r.parent && deps.has(r.child) && deps.has(r.parent)) deps.get(r.child).add(r.parent); });
  const ordered = [];
  const done = new Set();
  while (ordered.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...deps.get(n)].every((p) => done.has(p)));
    if (!ready.length) throw new Error('Could not work out the table order (circular foreign keys).');
    ready.forEach((n) => { done.add(n); ordered.push(n); });
  }
  return ordered;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (check your .env).');
  if (!file) throw new Error('Usage: node scripts/restore-db.js <backup-file.json> [--yes]');
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.format !== 'sb-json-backup-1' || !backup.tables) throw new Error('That file is not a backup made by scripts/backup-db.js.');

  const db = await pool.connect();
  try {
    console.log(`Database: ${maskedTarget()}`);
    console.log(`Backup:   ${file}  (taken ${backup.createdAt})\n`);

    const existing = new Set((await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )).rows.map((r) => r.table_name));
    const names = Object.keys(backup.tables).filter((t) => existing.has(t));
    const missing = Object.keys(backup.tables).filter((t) => !existing.has(t));
    if (missing.length) console.log(`Skipping tables that do not exist in this database: ${missing.join(', ')}\n`);

    for (const t of names) {
      const now = Number((await db.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
      console.log(`  ${t.padEnd(30)} now ${String(now).padStart(6)}  ->  backup ${String(backup.tables[t].length).padStart(6)}`);
    }
    if (!YES) { console.log('\nPREVIEW ONLY - nothing was changed. Re-run with --yes to restore.'); return; }
    if (!(await confirm())) { console.log('Cancelled. Nothing was changed.'); return; }

    const order = await insertOrder(db, names);
    await db.query('BEGIN');
    try {
      await db.query(`TRUNCATE ${names.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
      for (const t of order) {
        const rows = backup.tables[t];
        if (!rows.length) continue;
        // json_populate_recordset converts every value back to the column's real type (uuid, timestamptz, bytea, arrays ...)
        await db.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(null::"${t}", $1::json)`, [JSON.stringify(rows)]);
      }
      // Counters continue after the highest restored number.
      const seqs = [
        ['resident_id_seq', `SELECT COALESCE(MAX(substring(resident_id FROM '[0-9]+$')::int), 0) + 1 FROM users WHERE resident_id ~ '^SB-[0-9]+$'`, 1],
        ['request_ref_seq', `SELECT COALESCE(MAX(substring(reference_no FROM '[0-9]+$')::int), 0) + 1 FROM service_requests WHERE reference_no ~ '[0-9]+$'`, 10000],
        ['appointment_ref_seq', `SELECT COALESCE(MAX(substring(reference_no FROM '[0-9]+$')::int), 0) + 1 FROM appointments WHERE reference_no ~ '[0-9]+$'`, 10000]
      ];
      for (const [seq, sql, min] of seqs) {
        if ((await db.query('SELECT to_regclass($1) AS t', [`public.${seq}`])).rows[0].t === null) continue;
        const n = Number(Object.values((await db.query(sql)).rows[0])[0]);
        await db.query('SELECT setval($1, $2, false)', [seq, Math.max(n, min)]);
      }
      await db.query('COMMIT');
      console.log(`\nRestore complete: ${names.length} table(s) restored.`);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('\nRestore FAILED (nothing was changed):', e.message); process.exit(1); });
