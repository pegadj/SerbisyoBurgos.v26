#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Clears the database down to the barangay's own accounts: every resident account and every transactional
 * record is deleted; the Secretary (role "staff") and System Admin accounts stay.
 *
 *   node scripts/cleanup-db.js                      preview only (nothing is changed)
 *   node scripts/cleanup-db.js --yes                really delete (asks you to type DELETE first)
 *
 * Options
 *   --keep-email=a@x.com,b@y.com   keep ONLY these accounts (they must be staff / system-admin). Default: keep
 *                                  every staff and system-admin account.
 *   --wipe-config                  ALSO empty the service catalog, appointment slots/purposes and chatbot FAQ.
 *                                  (Barangay Information / system_settings is never touched. After wiping, run
 *                                  `node scripts/seed-defaults.js` and `node scripts/seed-chatbot-faq.js`.)
 *
 * What is DELETED
 *   resident accounts (+ their profiles), service requests, appointments, animal records, announcements and
 *   drafts, SMS log, audit logs, password-reset codes, and uploaded files nobody keeps (avatars / ID photos).
 * What is KEPT
 *   staff + system-admin accounts (and their avatar files), Barangay Information / system settings, and -
 *   unless --wipe-config is used - the service catalog, appointment slots/purposes and chatbot FAQ.
 *
 * Everything runs in ONE transaction: if anything fails, nothing is deleted. TAKE A BACKUP FIRST
 * (Supabase / Render snapshot, or `pg_dump`). Deleted rows cannot be recovered.
 */
require('dotenv').config();
const readline = require('readline');
const { pool } = require('../src/config/pgClient');

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const WIPE_CONFIG = args.includes('--wipe-config');
const keepArg = args.find((a) => a.startsWith('--keep-email='));
const KEEP_EMAILS = keepArg
  ? keepArg.slice('--keep-email='.length).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  : null;

// Cleared completely. Order matters only for readability: every foreign key here is SET NULL / CASCADE.
const WIPE_ALWAYS = [
  'sms_log', 'password_reset_codes', 'auth_audit_events', 'portal_audit_events',
  'appointments', 'service_requests', 'animal_vaccinations', 'animal_records',
  'community_announcements', 'announcement_drafts'
];
const WIPE_CONFIG_TABLES = ['appointment_slot_overrides', 'appointment_slots', 'appointment_purposes', 'service_catalog', 'faq_entries'];

function maskedTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch (_e) { return '(DATABASE_URL)'; }
}

async function tableExists(db, name) {
  const { rows } = await db.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
  return rows[0].t !== null;
}

async function count(db, name) {
  return Number((await db.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n);
}

// SQL fragment: "this user is one of the accounts to keep" (parameter $1 = email list or null)
const KEEP_SQL = `role IN ('staff','system-admin') AND ($1::text[] IS NULL OR email = ANY($1::text[]))`;
const keepParam = () => [KEEP_EMAILS && KEEP_EMAILS.length ? KEEP_EMAILS : null];

async function confirm() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question('\nType DELETE (capitals) to permanently erase the records above: ', res));
  rl.close();
  return answer.trim() === 'DELETE';
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (check your .env).');
  const db = await pool.connect();
  try {
    console.log(`Database: ${maskedTarget()}\n`);

    const keep = (await db.query(`SELECT email, role, full_name FROM users WHERE ${KEEP_SQL} ORDER BY role, email`, keepParam())).rows;
    if (!keep.length) throw new Error('No staff / system-admin account matches. Refusing to continue: you would be locked out.');
    if (!keep.some((u) => u.role === 'system-admin')) console.log('WARNING: no system-admin account is among the accounts being kept.');
    if (!keep.some((u) => u.role === 'staff')) console.log('WARNING: no staff (Secretary) account is among the accounts being kept.');

    console.log('Accounts that will be KEPT:');
    keep.forEach((u) => console.log(`  - ${u.role.padEnd(13)} ${u.email}${u.full_name ? '  (' + u.full_name + ')' : ''}`));

    const toDelete = Number((await db.query(`SELECT count(*)::int AS n FROM users WHERE NOT (${KEEP_SQL})`, keepParam())).rows[0].n);
    console.log(`\nWill be DELETED:\n  users (everyone else, incl. residents): ${toDelete}`);

    const wipe = [...WIPE_ALWAYS, ...(WIPE_CONFIG ? WIPE_CONFIG_TABLES : [])];
    const present = [];
    for (const t of wipe) {
      if (await tableExists(db, t)) { present.push(t); console.log(`  ${t}: ${await count(db, t)}`); }
    }
    console.log(WIPE_CONFIG
      ? '\n(--wipe-config: service catalog, appointment slots/purposes and FAQ will be emptied too.)'
      : '\nKept as-is: service catalog, appointment slots/purposes, chatbot FAQ, Barangay Information (system_settings).');

    if (!YES) {
      console.log('\nPREVIEW ONLY - nothing was changed. Re-run with --yes to delete.');
      return;
    }
    if (!(await confirm())) { console.log('Cancelled. Nothing was changed.'); return; }

    await db.query('BEGIN');
    try {
      await db.query(`DELETE FROM users WHERE NOT (${KEEP_SQL})`, keepParam());   // cascades to resident_profiles
      for (const t of present) await db.query(`DELETE FROM ${t}`);

      // Uploaded avatars / ID photos that no remaining account uses.
      const files = await db.query(`
        DELETE FROM files WHERE id NOT IN (
          SELECT avatar_file_id FROM users WHERE avatar_file_id IS NOT NULL
          UNION
          SELECT identity_verification_file_id FROM users WHERE identity_verification_file_id IS NOT NULL
        )`);

      // Numbering starts fresh (SB-00001, REQ-10000, APT-10000), but never below an ID a kept account already holds.
      const next = Number((await db.query(
        `SELECT COALESCE(MAX(substring(resident_id FROM '[0-9]+$')::int), 0) + 1 AS n FROM users WHERE resident_id ~ '^SB-[0-9]+$'`
      )).rows[0].n);
      await db.query('SELECT setval(\'resident_id_seq\', $1, false)', [next]);
      await db.query('SELECT setval(\'request_ref_seq\', 10000, false)');
      await db.query('SELECT setval(\'appointment_ref_seq\', 10000, false)');

      await db.query('COMMIT');
      console.log(`\nDone. Deleted ${toDelete} user(s), cleared ${present.length} table(s), removed ${files.rowCount} unused file(s).`);
      console.log('Counters reset: next Resident ID is SB-' + String(next).padStart(5, '0') + '.');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('\nFAILED (nothing was deleted):', e.message); process.exit(1); });
