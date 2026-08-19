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
import turso from './turso.js';
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

/**
 * Addresses a libSQL database can actually live at.
 *
 * `libsql://` and `https://` are the two Turso hands out. `file:` is here
 * because the driver treats a local libSQL file exactly like a remote one —
 * that is what lets the hosted path be exercised without a Turso account (see
 * tests/platform-hosted.test.js). Everything else — a Postgres URL, a bare
 * hostname, a dashboard link pasted out of a browser — is rejected before a
 * single byte is sent anywhere.
 */
const DATABASE_URL_RE = /^(libsql:\/\/|https:\/\/|file:)/i;

function assertValidDatabaseUrl(url) {
  if (!url) throw new ValidationError('A database URL is required to attach an existing database');
  if (!DATABASE_URL_RE.test(url)) {
    throw new ValidationError(
      `"${url}" is not a database address — it must start with libsql:// or https:// `
      + '(Turso shows both on the database\'s page)',
    );
  }
}

/**
 * Two tenants sharing one database is the single way this architecture's
 * isolation can be defeated: separate databases are what make a forgotten
 * `WHERE tenant_id = ?` impossible, and a shared URL quietly undoes that for
 * both shops at once. Compared on a canonical form so a trailing slash or a
 * capitalised host cannot slip past, and the refusal names the tenant already
 * using it — an owner who sees "already used by mm" knows immediately whether
 * they pasted the wrong URL or are about to merge two shops.
 */
const canonicalUrl = (url) => String(url || '').trim().toLowerCase().replace(/\/+$/, '');

async function assertDatabaseNotShared(url) {
  const rows = await platformDb()
    .prepare('SELECT slug, db_url FROM tenants WHERE db_url IS NOT NULL AND db_url != \'\'').all();
  const wanted = canonicalUrl(url);
  const clash = rows.find((row) => canonicalUrl(row.db_url) === wanted);
  if (clash) {
    throw new ConflictError(
      `That database is already used by tenant "${clash.slug}" — two shops must never share one database`,
    );
  }
}

/** Tokens are secrets: if a driver ever quoted one back at us, it stops here. */
function redactToken(message, authToken) {
  const text = String(message || '').split('\n')[0].trim();
  return authToken ? text.replaceAll(authToken, '***') : text;
}

/**
 * Open a libSQL database and prove it answers, so a wrong URL or a rejected
 * token surfaces as one sentence a shop owner can act on rather than as a
 * driver stack trace thrown from the middle of a DDL batch.
 *
 * The sentence differs by mode because the owner's next move does: one of them
 * typed a URL and can check it, the other typed a shop name and can only try
 * again.
 */
async function connectDatabase({ mode, url, authToken }) {
  let connection = null;
  try {
    connection = await openConnection({ driver: 'libsql', url, authToken });
    await connection.facade.prepare('SELECT 1 AS ok').get();
    return connection;
  } catch (error) {
    if (connection) {
      try { await connection.close(); } catch { /* it never opened; nothing to salvage */ }
    }
    const detail = redactToken(error.message, authToken);
    throw new ValidationError(
      mode === 'auto'
        ? `The new database could not be opened yet — nothing was kept, please try again. (${detail})`
        : 'Could not connect to that database — check the URL and the auth token. '
          + `(${detail})`,
    );
  }
}

/**
 * Where this tenant's data will live. The three modes are the difference
 * between "make me a database", "here is one already", and "put it on this PC":
 *
 *   { mode: 'auto' }                    a database Turso makes for this shop
 *   { mode: 'libsql', url, authToken }  an existing database, attached as-is
 *   { mode: 'file' }                    a new SQLite file under `tenantsDir`
 *
 * Only the file mode touches the disk — and only to check that it is not about
 * to overwrite something. `auto` cannot be resolved here at all: its URL and
 * token do not exist until Turso has been asked, which is a step `create()`
 * runs itself so that it can also undo it.
 */
