/**
 * Walks every tenant in the control plane and brings its database up to the
 * current schema and migrations — the fleet equivalent of `npm run db:migrate`.
 *
 *   node scripts/migrate-all.js [--include-suspended] [--help]
 *
 * One tenant failing (a bad path, a locked file, a driver that cannot
 * connect) is reported and skipped; it never stops the rest. Safe to run
 * repeatedly — `applySchema()` is `CREATE … IF NOT EXISTS` and each migration
 * records itself once, the same guarantees `scripts/migrate.js` already gives
 * the single-shop database.
 *
 * The same logic backs `POST /api/platform/migrate`, so the CLI and the
 * dashboard's "migrate all" button report identically.
 */
import { initPlatformDb, closePlatformDb } from '../src/platform/db.js';
import { migrateAllTenants } from '../src/platform/migrateAll.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: node scripts/migrate-all.js [options]

Applies the current schema and any pending migrations to every tenant
database registered in the platform's control plane.

Options:
  --include-suspended   also migrate suspended tenants (skipped by default)
  --help, -h             show this help
`);
  process.exit(0);
}

await initPlatformDb();
const results = await migrateAllTenants({ includeSuspended: args.includes('--include-suspended') });

let failures = 0;
for (const result of results) {
  if (result.error) {
    failures += 1;
    console.log(`✖ ${result.slug}: ${result.error}`);
  } else {
    console.log(`✔ ${result.slug}: ${result.applied.length ? result.applied.join(', ') : 'already up to date'}`);
  }
}

if (!results.length) {
  console.log('No tenants registered yet — nothing to migrate.');
} else {
  console.log(`\n${results.length} tenant(s): ${results.length - failures} succeeded, ${failures} failed.`);
}

await closePlatformDb();
process.exit(failures ? 1 : 0);
