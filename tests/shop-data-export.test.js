/**
 * The shop's own door to its own data — over real HTTP, on both drivers.
 *
 * The bug this suite exists to keep fixed was photographed: a shop owner opened
 * Settings → النسخ الاحتياطية, pressed «إنشاء نسخة احتياطية», and got a red
 * toast reading "Creating a backup is not available on this deployment: the
 * database runs on libsql, where backups and restores are handled by the
 * database provider." — English, on an Arabic screen, telling the owner of a
 * shop that he could not have a copy of his own books.
 *
 * So, in the order they matter:
 *
 *  1. The hosted case — the one in the photograph — DOWNLOADS. The archive is
 *     real, opens, and has the shop's own rows in it.
 *  2. It is the SAME FILE the platform console hands over. Same entries, same
 *     layout, same manifest, built by the same code — the two doors must never
 *     drift into producing different archives.
 *  3. It carries everything EXCEPT the credentials, and says so in the manifest.
 *  4. Only somebody who may take the shop's whole book can take it, and that
 *     right cannot be handed to a cashier by ticking a box.
 *  5. It cannot be pressed forty times: a cooldown and a daily ceiling, both
 *     read from the shop's own audit log.
 *  6. A shop PC keeps everything it had — the local file backup still works
 *     there, and the new door works there too.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'shop-export-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_BACKUPS_DIR = path.join(testDataDir, 'backups');
// Small enough that a few hundred rows are split across several parts, so the
// paging and the multi-part snapshot are genuinely exercised.
process.env.MM_BACKUP_PART_BYTES = '4096';
process.env.MM_BACKUP_CHUNK_BYTES = '8192';
process.env.MM_BACKUP_READ_BATCH = '50';
// The two limits under test. A minute is long enough that nothing in this file
// waits it out by accident, and two-a-day is reached without taking six.
process.env.MM_EXPORT_COOLDOWN_MS = '60000';
process.env.MM_EXPORT_DAILY_LIMIT = '2';

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, openConnection, runWithTenant,
} = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { zipFromBuffer } = await import('../src/shared/zipReader.js');
const { MODULES } = await import('../src/shared/permissions.js');
const { CREDENTIAL_COLUMNS } = await import('../src/platform/snapshot.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
/*
 * Imported down here with the rest: everything above the env vars at the top of
 * this file must NOT reach config/index.js, which reads them once at import.
 */
const { forgetAllIdentities } = await import('../src/api/middleware/identity.js');

let base = '';
let server = null;
let owner = '';

before(async () => {
  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const password = 'shop-export-owner-password';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('export-owner', ?, 'Export Owner', 1, ?)
  `).run(bcrypt.hashSync(password, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'export-owner', password },
  });
  assert.equal(login.status, 200);
  owner = login.cookie;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api(urlPath, { method = 'GET', body, cookie, raw = false } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `ex-${Math.random().toString(36).slice(2)}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (raw) {
    return {
      status: res.status,
      buffer: Buffer.from(await res.arrayBuffer()),
      headers: res.headers,
      cookie: setCookie ? setCookie.split(';')[0] : cookie,
    };
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return {
    status: res.status, data, headers: res.headers, cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

let seq = 0;

/** A shop of the named driver, with its administrator signed in. */
async function makeShop(label, { driver, modules = Object.keys(MODULES) }) {
  seq += 1;
  const slug = `ex-${label}-${seq}`;
  const file = path.join(testDataDir, 'tenants', `${slug}.db`);
  const database = driver === 'libsql'
    ? { mode: 'libsql', url: `file:${file}` }
    : { mode: 'file' };
  const created = await tenantService.create({
    slug,
    nameEn: `${label} shop`,
    nameAr: `متجر ${label}`,
    modules,
    database,
  });
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username: created.adminUsername, password: created.adminPassword },
  });
  assert.equal(login.status, 200, `${slug}: the shop administrator can sign in`);
  return { slug, cookie: login.cookie };
}

async function withShop(slug, fn) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  const connection = await openConnection({
    driver: row.driver, file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  });
  try {
    return await runWithTenant({ slug }, connection, () => fn(connection.facade));
  } finally {
    await connection.close();
  }
}

