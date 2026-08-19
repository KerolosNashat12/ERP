/**
 * Fleet management: create, read, suspend, resume and reset a tenant.
 *
 * `create()` is the interesting one. It touches two things that cannot be
 * made transactional together — a row in the control-plane database and a
 * file on disk — so "atomic in effect" means something narrower but just as
 * important: if any step after the row is inserted fails, both the row and
 * the half-made file are removed, and nothing is left half-provisioned for
 * the next `create()` of the same slug to trip over.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { platformDb } from './db.js';
import { openConnection, runWithTenant } from '../infrastructure/database/connection.js';
import { connectionFor } from '../infrastructure/database/connections.js';
import { runMigrations } from '../infrastructure/database/migrations/index.js';
import { seedBaseline } from '../infrastructure/database/seed.js';
import { MODULES } from '../shared/permissions.js';
import {
  ConflictError, NotFoundError, ValidationError,
} from '../shared/errors.js';
import { forgetTenant } from '../api/middleware/tenant.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED_SLUGS = new Set(['api', 'platform', 't', 'shop', 'admin', 'assets', 'static']);
const VALID_MODULES = new Set(Object.keys(MODULES));

function assertValidSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new ValidationError(
      'Slug must be lowercase letters, digits and hyphens, 2-31 characters, starting with a letter or digit',
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ValidationError(`"${slug}" is a reserved word and cannot be used as a tenant slug`);
  }
}

function assertValidModules(modules) {
  for (const module of modules) {
    if (!VALID_MODULES.has(module)) throw new ValidationError(`Unknown module "${module}"`);
  }
}

/** A password nobody but the caller of `create`/`resetAdminPassword` ever sees. */
function generatePassword() {
  return crypto.randomBytes(15).toString('base64url');
}

