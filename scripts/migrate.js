/** Creates or upgrades the database. Safe to run repeatedly. */
import {
  initDb, applySchema, getDb, closeDb, supportsFileBackup, driverName,
} from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';

await initDb();
await applySchema();

const tables = (await getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all())
  .map((r) => r.name);

// A hosted database has no local file to name — say where it actually lives.
console.log(`Database ready at ${supportsFileBackup() ? config.paths.database : `hosted (${driverName()})`}`);
console.log(`${tables.length} tables: ${tables.join(', ')}`);
await closeDb();