/** Clients with phone numbers, an employee with a salary, and a photograph. */
async function fillShop(slug, { customers = 120 } = {}) {
  await withShop(slug, async (db) => {
    for (let i = 1; i <= customers; i += 1) {
      await db.prepare(
        'INSERT INTO customers (code, name, phone, city, balance) VALUES (?, ?, ?, ?, ?)',
      ).run(`C-${i}`, `عميل رقم ${i}`, `0100000${String(i).padStart(4, '0')}`, 'Giza', i * 1.5);
    }
    await db.prepare(`
      INSERT INTO products (id, sku_prefix, name_en, name_ar, base_cost, base_price, unit)
      VALUES (1, 'RING', 'Gold ring', 'خاتم ذهب', 100, 250, 'pc')
    `).run();
    await db.prepare(`
      INSERT INTO product_variants (id, product_id, sku, barcode, cost_price, selling_price)
      VALUES (1, 1, 'RING-01', '6221000000001', 100, 250)
    `).run();
    await db.prepare(`
      INSERT INTO employees (code, name, job_title, salary_amount, salary_period)
      VALUES ('E-1', 'مروة', 'Cashier', 6000, 'month')
    `).run();
    await db.prepare(`
      INSERT INTO product_images (id, product_id, data, content_type, byte_size)
      VALUES (1, 1, ?, 'image/jpeg', 9)
    `).run(Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 0x01, 0x02, 0xFD, 0xFE, 0xFF]));
  });
}

/** Creates a user under `role` (by role code) in this shop and signs them in. */
async function userWithRole(slug, adminCookie, roleCode, username) {
  const roles = await api(`/t/${slug}/api/users/roles`, { cookie: adminCookie });
  const role = roles.data.rows.find((r) => r.code === roleCode);
  assert.ok(role, `role "${roleCode}" exists`);
  const created = await api(`/t/${slug}/api/users`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username, full_name: username, password: 'password123', role_id: role.id,
    },
  });
  assert.equal(created.status, 201, `user ${username} created`);
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST', body: { username, password: 'password123' },
  });
  assert.equal(login.status, 200);
  return { cookie: login.cookie, roleId: role.id };
}

const exportFor = (slug, cookie) => api(`/t/${slug}/api/settings/data-export`, {
  method: 'POST', cookie, raw: true,
});

/** Move every export this shop has recorded back in time, so a limit lifts. */
const backdateExports = (slug, minutes) => withShop(slug, (db) => db.prepare(`
  UPDATE audit_logs SET created_at = ?
   WHERE entity_type = 'data_export' AND action = 'EXPORT'
`).run(new Date(Date.now() - minutes * 60_000).toISOString()));

/* ══════════════════════════════════════════ 1. the screen in the photograph */

test('the hosted shop: the old refusal is gone, in both halves of what was wrong with it', async () => {
  const { slug, cookie } = await makeShop('photo', { driver: 'libsql' });
  await fillShop(slug, { customers: 10 });

  // The screen asks this before it draws anything, and the answer is what tells
  // it not to offer a file copy that cannot work here.
  const listing = await api(`/t/${slug}/api/settings/backups`, { cookie });
  assert.equal(listing.status, 200);
  assert.equal(listing.data.fileBackups, false, 'a hosted shop has no file to copy');
  assert.equal(listing.data.driver, 'libsql');

  // The old button's route still refuses — there really is no file — but it now
  // carries a CODE, which is what lets the screen say it in Arabic, and the
  // sentence points at the door that does work instead of at the provider.
  const fileCopy = await api(`/t/${slug}/api/settings/backups`, { method: 'POST', cookie });
  assert.equal(fileCopy.status, 400);
  assert.equal(fileCopy.data.error.code, 'FILE_BACKUP_UNAVAILABLE');
  assert.ok(
    !/handled by the database provider/i.test(fileCopy.data.error.message),
    'the sentence that told an owner his data was somebody else\'s business is gone',
  );

  // And the thing the owner was actually asking for happens.
  const download = await exportFor(slug, cookie);
  assert.equal(download.status, 200, 'the hosted shop can download its own data');
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /attachment; filename=".*\.zip"/);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.ok(download.buffer.length > 1000, 'and it is a real file');

  const archive = zipFromBuffer(download.buffer);
  const names = await archive.names();
  assert.ok(names.includes('README.txt'));
  assert.ok(names.some((n) => n.startsWith('snapshot/customers.')), 'the clients are in it');
  assert.ok(names.some((n) => n.endsWith('-ar.xlsx')), 'the Arabic workbook is in it');
  assert.ok(names.some((n) => n.endsWith('-en.xlsx')), 'and the English one');

  // The workbook is a real xlsx with this shop's own Arabic rows in it.
  const arabic = names.find((n) => n.endsWith('-ar.xlsx'));
  const workbook = zipFromBuffer(await archive.read(arabic));
  const parts = await workbook.names();
  assert.ok(parts.includes('[Content_Types].xml'));
  assert.ok(parts.includes('xl/workbook.xml'));
  const clients = (await workbook.read('xl/worksheets/sheet3.xml')).toString('utf8');
  assert.match(clients, /عميل رقم 1/, 'the shop\'s own clients, in Arabic');
  assert.match(clients, /rightToLeft="1"/, 'and the sheet reads right to left');

  const readme = (await archive.read('README.txt')).toString('utf8');
  assert.match(readme, /العربية/, 'the README speaks Arabic too');
  assert.match(readme, /NOT INCLUDED/, 'and says what this copy leaves out');
  assert.match(readme, /غير مُضمَّن/, 'in both languages');
});