function resolveDatabaseTarget(slug, database) {
  const mode = database?.mode || 'file';

  if (mode === 'file') {
    fs.mkdirSync(config.platform.tenantsDir, { recursive: true });
    const file = path.join(config.platform.tenantsDir, `${slug}.db`);
    if (fs.existsSync(file)) {
      throw new ConflictError(`A database file already exists for "${slug}" — remove it before retrying`);
    }
    return { mode, driver: 'sqlite', file, url: null, authToken: null };
  }

  if (mode === 'auto') {
    if (!turso.canProvision()) {
      throw new ValidationError(
        'This deployment cannot create a database by itself yet — add TURSO_API_TOKEN and TURSO_ORG '
        + 'to it, or choose an existing database and paste its URL instead',
      );
    }
    return {
      mode, driver: 'libsql', file: null, url: null, authToken: null, name: turso.databaseName(slug),
    };
  }

  if (mode !== 'libsql') {
    throw new ValidationError(`Unknown database mode "${mode}" — use "auto", "file" or "libsql"`);
  }

  const url = String(database.url || '').trim();
  assertValidDatabaseUrl(url);
  return {
    mode, driver: 'libsql', file: null, url, authToken: String(database.authToken || '').trim() || null,
  };
}

function toView(row, modules) {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    status: row.status,
    driver: row.driver,
    /**
     * Where this shop's data lives. `hasAuthToken` rather than the token
     * itself: the dashboard only ever needs to know whether one is set, and a
     * token that is never sent back cannot be read out of a browser tab, a
     * proxy log or a screenshot.
     */
    database: {
      driver: row.driver,
      url: row.db_url || null,
      file: row.db_file || null,
      hasAuthToken: Boolean(row.db_auth_token),
    },
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
 * Provision a tenant end to end: the control-plane row, its database, schema,
 * migrations, and — only if that database turns out to be empty — the baseline
 * seed, the shop's own name and a fresh admin password nobody chose, returned
 * once and stored nowhere in the clear.
 *
 * `input.database` says where the data lives. `{ mode: 'file' }` is the default
 * and today's behaviour. `{ mode: 'libsql', url, authToken }` attaches a
 * database that already exists — which is how a shop that is already serving
 * customers joins the platform without moving a byte. `{ mode: 'auto' }` asks
 * Turso for a new one, so the owner types a shop name and nothing else; it
 * exists only to produce a URL and a token, and from the moment it has them it
 * is the attach path, step for step.
 *
 * Whether to seed is decided by what is in the database, never by a flag the
 * caller passes. A caller who ticks the wrong box in a form should not be able
 * to overwrite a live shop, so the question asked is "are there users in here?"
 * and the answer comes from the database itself:
 *
 *   no users    -> a new shop: seed the baseline, return a one-time password
 *   users exist -> an existing shop: seed nothing, touch no settings, and
 *                  report back what was found so the caller can see that
 *                  nothing was lost
 *
 * Rollback differs for the same reason, and the difference is about ownership,
 * not about drivers. A file this call created is deleted on failure, and so is
 * a Turso database this call created — neither has ever held anybody's data. An
 * *attached* database is never deleted, never truncated and never altered on
 * failure, however far provisioning got: a failed attach leaves the customer's
 * data exactly as it was found, and only the control-plane row is removed.
 */
export async function create(input, actor = null) {
  const {
    slug, nameEn, nameAr, modules = [], limits = {}, websiteEnabled = true, database,
  } = input || {};

  assertValidSlug(slug);
  if (!nameEn || !String(nameEn).trim()) throw new ValidationError('nameEn is required');
  assertValidModules(modules);

  if (await findRow(slug)) throw new ConflictError(`Tenant "${slug}" already exists`);

  const target = resolveDatabaseTarget(slug, database);
  if (target.mode === 'libsql') await assertDatabaseNotShared(target.url);

  const db = platformDb();
  const now = new Date().toISOString();
  let tenantId = null;
  let fileCreated = false;
  /**
   * The name of a database *this call* asked Turso for, and nothing else. Set
   * only once Turso confirms it exists, so the rollback can tell a database
   * that is seconds old and has never been used from a customer's own.
   */
  let createdDatabase = null;

  try {
    if (target.mode === 'auto') {
      const created = await turso.createDatabase(target.name);
      createdDatabase = created.name;
      target.url = turso.databaseUrl(created.hostname);
      target.authToken = await turso.createDatabaseToken(created.name);
      // Belt and braces on the one invariant that cannot be recovered from: a
      // name Turso says is free should never collide, but if it somehow does,
      // failing here (and deleting what was just made) beats two shops reading
      // one database.
      await assertDatabaseNotShared(target.url);
    }

    const inserted = await db.prepare(`
      INSERT INTO tenants (slug, name_en, name_ar, status, driver, db_file, db_url, db_auth_token,
                            website_enabled, max_users, max_products, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slug, nameEn, nameAr || nameEn, target.driver, target.file, target.url, target.authToken,
      websiteEnabled ? 1 : 0,
      Number(limits.maxUsers || 0), Number(limits.maxProducts || 0), now, now,
    );
    tenantId = inserted.lastInsertRowid;

    for (const module of modules) {
      await db.prepare('INSERT INTO tenant_modules (tenant_id, module) VALUES (?, ?)').run(tenantId, module);
    }

    let connection;
    if (target.driver === 'libsql') {
      connection = await connectDatabase(target);
    } else {
      connection = await openConnection({ driver: 'sqlite', file: target.file });
      fileCreated = true;
    }

    let provisioned;
    try {
      provisioned = await runWithTenant(
        { slug, modules: new Set(modules), limits, websiteEnabled },
        connection,
        async () => {
          // Applied to both kinds of database. Every statement is
          // `CREATE … IF NOT EXISTS`, so a database that already has the
          // schema is unchanged by this and one that is missing a newer table
          // gains it.
          await connection.applySchema();
          await runMigrations();

          const existing = await connection.facade.prepare('SELECT COUNT(*) AS n FROM users').get();
          if (existing.n > 0) return adoptExisting(connection.facade, existing.n);

          await seedBaseline();
          const generated = generatePassword();
          const hash = bcrypt.hashSync(generated, config.auth.bcryptRounds);
          await connection.facade.prepare(
            "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE username = 'admin'",
          ).run(hash);
          await connection.facade.prepare("UPDATE settings SET value = ? WHERE key = 'company.name'").run(nameEn);
          await connection.facade.prepare("UPDATE settings SET value = ? WHERE key = 'company.name_ar'")
            .run(nameAr || nameEn);
          return { adopted: false, adminPassword: generated };
        },
      );
    } finally {
      await connection.close();
    }

    await recordAudit(provisioned.adopted ? 'ADOPT' : 'CREATE', {
      tenantId,
      actor,
      // The URL is fine to keep; the token is a secret and is never written
      // to an audit row, a log line or a response.
      detail: { slug, driver: target.driver, url: target.url },
    });
    // A negative lookup could have been cached by a request that raced this
    // creation; drop it so the tenant is reachable immediately.
    await forgetTenant(slug);

    if (provisioned.adopted) {
      return {
        slug, id: tenantId, adopted: true, users: provisioned.users, products: provisioned.products,
      };
    }
    return {
      slug, id: tenantId, adminUsername: 'admin', adminPassword: provisioned.adminPassword,
    };
  } catch (error) {
    if (tenantId) {
      try {
        await db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId);
      } catch { /* the file cleanup below still runs even if this fails */ }
    }
    // Only ever a file this call made. An attached database belongs to the
    // customer — deleting or emptying it because provisioning failed would
    // destroy exactly the data this feature exists to preserve.
    if (target.mode === 'file' && (fileCreated || fs.existsSync(target.file))) {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${target.file}${suffix}`;
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
    }
    /**
     * The asymmetry, in one place. `createdDatabase` is set on exactly one
     * path — a database this call made seconds ago, that no shop has ever been
     * pointed at and that contains nothing but a schema. Leaving it behind
     * would bill the owner for an empty database and block the retry, since the
     * next attempt would find the name taken. So it goes.
     *
     * A customer's own database never reaches this line: `mode: 'libsql'`
     * leaves `createdDatabase` null no matter what failed or how late, which is
     * what makes "we never delete a customer's data" a property of the code
     * rather than a promise.
     */
    if (createdDatabase) {
      try {
        await turso.deleteDatabase(createdDatabase);
      } catch { /* the failure that got us here is the one worth reporting */ }
    }
    throw error;
  }
}

/**
 * An existing shop, joining as it is. Nothing is written — this only reads back
 * enough for the caller to show that nothing was lost.
 */
async function adoptExisting(facade, users) {
  const products = await facade.prepare('SELECT COUNT(*) AS n FROM products').get();
  return { adopted: true, users, products: products.n };
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
