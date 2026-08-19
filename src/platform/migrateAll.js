/**
 * Fleet migrations: bring every tenant's schema up to date.
 *
 * Shared between `scripts/migrate-all.js` and `POST /api/platform/migrate` so
 * both report identically. One tenant failing — a bad path, a locked file, a
 * driver that cannot connect — must not stop the rest, so each tenant runs in
 * its own try/catch and the loop always finishes.
 */
import { platformDb } from './db.js';
import { openConnection, runWithTenant } from '../infrastructure/database/connection.js';
import { runMigrations } from '../infrastructure/database/migrations/index.js';
import { forgetTenant } from '../api/middleware/tenant.js';

export async function migrateAllTenants({ includeSuspended = false } = {}) {
  const db = platformDb();
  const tenants = includeSuspended
    ? await db.prepare('SELECT * FROM tenants ORDER BY slug').all()
    : await db.prepare("SELECT * FROM tenants WHERE status != 'suspended' ORDER BY slug").all();

  const results = [];
  for (const tenant of tenants) {
    try {
      const connection = await openConnection({
        driver: tenant.driver || 'sqlite',
        file: tenant.db_file,
        url: tenant.db_url,
        authToken: tenant.db_auth_token,
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        const applied = await runWithTenant({ slug: tenant.slug }, connection, async () => {
          await connection.applySchema();
          return runMigrations();
        });
        results.push({ slug: tenant.slug, applied, error: null });
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await connection.close();
      }
      // eslint-disable-next-line no-await-in-loop
      await forgetTenant(tenant.slug);
    } catch (error) {
      results.push({ slug: tenant.slug, applied: [], error: error.message });
    }
  }
  return results;
}

export default { migrateAllTenants };
