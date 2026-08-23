/**
 * Put a shop back, from a terminal.
 *
 *   node scripts/restore-shop.js mm --list
 *   node scripts/restore-shop.js mm --backup 42
 *   node scripts/restore-shop.js mm --file ./mm.zip
 *
 * ── Why this exists as well as the console button ────────────────────────────
 * The console can restore, and should: the person who needs it is not
 * technical, it is one in the morning, and asking him to find a laptop with
 * Node on it is asking him to lose the shop. But there are two situations the
 * console cannot serve, and they are exactly the situations a restore is for:
 *
 *   - the archive is a file somebody downloaded, and the control plane's copy
 *     of it is gone (`--file`);
 *   - the console itself is what is broken.
 *
 * ── Why this is not friendlier ───────────────────────────────────────────────
 * Every guard the console has, this has too, and one more. It refuses unless
 * the shop's short name is repeated with `--yes-overwrite <slug>`, it takes a
 * safety copy first, and it will not write a snapshot into a database whose
 * install id disagrees with the archive's unless the long, deliberate,
 * unmemorable `--i-know-this-is-a-different-database` is given — which exists
 * for one legitimate case (a shop re-provisioned onto a replacement database)
 * and is spelled so that nobody types it by muscle memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import config from '../src/config/index.js';
import {
  initDb, closeDb, openConnection, runWithTenant,
} from '../src/infrastructure/database/connection.js';
import { initPlatformDb, platformDb, closePlatformDb } from '../src/platform/db.js';
import backupService from '../src/platform/BackupService.js';
import { restoreSnapshot, shopInstallId } from '../src/platform/snapshot.js';
import { runMigrations } from '../src/infrastructure/database/migrations/index.js';
import { zipFromBuffer } from '../src/shared/zipReader.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const slug = args.find((a) => !a.startsWith('--')
  && a !== value('backup') && a !== value('file') && a !== value('yes-overwrite'));

if (!config.platform.enabled) {
  console.error('This deployment is a single shop, not a fleet.');
  process.exit(1);
}
if (!slug) {
  console.error('Name the shop: node scripts/restore-shop.js <slug> --list');
  process.exit(1);
}

await initDb();
await initPlatformDb();

const tenant = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
if (!tenant) {
  console.error(`No shop called "${slug}".`);
  await shutdown(1);
}

if (flag('list') || (!value('backup') && !value('file'))) {
  const { rows } = await backupService.list(slug);
  if (!rows.length) console.log(`"${slug}" has no backups.`);
  for (const row of rows) {
    console.log(
      `#${String(row.id).padEnd(5)} ${row.takenAt}  ${row.kind.padEnd(11)} ${row.status.padEnd(7)} `
      + `${(row.byteSize / 1048576).toFixed(2)} MB  ${row.rowCount} rows`,
    );
  }
  await shutdown(0);
}

const confirmed = value('yes-overwrite');
if (confirmed !== slug) {
  console.error(
    `This replaces everything in "${slug}" with the contents of the archive.\n`
    + `Repeat the shop's name to confirm: --yes-overwrite ${slug}`,
  );
  await shutdown(1);
}

/* ---------------------------------------------------- from the control plane */

if (value('backup')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `About to overwrite "${slug}" from backup #${value('backup')}. The shop will be suspended `
    + 'while it happens and a safety copy will be taken first. Type the shop name again: ',
  );
  rl.close();
  if (answer.trim() !== slug) {
    console.error('Not confirmed. Nothing was changed.');
    await shutdown(1);
  }

  const planned = await backupService.planRestore(slug, Number(value('backup')), null);
  console.log('Before:', JSON.stringify(planned.plan.before));
  console.log('After: ', JSON.stringify(planned.plan.after));
  const result = await backupService.restore(slug, {
    ticket: planned.token, confirmSlug: slug, actor: null,
  });
  console.log(`✔ restored ${result.rows} rows across ${result.tables} tables`);
  console.log(`  safety copy: backup #${result.safetyCopyId}`);
  await shutdown(0);
}

/* ------------------------------------------------------------- from a file */

const file = path.resolve(value('file'));
if (!fs.existsSync(file)) {
  console.error(`No such file: ${file}`);
  await shutdown(1);
}
const archive = zipFromBuffer(fs.readFileSync(file));
const manifest = await archive.readJson('snapshot/manifest.json');

console.log(`Archive: ${manifest.shop.slug} taken ${manifest.takenAt}, ${manifest.totals.rows} rows`);
if (manifest.shop.slug !== slug) {
  console.error(
    `That archive was taken from "${manifest.shop.slug}", not from "${slug}". Refusing.`,
  );
  await shutdown(1);
}

/**
 * An archive taken through the SHOP's own door carries no credentials — see
 * `CREDENTIAL_COLUMNS` in src/platform/snapshot.js. Restoring one is legitimate
 * (it is the shop's whole book) and it ends with a database nobody can sign in
 * to, so it is asked for explicitly and refused before the safety copy rather
 * than after it.
 */
const redacted = manifest.redacted || [];
if (redacted.length && !flag('i-accept-no-passwords')) {
  console.error(
    `This archive was taken from inside the shop, so it does not carry ${redacted.join(', ')}.\n`
    + 'Everything else is in it. Restoring it will leave a shop nobody can sign in to until a\n'
    + 'password is set again with scripts/reset-password.js.\n'
    + 'Pass --i-accept-no-passwords if that is what you mean to do.',
  );
  await shutdown(1);
}

// The safety copy comes first, before anything about the target is touched.
let safety = null;
try {
  safety = await backupService.take(slug, { kind: 'pre_restore' });
  console.log(`Safety copy taken: backup #${safety.id}`);
} catch (error) {
  console.error(`Could not take a safety copy (${error.message}). Refusing to continue.`);
  await shutdown(1);
}

await platformDb().prepare("UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ?")
  .run(new Date().toISOString(), tenant.id);
console.log(`"${slug}" suspended for the restore.`);

const connection = await openConnection({
  driver: tenant.driver || 'sqlite',
  file: tenant.db_file,
  url: tenant.db_url,
  authToken: tenant.db_auth_token,
});

try {
  const result = await runWithTenant({ slug }, connection, async () => {
    await runMigrations();
    const installed = await shopInstallId({ create: false });
    if (installed && manifest.shop.installId && installed !== manifest.shop.installId
        && !flag('i-know-this-is-a-different-database')) {
      throw new Error(
        'This archive belongs to a different database than the one this shop points at. '
        + 'Pass --i-know-this-is-a-different-database if that is deliberate.',
      );
    }
    return restoreSnapshot(manifest, (name) => archive.read(name), {
      allowRedacted: redacted.length > 0,
    });
  });
  console.log(`✔ restored ${result.rows} rows across ${result.tables.length} tables`);
  await platformDb().prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
    .run(tenant.status, new Date().toISOString(), tenant.id);
  console.log(`"${slug}" is ${tenant.status} again.`);
  await connection.close();
  await shutdown(0);
} catch (error) {
  await connection.close();
  console.error(`✖ ${error.message}`);
  console.error(
    `"${slug}" has been left SUSPENDED. Its data was not changed — the restore is one\n`
    + `transaction, so it either happened or it did not. Safety copy: backup #${safety.id}.\n`
    + 'Resume the shop from the console once you have decided what to do.',
  );
  await shutdown(1);
}

async function shutdown(code) {
  await closeDb();
  await closePlatformDb();
  process.exit(code);
}
