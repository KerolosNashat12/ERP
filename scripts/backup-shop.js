/**
 * Back up one shop, or the whole fleet, from a terminal.
 *
 *   node scripts/backup-shop.js --all
 *   node scripts/backup-shop.js mm
 *   node scripts/backup-shop.js mm --out ./mm.zip
 *
 * The console does the same thing with a button, and the scheduled job does it
 * every night. This exists for the two cases neither covers: a deployment being
 * set up before anyone has a console session, and the moment right before doing
 * something to a live shop that somebody wants a copy taken first.
 *
 * `--out` also writes the archive to a file. Without it the backup is taken and
 * kept in the control plane exactly as the nightly one is, which is usually
 * what is wanted — a copy on the laptop of whoever ran this is not a backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/index.js';
import { initDb, closeDb } from '../src/infrastructure/database/connection.js';
import { initPlatformDb, platformDb, closePlatformDb } from '../src/platform/db.js';
import backupService from '../src/platform/BackupService.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};
const slugs = args.filter((a) => !a.startsWith('--') && a !== value('out'));

if (!config.platform.enabled) {
  console.error(
    'This deployment is a single shop, not a fleet, so there is no shop to name.\n'
    + 'Use `npm run backup` instead — on the file driver it copies the database.',
  );
  process.exit(1);
}

await initDb();
await initPlatformDb();

let targets = slugs;
if (flag('all')) {
  const rows = await platformDb().prepare("SELECT slug FROM tenants WHERE status = 'active' ORDER BY slug").all();
  targets = rows.map((row) => row.slug);
}
if (!targets.length) {
  console.error('Name a shop, or pass --all.');
  await closeDb();
  await closePlatformDb();
  process.exit(1);
}

let failed = 0;
for (const slug of targets) {
  try {
    const backup = await backupService.take(slug, { kind: 'manual' });
    console.log(
      `✔ ${slug}: backup #${backup.id}, ${(backup.byteSize / 1048576).toFixed(2)} MB, `
      + `${backup.rowCount} rows across ${backup.tableCount} tables`,
    );
    if (backup.pruned.length) console.log(`  pruned ${backup.pruned.length} older backup(s)`);

    const out = value('out');
    if (out && targets.length === 1) {
      const target = path.resolve(out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const handle = fs.createWriteStream(target);
      const row = await platformDb().prepare('SELECT * FROM tenant_backups WHERE id = ?').get(backup.id);
      // The same file the console hands over: the stored snapshot plus the two
      // workbooks, built on the way out. See BackupService.buildDownload.
      await backupService.buildDownload(row, (chunk) => new Promise((resolve, reject) => {
        handle.write(chunk, (error) => (error ? reject(error) : resolve()));
      }));
      await new Promise((resolve) => handle.end(resolve));
      console.log(`  written to ${target}`);
    }
  } catch (error) {
    failed += 1;
    console.error(`✖ ${slug}: ${error.message}`);
  }
}

await closeDb();
await closePlatformDb();
process.exit(failed ? 1 : 0);
