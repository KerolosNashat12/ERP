/** Creates a consistent backup copy — safe to run while the server is up. */
import { backupTo, closeDb } from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';
import path from 'node:path';
import fs from 'node:fs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(config.paths.backups, `mm-backup-${stamp}.db`);

backupTo(target);
const { size } = fs.statSync(target);
console.log(`Backup written: ${target} (${(size / 1024 / 1024).toFixed(2)} MB)`);
closeDb();
