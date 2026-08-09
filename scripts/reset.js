/** Deletes the local database (a timestamped copy is kept in data/backups). */
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/index.js';

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
