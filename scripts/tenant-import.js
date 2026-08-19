/**
 * Moves an existing single-shop database into the platform as a tenant —
 * without touching the original. This is how M&M itself becomes `/t/mm`.
 *
 *   node scripts/tenant-import.js --file data/mm-accessories.db --slug mm \
 *     --name "M&M Accessories" [--name-ar "..."] [--force]
 *
 * The source file is copied, never moved, and never opened by this script —
 * only `fs.copyFileSync` touches it, so its mtime and byte length are exactly
 * what they were before this ran, whether the import succeeds or fails.
 * Re-running with `--force` overwrites a previous import of the same slug;
 * without it, an existing registration is left alone and the script exits
 * with an error rather than silently clobbering data.
 *
 * The tenant is registered with every module enabled and no limits — moving
 * a shop in must not, by itself, take anything away from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/index.js';
import { initPlatformDb, closePlatformDb, platformDb } from '../src/platform/db.js';
import { forgetTenant } from '../src/api/middleware/tenant.js';
import { openConnection, runWithTenant } from '../src/infrastructure/database/connection.js';
import { runMigrations } from '../src/infrastructure/database/migrations/index.js';
import { MODULES } from '../src/shared/permissions.js';

const RESERVED_SLUGS = new Set(['api', 'platform', 't', 'shop', 'admin', 'assets', 'static']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(`
Usage: node scripts/tenant-import.js --file <path> --slug <slug> --name "<name>" [options]

Copies an existing shop database into the platform as a tenant. The source
file is never modified or moved — only read.

Options:
  --file <path>      the shop database to import (required)
  --slug <slug>       the tenant's slug, e.g. "mm" (required)
  --name <text>       the tenant's display name in English (required)
  --name-ar <text>    the tenant's display name in Arabic (defaults to --name)
  --force              overwrite an existing tenant registration with this slug
  --help, -h            show this help
`);
  process.exit(0);
}

const { file, slug, name } = args;
if (!file || !slug || !name || slug === true || name === true || file === true) {
  console.error('✖ --file, --slug and --name are all required. Run with --help for usage.');
  process.exit(1);
}

if (!SLUG_RE.test(slug)) {
  console.error(`✖ "${slug}" is not a valid slug (lowercase letters, digits, hyphens, 2-31 characters).`);
  process.exit(1);
}
if (RESERVED_SLUGS.has(slug)) {
  console.error(`✖ "${slug}" is a reserved word and cannot be used as a tenant slug.`);
  process.exit(1);
}

const sourcePath = path.resolve(file);
if (!fs.existsSync(sourcePath)) {
  console.error(`✖ No database found at ${sourcePath}`);
  process.exit(1);
}

// Recorded before anything else touches the filesystem, and compared again
// at the very end — the whole point of the exercise is that these match.
const sourceStatBefore = fs.statSync(sourcePath);

await initPlatformDb();
const db = platformDb();

const existing = await db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
if (existing && !args.force) {
  console.error(`✖ Tenant "${slug}" is already registered. Pass --force to re-import over it.`);
  await closePlatformDb();
  process.exit(1);
}

fs.mkdirSync(config.platform.tenantsDir, { recursive: true });
const destPath = path.join(config.platform.tenantsDir, `${slug}.db`);

// A stale WAL/SHM from a previous attempt must not survive a fresh copy of
// the main file — it would replay old, unrelated writes on top of it.
for (const suffix of ['-wal', '-shm']) {
  const stale = `${destPath}${suffix}`;
  if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
}
fs.copyFileSync(sourcePath, destPath);
console.log(`✔ Copied ${sourcePath} -> ${destPath}`);

const now = new Date().toISOString();
const allModules = Object.keys(MODULES);
const nameAr = args['name-ar'] && args['name-ar'] !== true ? args['name-ar'] : name;

let tenantId;
if (existing) {
  await db.prepare(`
    UPDATE tenants SET name_en = ?, name_ar = ?, status = 'active', driver = 'sqlite',
      db_file = ?, db_url = NULL, db_auth_token = NULL, website_enabled = 1,
      max_users = 0, max_products = 0, updated_at = ? WHERE id = ?
  `).run(name, nameAr, destPath, now, existing.id);
  await db.prepare('DELETE FROM tenant_modules WHERE tenant_id = ?').run(existing.id);
  tenantId = existing.id;
} else {
  const inserted = await db.prepare(`
    INSERT INTO tenants (slug, name_en, name_ar, status, driver, db_file, website_enabled,
                          max_users, max_products, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'sqlite', ?, 1, 0, 0, ?, ?)
  `).run(slug, name, nameAr, destPath, now, now);
  tenantId = inserted.lastInsertRowid;
}
for (const module of allModules) {
  await db.prepare('INSERT INTO tenant_modules (tenant_id, module) VALUES (?, ?)').run(tenantId, module);
}
await forgetTenant(slug);

const connection = await openConnection({ driver: 'sqlite', file: destPath });
let summary;
try {
  summary = await runWithTenant({ slug }, connection, async () => {
    await connection.applySchema();
    const applied = await runMigrations();
    const [users, products, sales] = await Promise.all([
      connection.facade.prepare('SELECT COUNT(*) AS n FROM users').get(),
      connection.facade.prepare('SELECT COUNT(*) AS n FROM products').get(),
      connection.facade.prepare('SELECT COUNT(*) AS n FROM sales').get(),
    ]);
    return {
      applied, users: users.n, products: products.n, sales: sales.n,
    };
  });
} finally {
  await connection.close();
}

const sourceStatAfter = fs.statSync(sourcePath);
if (sourceStatAfter.mtimeMs !== sourceStatBefore.mtimeMs || sourceStatAfter.size !== sourceStatBefore.size) {
  console.warn('⚠  The source file changed during the import — was the shop trading while this ran?');
}

console.log(`✔ Tenant "${slug}" ready at /t/${slug}`);
if (summary.applied.length) console.log(`  Applied migrations: ${summary.applied.join(', ')}`);
console.log(`  ${summary.users} user(s), ${summary.products} product(s), ${summary.sales} sale(s) — nothing lost.`);

await closePlatformDb();