function toView(row, modules) {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    status: row.status,
    driver: row.driver,
    websiteEnabled: Boolean(row.website_enabled),
    limits: { maxUsers: row.max_users, maxProducts: row.max_products },
    modules,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function modulesFor(tenantId) {
  const db = platformDb();
  const rows = await db.prepare('SELECT module FROM tenant_modules WHERE tenant_id = ?').all(tenantId);
  return rows.map((r) => r.module).sort();
}

async function findRow(slug) {
  return platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

async function requireRow(slug) {
  const row = await findRow(slug);
  if (!row) throw new NotFoundError('Tenant', slug);
  return row;
}

async function recordAudit(action, { tenantId = null, actor = null, detail = null } = {}) {
  await platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor?.id ?? null, tenantId, action, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

export async function list() {
  const db = platformDb();
  const rows = await db.prepare('SELECT * FROM tenants ORDER BY slug').all();
  const moduleRows = await db.prepare('SELECT tenant_id, module FROM tenant_modules').all();
  const byTenant = new Map();
  for (const r of moduleRows) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r.module);
  }
  return rows.map((row) => toView(row, (byTenant.get(row.id) || []).sort()));
}

export async function get(slug) {
  const row = await requireRow(slug);
  return toView(row, await modulesFor(row.id));
}

/**
 * Provision a tenant end to end: the control-plane row, its own database
 * file, schema, migrations, the baseline seed, the shop's own name, and a
 * fresh admin password nobody chose — returned once, stored nowhere in the
 * clear.
 *
 * On any failure past the row insert, both the row and the database file
 * (plus its WAL/SHM siblings, if the failure happened after they existed)
 * are removed, so a retry of the same slug starts clean.
 */
export async function create(input, actor = null) {
  const {
    slug, nameEn, nameAr, modules = [], limits = {}, websiteEnabled = true,
  } = input || {};

  assertValidSlug(slug);
  if (!nameEn || !String(nameEn).trim()) throw new ValidationError('nameEn is required');
  assertValidModules(modules);

  if (await findRow(slug)) throw new ConflictError(`Tenant "${slug}" already exists`);

  fs.mkdirSync(config.platform.tenantsDir, { recursive: true });
  const dbFile = path.join(config.platform.tenantsDir, `${slug}.db`);
  if (fs.existsSync(dbFile)) {
    throw new ConflictError(`A database file already exists for "${slug}" — remove it before retrying`);
  }

  const db = platformDb();
  const now = new Date().toISOString();
  let tenantId = null;
  let fileCreated = false;

  try {
    const inserted = await db.prepare(`
      INSERT INTO tenants (slug, name_en, name_ar, status, driver, db_file, website_enabled,
                            max_users, max_products, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 'sqlite', ?, ?, ?, ?, ?, ?)
    `).run(
      slug, nameEn, nameAr || nameEn, dbFile, websiteEnabled ? 1 : 0,
      Number(limits.maxUsers || 0), Number(limits.maxProducts || 0), now, now,
    );
    tenantId = inserted.lastInsertRowid;

    for (const module of modules) {
      await db.prepare('INSERT INTO tenant_modules (tenant_id, module) VALUES (?, ?)').run(tenantId, module);
    }

    const connection = await openConnection({ driver: 'sqlite', file: dbFile });
    fileCreated = true;
    let adminPassword;
    try {
      adminPassword = await runWithTenant(
        { slug, modules: new Set(modules), limits, websiteEnabled },
        connection,
        async () => {
          await connection.applySchema();
          await runMigrations();
          await seedBaseline();

          const generated = generatePassword();
          const hash = bcrypt.hashSync(generated, config.auth.bcryptRounds);
          await connection.facade.prepare(
            "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = 'admin'",
          ).run(hash);
          await connection.facade.prepare("UPDATE settings SET value = ? WHERE key = 'company.name'").run(nameEn);
          await connection.facade.prepare("UPDATE settings SET value = ? WHERE key = 'company.name_ar'")
            .run(nameAr || nameEn);
          return generated;
        },
      );
    } finally {
      await connection.close();
    }

    await recordAudit('CREATE', { tenantId, actor, detail: { slug } });
    // A negative lookup could have been cached by a request that raced this
    // creation; drop it so the tenant is reachable immediately.
    await forgetTenant(slug);

    return {
      slug, id: tenantId, adminUsername: 'admin', adminPassword,
    };
  } catch (error) {
    if (tenantId) {
      try {
        await db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
      } catch { /* the file cleanup below still runs even if this fails */ }
    }
    if (fileCreated || fs.existsSync(dbFile)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${dbFile}${suffix}`;
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
    }
    throw error;
  }
}

export async function update(slug, patch = {}, actor = null) {
  const row = await requireRow(slug);
  const db = platformDb();

  const fields = [];
  const values = [];
  if (patch.nameEn !== undefined) { fields.push('name_en = ?'); values.push(patch.nameEn); }
  if (patch.nameAr !== undefined) { fields.push('name_ar = ?'); values.push(patch.nameAr); }
  if (patch.websiteEnabled !== undefined) { fields.push('website_enabled = ?'); values.push(patch.websiteEnabled ? 1 : 0); }
  if (patch.notes !== undefined) { fields.push('notes = ?'); values.push(patch.notes); }
  if (patch.limits?.maxUsers !== undefined) { fields.push('max_users = ?'); values.push(Number(patch.limits.maxUsers)); }
  if (patch.limits?.maxProducts !== undefined) {
    fields.push('max_products = ?');
    values.push(Number(patch.limits.maxProducts));
  }

  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    await db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...values, row.id);
  }

  if (Array.isArray(patch.modules)) {
    assertValidModules(patch.modules);
    await db.prepare('DELETE FROM tenant_modules WHERE tenant_id = ?').run(row.id);
    for (const module of patch.modules) {
      await db.prepare('INSERT INTO tenant_modules (tenant_id, module) VALUES (?, ?)').run(row.id, module);
    }
  }

  await recordAudit('UPDATE', { tenantId: row.id, actor, detail: patch });
  await forgetTenant(slug);
  return get(slug);
}

async function setStatus(slug, status, action, actor) {
  const row = await requireRow(slug);
  await platformDb().prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), row.id);
  await recordAudit(action, { tenantId: row.id, actor });
  await forgetTenant(slug);
  return get(slug);
}

export const suspend = (slug, actor) => setStatus(slug, 'suspended', 'SUSPEND', actor);
export const resume = (slug, actor) => setStatus(slug, 'active', 'RESUME', actor);

export async function resetAdminPassword(slug, actor = null) {
  const row = await requireRow(slug);
  const connection = await connectionFor(slug, () => openConnection({
    driver: row.driver || 'sqlite', file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  }));

  const generated = generatePassword();
  const hash = bcrypt.hashSync(generated, config.auth.bcryptRounds);
  await runWithTenant({ slug }, connection, async () => {
    const result = await connection.facade.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = 'admin'",
    ).run(hash);
    if (!result.changes) throw new NotFoundError('Administrator account for tenant', slug);
  });

  await recordAudit('RESET_ADMIN_PASSWORD', { tenantId: row.id, actor });
  await forgetTenant(slug);
  return { adminUsername: 'admin', adminPassword: generated };
}

export async function stats(slug) {
  const row = await requireRow(slug);
  const connection = await connectionFor(slug, () => openConnection({
    driver: row.driver || 'sqlite', file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  }));

  return runWithTenant({ slug }, connection, async () => {
    const [users, products, sales30d, lastActivity] = await Promise.all([
      connection.facade.prepare('SELECT COUNT(*) AS n FROM users').get(),
      connection.facade.prepare('SELECT COUNT(*) AS n FROM products').get(),
      connection.facade.prepare(
        "SELECT COUNT(*) AS n FROM sales WHERE datetime(sale_date) >= datetime('now', '-30 days')",
      ).get(),
      connection.facade.prepare('SELECT MAX(created_at) AS at FROM audit_logs').get(),
    ]);
    return {
      users: users.n, products: products.n, sales30d: sales30d.n, lastActivityAt: lastActivity?.at || null,
    };
  });
}

export default {
  list, get, create, update, suspend, resume, resetAdminPassword, stats,
};