/* ══════════════════════════════ 2. the same file the console hands over */

test('the shop\'s own copy is the same archive the platform console produces', async () => {
  const { slug, cookie } = await makeShop('shape', { driver: 'libsql' });
  await fillShop(slug, { customers: 40 });

  const mine = zipFromBuffer((await exportFor(slug, cookie)).buffer);

  // The console's copy of the same shop, taken and downloaded the long way.
  const taken = await api(`/api/platform/tenants/${slug}/backups`, { method: 'POST', cookie: owner });
  assert.equal(taken.status, 201, JSON.stringify(taken.data));
  const ticket = await api(`/api/platform/tenants/${slug}/backups/${taken.data.id}/download-ticket`, {
    method: 'POST', cookie: owner,
  });
  const theirs = zipFromBuffer(
    (await api(`/api/platform/backups/download/${ticket.data.token}`, { cookie: owner, raw: true })).buffer,
  );

  /** Entry names with the part number and the shop's own slug taken out. */
  const shape = (names) => new Set(names
    .map((name) => name.replace(/\.\d{4}\.jsonl$/, '.jsonl'))
    .map((name) => name.replace(/spreadsheets\/.*-(ar|en)\.xlsx/, 'spreadsheets/$1.xlsx'))
    .sort());

  assert.deepEqual(
    shape(await mine.names()),
    shape(await theirs.names()),
    'both doors produce the same archive: same README, same snapshot, same two workbooks',
  );

  const mineManifest = await mine.readJson('snapshot/manifest.json');
  const theirsManifest = await theirs.readJson('snapshot/manifest.json');
  assert.equal(mineManifest.format, theirsManifest.format);
  assert.equal(mineManifest.formatVersion, theirsManifest.formatVersion);
  assert.deepEqual(
    mineManifest.tables.map((table) => table.name).sort(),
    theirsManifest.tables.map((table) => table.name).sort(),
    'and the same tables, so `restore-shop.js --file` reads either one',
  );
  assert.equal(mineManifest.shop.slug, slug);
  assert.equal(mineManifest.shop.installId, theirsManifest.shop.installId,
    'both name the same database, so neither can be restored into another shop');
});

/* ═══════════════════════════════ 3. everything except the credentials */

test('the shop\'s copy carries every row and no password hash', async () => {
  const { slug, cookie } = await makeShop('secrets', { driver: 'libsql' });
  await fillShop(slug, { customers: 30 });

  const archive = zipFromBuffer((await exportFor(slug, cookie)).buffer);
  const users = (await archive.read('snapshot/users.0001.jsonl')).toString('utf8');
  assert.ok(!/\$2[aby]\$/.test(users), 'no bcrypt hash travels in a file kept on a laptop');
  assert.match(users, /__REDACTED__/, 'and the column is visibly blanked rather than dropped');

  // Everything else is there — including the things that make this the shop's
  // book rather than a summary of it.
  const customers = (await archive.read('snapshot/customers.0001.jsonl')).toString('utf8');
  assert.match(customers, /01000000001/, 'a client\'s phone number');
  const employees = (await archive.read('snapshot/employees.0001.jsonl')).toString('utf8');
  assert.match(employees, /6000/, 'an employee\'s salary');
  const images = (await archive.names()).filter((n) => n.startsWith('snapshot/product_images.'));
  assert.equal(images.length, 1, 'and the photographs');

  const manifest = await archive.readJson('snapshot/manifest.json');
  assert.deepEqual(manifest.redacted, ['users.password_hash'],
    'the file says what it does not carry, so whatever reads it next can see it');
  assert.equal(manifest.kind, 'shop_export');

  /**
   * The fence, so a credential added to this schema next year does not quietly
   * start travelling in every owner's Downloads folder: every column in the
   * shop's database whose NAME looks like a secret has to be one this export
   * redacts. A new one fails here rather than on somebody's laptop.
   */
  const suspicious = await withShop(slug, async (db) => {
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    const found = [];
    for (const table of tables) {
      const columns = await db.prepare(`PRAGMA table_info("${table.name}")`).all();
      for (const column of columns) {
        if (/password|secret|token|_hash$/i.test(column.name)) {
          found.push(`${table.name}.${column.name}`);
        }
      }
    }
    return found;
  });
  const covered = new Set(Object.entries(CREDENTIAL_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)));
  /**
   * Named one at a time, because "it only looks like a secret" is a claim that
   * should cost somebody a line of typing:
   *
   *   users.must_change_password  a flag, not a password. Removing it would
   *                               lose the fact that an account is on a
   *                               one-time password, which the shop needs back
   *                               if this snapshot is ever restored.
   *
   * `password_reset_requests` carries no secret at all — approving one sets a
   * one-time password on the user and stores nothing — so nothing there is
   * expected here.
   */
  const knownSafe = new Set(['users.must_change_password']);
  for (const column of suspicious) {
    if (knownSafe.has(column)) continue;
    assert.ok(covered.has(column),
      `"${column}" looks like a credential and is not redacted from the shop's own copy — `
      + 'add it to CREDENTIAL_COLUMNS in src/platform/snapshot.js or say why it is safe here');
  }

  // The audit log answers "who took a copy of the whole book, and when".
  const audit = await withShop(slug, (db) => db.prepare(`
    SELECT username, action, module, entity_label FROM audit_logs
     WHERE entity_type = 'data_export' ORDER BY id
  `).all());
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'EXPORT');
  assert.equal(audit[0].module, 'settings');
  assert.ok(audit[0].username, 'and by name');
  assert.match(audit[0].entity_label, /\.zip$/);
});

