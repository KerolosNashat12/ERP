/**
 * Empties the database so `npm run setup` can rebuild it from the schema.
 *
 * On the local file driver that means deleting the file (a timestamped copy is
 * kept in data/backups). A hosted database has no file to delete and no copy we
 * can take, so there the schema is dropped in place — same end state, but
 * irreversible, which the output says out loud.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  initDb, getDb, closeDb, supportsFileBackup, driverName,
} from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';

// Checked before initDb() deliberately: opening the file driver would create the
// very database we are about to report as missing.
if (supportsFileBackup()) {
  const { database, backups } = config.paths;

  if (!fs.existsSync(database)) {
    console.log('No database to reset.');
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = path.join(backups, `pre-reset-${stamp}.db`);
  fs.copyFileSync(database, archive);

  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${database}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  console.log(`Database removed. A copy was kept at ${archive}`);
  console.log('Run `npm run setup` to rebuild it.');
  process.exit(0);
}

// ------------------------------------------------------------- hosted database

await initDb();
const db = getDb();

const objectNames = async (type) => (await db.prepare(
  "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all(type)).map((row) => row.name);

const views = await objectNames('view');
for (const view of views) await db.prepare(`DROP VIEW IF EXISTS "${view}"`).run();

/**
 * Foreign keys decide the order tables can be dropped in, and only the database
 * knows the graph. Retrying until a pass drops nothing gets there without
 * hard-coding it; a pass that makes no progress is a real error, not an order
 * problem, so it is rethrown.
 */
let remaining = await objectNames('table');
const dropped = [];
while (remaining.length) {
  const blocked = [];
  let lastError = null;
  for (const table of remaining) {
    try {
      await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
      dropped.push(table);
    } catch (error) {
      lastError = error;
      blocked.push(table);
    }
  }
  if (blocked.length === remaining.length) {
    throw new Error(`Could not drop ${blocked.join(', ')}: ${lastError.message}`);
  }
  remaining = blocked;
}

const host = driverName();
await closeDb();

console.log(`Hosted database (${host}) emptied: ${dropped.length} tables and ${views.length} views dropped.`);
console.log('No local copy was kept — a hosted database is backed up by its provider.');
console.log('Run `npm run setup` to rebuild it.');
