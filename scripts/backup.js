/** Creates a consistent backup copy — safe to run while the server is up. */
import {
  initDb, backupTo, closeDb, supportsFileBackup, driverName,
} from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';
import path from 'node:path';
import fs from 'node:fs';

await initDb();

/**
 * Only the local file driver can hand us a copy on disk. Writing nothing is the
 * correct outcome on a hosted database, not a failure — so say why and stop,
 * rather than leaving a crash in a scheduled task that nobody reads.
 */
if (!supportsFileBackup()) {
  console.log(
    `Creating a backup is not available on this deployment: the database runs on ${driverName()}, `
    + 'where backups and restores are handled by the database provider.',
  );
  await closeDb();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(config.paths.backups, `mm-backup-${stamp}.db`);

await backupTo(target);
const { size } = fs.statSync(target);
console.log(`Backup written: ${target} (${(size / 1024 / 1024).toFixed(2)} MB)`);
await closeDb();