/* ═══════════════════════════════════════════════ 4. who may take one */

test('only an administrator may take the shop\'s whole book, and it cannot be delegated', async () => {
  const { slug, cookie } = await makeShop('access', { driver: 'libsql' });
  await fillShop(slug, { customers: 5 });

  const cashier = await userWithRole(slug, cookie, 'cashier', 'till-1');
  const manager = await userWithRole(slug, cookie, 'manager', 'boss');

  const asCashier = await exportFor(slug, cashier.cookie);
  assert.equal(asCashier.status, 403, 'a cashier cannot walk out with every salary');
  const asManager = await exportFor(slug, manager.cookie);
  assert.equal(asManager.status, 403, 'and neither can a store manager by default');

  // The role editor is where this would otherwise be ticked in four clicks.
  const granted = await api(`/t/${slug}/api/users/roles/${cashier.roleId}/permissions`, {
    method: 'PUT',
    cookie,
    body: { permissions: ['sales.create', 'settings.export_data'] },
  });
  assert.equal(granted.status, 422, 'it cannot be given to a role at all');
  assert.equal(granted.data.error.code, 'PERMISSION_NOT_DELEGATABLE');

  const stillRefused = await exportFor(slug, cashier.cookie);
  assert.equal(stillRefused.status, 403, 'and the refusal did not half-apply');

  // The administrator, who holds every permission by construction, can.
  assert.equal((await exportFor(slug, cookie)).status, 200);
});

/* ═════════════════════════════════════════════════════ 5. the rate limit */

test('it cannot be pressed forty times: a cooldown, then a daily ceiling', async () => {
  const { slug, cookie } = await makeShop('limits', { driver: 'libsql' });
  await fillShop(slug, { customers: 5 });

  assert.equal((await exportFor(slug, cookie)).status, 200, 'the first one works');

  const tooSoon = await api(`/t/${slug}/api/settings/data-export`, { method: 'POST', cookie });
  assert.equal(tooSoon.status, 429, 'the second, straight away, does not');
  assert.equal(tooSoon.data.error.code, 'EXPORT_RATE_LIMITED');
  assert.equal(tooSoon.data.error.details.reason, 'cooldown');
  assert.ok(tooSoon.data.error.details.retryAfterSeconds > 0,
    'and the screen is told how long to wait, as a number it can put in a sentence');
  assert.ok(tooSoon.headers.get('retry-after'), 'the header says it too');

  // Wait it out (without waiting): the cooldown has passed, the ceiling has not.
  await backdateExports(slug, 5);
  assert.equal((await exportFor(slug, cookie)).status, 200, 'after the cooldown, the second one works');

  await backdateExports(slug, 5);
  const capped = await api(`/t/${slug}/api/settings/data-export`, { method: 'POST', cookie });
  assert.equal(capped.status, 429, 'but two a day is two a day');
  assert.equal(capped.data.error.details.reason, 'daily');
  assert.equal(capped.data.error.details.limit, 2);

  // The status the screen shows before anybody presses anything agrees.
  const status = await api(`/t/${slug}/api/settings/data-export`, { cookie });
  assert.equal(status.data.usedToday, 2);
  assert.equal(status.data.dailyLimit, 2);
  assert.ok(status.data.retryAfterSeconds > 0);
  assert.deepEqual(status.data.redacted, ['users.password_hash']);
});

