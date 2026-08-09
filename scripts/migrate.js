/** Creates or upgrades the local database file. Safe to run repeatedly. */
import { applySchema, getDb, closeDb } from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';

applySchema();

const tables = getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`Database ready at ${config.paths.database}`);
console.log(`${tables.length} tables: ${tables.join(', ')}`);
closeDb();
