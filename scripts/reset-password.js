#!/usr/bin/env node
/**
 * Get back into your own shop — the locked-out-owner script.
 *
 * The ERP has a forgot-password flow, and it is useless in exactly the case
 * that matters most: a reset request has to be APPROVED by somebody holding
 * `users.reset_password`, and when the person locked out IS the administrator
 * there is nobody left to approve it. Every system needs one door that does
 * not go through the system, and this is it.
 *
 * It is a command-line script, not a route. It cannot be reached over HTTP by
 * anyone, ever. Running it requires what "root" has always required: a person
 * standing at the machine with the database's own credentials in their
 * environment. That is the whole security model, and it is the same one
 * `scripts/reset.js` and `scripts/seed.js` next door already rely on.
 *
 *   node scripts/reset-password.js --list          who exists, and which is an admin
 *   node scripts/reset-password.js <username>      set that person a new password
 *
 * The new password is typed at the keyboard of whoever runs it, is never
 * echoed to the screen, never written to a file, never printed in a log, and
 * never passed as an argument — an argument would sit in the shell's history
 * and in the process list for every other user of the machine to read.
 *
 * It talks to whichever database the environment points at, exactly as the
 * server does, so it reaches the shop PC's file and the hosted Turso database
 * without knowing the difference. On the platform, `MM_TENANT` names which
 * shop — a fleet has one users table per shop.
 */
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import config from '../src/config/index.js';
import { initDb, getDb, openConnection, runWithTenant } from '../src/infrastructure/database/connection.js';

const MIN_LENGTH = 8;

/**
 * When stdin is a pipe rather than a keyboard, every line is read once, up
 * front, and handed out in order.
 *
 * A readline interface per prompt does not work here: the second one is opened
 * over a stream the first has already drained, its `line` event never fires,
 * and the script hangs on the confirmation with nothing on screen to say why.
 * Reading the lot and shifting is the boring answer and the correct one.
 */
let pipedLines = null;
async function readPipedLines() {
  if (pipedLines) return pipedLines;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  pipedLines = text.split(/\r?\n/);
  return pipedLines;
}

/** Read a line without drawing it. Backspace works; everything else is silent. */
async function askHidden(question) {
  const input = process.stdin;
  const output = process.stdout;
  output.write(question);

  if (!input.isTTY) {
    const lines = await readPipedLines();
    output.write('\n');
    return lines.shift() ?? '';
  }

  return new Promise((resolve) => {
    let value = '';
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const onKey = (chunk, key) => {
      if (key.name === 'return' || key.name === 'enter') {
        input.setRawMode(false);
        input.pause();
        input.off('keypress', onKey);
        output.write('\n');
        resolve(value);
        return;
      }
      if (key.ctrl && key.name === 'c') {
        input.setRawMode(false);
        output.write('\n');
        process.exit(130);
      }
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (key.sequence && !key.ctrl && !key.meta && key.sequence >= ' ') value += key.sequence;
    };
    input.on('keypress', onKey);
  });
}

/** Open the database the environment points at — file, hosted, or one tenant of a fleet. */
async function withDatabase(run) {
  const slug = (process.env.MM_TENANT || '').trim();
  if (!slug) {
    await initDb();
    return run(getDb());
  }

  const { platformDb, initPlatformDb } = await import('../src/platform/db.js');
  await initPlatformDb();
  const tenant = await platformDb()
    .prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!tenant) throw new Error(`No shop called "${slug}". Run without MM_TENANT to list the shops.`);

  const connection = await openConnection({
    driver: tenant.driver || 'sqlite',
    file: tenant.db_file,
    url: tenant.db_url,
    authToken: tenant.db_auth_token,
  });
  try {
    return await runWithTenant({ slug }, connection, () => run(getDb()));
  } finally {
    await connection.close();
  }
}

async function list(db) {
  const rows = await db.prepare(`
    SELECT u.username, u.full_name, u.is_active, u.must_change_password, r.code AS role
    FROM users u LEFT JOIN roles r ON r.id = u.role_id
    ORDER BY u.is_active DESC, u.username
  `).all();

  if (!rows.length) {
    console.log('\nThere are no users in this database at all.');
    console.log('That means it has never been seeded — run `npm run db:seed`.\n');
    return;
  }

  console.log(`\n  ${rows.length} user(s) in ${config.database.driver === 'libsql' ? 'the hosted database' : config.paths.database}\n`);
  console.log('  USERNAME              NAME                      ROLE            STATUS');
  console.log('  ' + '─'.repeat(74));
  for (const row of rows) {
    const status = [
      row.is_active ? 'active' : 'DISABLED',
      row.must_change_password ? 'must change password' : '',
    ].filter(Boolean).join(' · ');
    console.log(`  ${String(row.username).padEnd(21)} ${String(row.full_name || '').slice(0, 24).padEnd(25)} ${String(row.role || '—').padEnd(15)} ${status}`);
  }
  console.log('\n  To set one a new password:  node scripts/reset-password.js <username>\n');
}

async function reset(db, username) {
  const user = await db
    .prepare('SELECT id, username, full_name, is_active FROM users WHERE username = ?')
    .get(username);
  if (!user) {
    console.error(`\n  There is no user called "${username}".`);
    console.error('  Run with --list to see who exists.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Setting a new password for ${user.username}${user.full_name ? ` (${user.full_name})` : ''}.`);
  if (!user.is_active) console.log('  Note: this account is disabled. Re-enable it in Users after signing in.');
  console.log('  Nothing you type below is shown on screen.\n');

  const password = await askHidden('  New password: ');
  if (password.length < MIN_LENGTH) {
    console.error(`\n  Too short — ${MIN_LENGTH} characters at least. Nothing was changed.\n`);
    process.exitCode = 1;
    return;
  }
  const again = await askHidden('  Type it again: ');
  if (password !== again) {
    console.error('\n  Those did not match. Nothing was changed.\n');
    process.exitCode = 1;
    return;
  }

  const hash = bcrypt.hashSync(password, config.auth.bcryptRounds);
  // `must_change_password` is cleared deliberately: the person running this IS
  // the person choosing the password, so being made to change it again at the
  // next sign-in is a second lock-out, not a safeguard.
  await db.prepare(`
    UPDATE users
       SET password_hash = ?, must_change_password = 0, is_active = 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?
  `).run(hash, user.id);

  console.log(`\n  ✔ Done. Sign in as "${user.username}" with the password you just typed.\n`);
}

const arg = process.argv[2];
if (!arg || arg === '--help' || arg === '-h') {
  console.log(`
  Get back into the ERP when nobody can approve a password reset.

    node scripts/reset-password.js --list        who exists
    node scripts/reset-password.js <username>    set a new password

  On the platform, name the shop first:  MM_TENANT=mm node scripts/reset-password.js --list
`);
  process.exit(0);
}

try {
  await withDatabase((db) => (arg === '--list' ? list(db) : reset(db, arg)));
} catch (error) {
  console.error(`\n  Could not open the database: ${error.message}\n`);
  process.exitCode = 1;
}