/* ══════════════════════════════════════════════════ 6. the shop PC case */

test('a shop on its own PC keeps its file backups AND gains the new door', async () => {
  const { slug, cookie } = await makeShop('onprem', { driver: 'sqlite' });
  await fillShop(slug, { customers: 20 });

  const listing = await api(`/t/${slug}/api/settings/backups`, { cookie });
  assert.equal(listing.data.fileBackups, true, 'there is a file here, so the file copy is offered');

  const made = await api(`/t/${slug}/api/settings/backups`, { method: 'POST', cookie });
  assert.equal(made.status, 201, 'and it still works exactly as it did');
  assert.ok(made.data.file.endsWith('.db'));

  const after = await api(`/t/${slug}/api/settings/backups`, { cookie });
  assert.ok(after.data.rows.some((row) => row.file === made.data.file), 'and is listed');

  // The new door works here too, on the driver that has a file — the two paths
  // are separate answers to separate questions, not one replacing the other.
  const download = await exportFor(slug, cookie);
  assert.equal(download.status, 200);
  const archive = zipFromBuffer(download.buffer);
  const names = await archive.names();
  assert.ok(names.includes('README.txt'));
  assert.ok(names.some((n) => n.endsWith('-ar.xlsx')));
  const manifest = await archive.readJson('snapshot/manifest.json');
  assert.equal(manifest.shop.driver, 'sqlite');
  assert.deepEqual(manifest.redacted, ['users.password_hash']);
});

/* ═══════════════════════════════════════ 7. the shops that already exist */

test('a shop created before this release gains the permission from migration 017', async () => {
  const { slug, cookie } = await makeShop('upgrade', { driver: 'libsql' });
  await fillShop(slug, { customers: 5 });

  // Wind this shop back to what it looked like before the release: the code
  // does not exist, nobody holds it, and the migration has not run. This is
  // every shop on the fleet on the morning of the deploy — `seedBaseline()`
  // does not run again on a database that has users, and
  // `syncPermissionCatalogue()` never runs against a tenant's database at all.
  await withShop(slug, async (db) => {
    await db.prepare(`
      DELETE FROM role_permissions
       WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'settings.export_data')
    `).run();
    await db.prepare("DELETE FROM permissions WHERE code = 'settings.export_data'").run();
    await db.prepare("DELETE FROM schema_migrations WHERE name = '017-shop-data-export'").run();
  });
  /*
   * That was a hand-edit straight into the database, behind the application's
   * back. The request path keeps a few seconds of what each caller may do (see
   * api/middleware/identity.js) and has no way to know a permission row was
   * deleted underneath it, so the cache is dropped here - exactly as a real
   * deploy would, by restarting the process.
   */
  forgetAllIdentities();

  const before = await exportFor(slug, cookie);
  assert.equal(before.status, 403,
    'without the migration the button is visible and answers 403 — the failure this migration exists to prevent');

  await withShop(slug, () => runMigrations());

  const after = await exportFor(slug, cookie);
  assert.equal(after.status, 200, 'the fleet migration hands the shop its own door');

  // And only to the administrator: the migration grants no other role.
  const holders = await withShop(slug, (db) => db.prepare(`
    SELECT r.code FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE p.code = 'settings.export_data'
  `).all());
  assert.deepEqual(holders.map((row) => row.code), ['admin']);
});

/* ═════════════════════════════════ 8. a package that did not include settings */

test('a shop can take its own data out even on a plan without the settings module', async () => {
  const { slug, cookie } = await makeShop('nosettings', {
    driver: 'libsql',
    modules: Object.keys(MODULES).filter((module) => module !== 'settings'),
  });
  await fillShop(slug, { customers: 5 });

  // The module really is off: the ordinary settings routes refuse.
  const settings = await api(`/t/${slug}/api/settings`, { cookie });
  assert.equal(settings.status, 403);
  assert.equal(settings.data.error.code, 'MODULE_NOT_ENABLED');

  // And the shop's own data still comes out, because that is not a feature that
  // is sold — it is the promise the rest is sold on top of.
  const download = await exportFor(slug, cookie);
  assert.equal(download.status, 200);
  assert.ok(zipFromBuffer(download.buffer));

  // The RBAC half is untouched: a cashier here is refused like anywhere else.
  const cashier = await userWithRole(slug, cookie, 'cashier', 'till-9');
  assert.equal((await exportFor(slug, cashier.cookie)).status, 403);
});
