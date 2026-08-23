/**
 * Per-shop backup, download and restore — over the real HTTP surface, on both
 * drivers, with real shops that have real data in them.
 *
 * The four things this suite exists to prove, in the order they matter:
 *
 *  1. A backup ROUND-TRIPS. Take one, change the shop, restore it, and find the
 *     shop as it was — including the rows that were added after the backup and
 *     must be gone again afterwards. Anything less than this is a file, not a
 *     backup.
 *  2. A snapshot from one shop CANNOT be restored into another. Three
 *     independent refusals are asserted: the listing is scoped by tenant, the
 *     manifest is checked against the target, and the target's own install id
 *     is checked against the archive's.
 *  3. The SIZE CEILING refuses rather than exhausts the function, and leaves
 *     nothing half-written behind.
 *  4. The download is not reachable without both the owner's session AND a
 *     single-use ticket, and the ticket cannot be spent twice.
 *
 * Both drivers, because the whole point of building this was that the shipped
 * `scripts/backup.js` only works on one of them. The libsql shop uses a `file:`
 * URL, which is the same driver a Turso URL uses — see tests/platform-hosted.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-backup-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
// Small enough that a few hundred rows produce several parts and several
// chunks, so the paging, the multi-part snapshot and the chunked store are all
// genuinely exercised rather than trivially skipped.
process.env.MM_BACKUP_PART_BYTES = '4096';
process.env.MM_BACKUP_CHUNK_BYTES = '8192';
process.env.MM_BACKUP_READ_BATCH = '50';

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, openConnection, runWithTenant } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const backupService = await import('../src/platform/BackupService.js');
const { zipFromBuffer } = await import('../src/shared/zipReader.js');
const { MODULES } = await import('../src/shared/permissions.js');

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

  const password = 'backup-test-owner-password';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('backup-owner', ?, 'Backup Owner', 1, ?)
  `).run(bcrypt.hashSync(password, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'backup-owner', password },
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
      'Idempotency-Key': `bk-${Math.random().toString(36).slice(2)}`,
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
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

const console_ = (urlPath, options = {}) => api(urlPath, { ...options, cookie: owner });

async function ok(urlPath, options = {}) {
  const res = await console_(urlPath, options);
  assert.ok(res.status >= 200 && res.status < 300,
    `${options.method || 'GET'} ${urlPath} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/** A shop with a database of the named driver, and a handful of real rows in it. */
async function makeShop(slug, { driver }) {
  const file = path.join(testDataDir, 'tenants', `${slug}.db`);
  const database = driver === 'libsql'
    ? { mode: 'libsql', url: `file:${file}` }
    : { mode: 'file' };
  await tenantService.create({
    slug, nameEn: `${slug} shop`, nameAr: `متجر ${slug}`, modules: Object.keys(MODULES), database,
  });
  return slug;
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

/**
 * Enough rows, in enough tables, that a backup has something to be wrong about:
 * clients with phone numbers, a product with a variant, an employee with a
 * salary, and a photograph — which is the one BLOB in this schema and the one
 * value JSON cannot carry without help.
 */
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
    // A photograph: bytes that must survive base64 and come back identical.
    await db.prepare(`
      INSERT INTO product_images (id, product_id, data, content_type, byte_size)
      VALUES (1, 1, ?, 'image/jpeg', 9)
    `).run(Buffer.from([0xFF, 0xD8, 0xFF, 0x00, 0x01, 0x02, 0xFD, 0xFE, 0xFF]));
  });
}

const countRows = (slug, table) => withShop(slug, async (db) => (
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n
));

/* ═══════════════════════════════════════════════════ the round trip, per driver */

for (const driver of ['sqlite', 'libsql']) {
  test(`${driver}: a backup round-trips — take it, change the shop, restore, and the shop is back`, async () => {
    const slug = `rt-${driver}`;
    await makeShop(slug, { driver });
    await fillShop(slug);

    const before = {
      customers: await countRows(slug, 'customers'),
      products: await countRows(slug, 'products'),
    };
    assert.equal(before.customers, 120);

    const taken = await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' });
    assert.equal(taken.status, 'ready');
    assert.ok(taken.byteSize > 0, 'the backup has bytes');
    assert.ok(taken.rowCount > 120, 'the backup counted more rows than just the clients');

    // The shop moves on: a client is added, one is renamed, a price changes,
    // and a setting is edited. All four must be undone by the restore.
    await withShop(slug, async (db) => {
      await db.prepare("INSERT INTO customers (code, name, phone) VALUES ('C-NEW', 'Added later', '0999')").run();
      await db.prepare("UPDATE customers SET name = 'Renamed' WHERE code = 'C-1'").run();
      await db.prepare('UPDATE product_variants SET selling_price = 999 WHERE id = 1').run();
      await db.prepare("UPDATE settings SET value = 'CHANGED' WHERE key = 'company.name'").run();
      await db.prepare('DELETE FROM product_images WHERE id = 1').run();
    });
    assert.equal(await countRows(slug, 'customers'), 121);

    const planned = await ok(`/api/platform/tenants/${slug}/backups/${taken.id}/restore-plan`, { method: 'POST' });
    assert.equal(planned.plan.before.customers, 121, 'the plan reports what is there now');
    assert.equal(planned.plan.after.customers, 120, 'and what the snapshot holds');

    const restored = await ok(`/api/platform/tenants/${slug}/backups/restore`, {
      method: 'POST', body: { ticket: planned.token, confirmSlug: slug },
    });
    assert.equal(restored.restored, true);
    assert.ok(restored.safetyCopyId, 'a safety copy was taken before the overwrite');

    const after = await withShop(slug, async (db) => ({
      customers: (await db.prepare('SELECT COUNT(*) AS n FROM customers').get()).n,
      added: await db.prepare("SELECT id FROM customers WHERE code = 'C-NEW'").get(),
      first: (await db.prepare("SELECT name FROM customers WHERE code = 'C-1'").get()).name,
      price: (await db.prepare('SELECT selling_price AS p FROM product_variants WHERE id = 1').get()).p,
      company: (await db.prepare("SELECT value AS v FROM settings WHERE key = 'company.name'").get()).v,
      image: await db.prepare('SELECT data FROM product_images WHERE id = 1').get(),
    }));

    assert.equal(after.customers, before.customers, 'the row count is what it was');
    assert.ok(!after.added, 'the client added after the backup is gone');
    assert.equal(after.first, 'عميل رقم 1', 'the renamed client has its Arabic name back');
    assert.equal(after.price, 250, 'the edited price is back');
    assert.equal(after.company, `${slug} shop`, 'the edited setting is back');
    assert.ok(after.image, 'the deleted photograph came back');
    assert.deepEqual(
      [...after.image.data],
      [0xFF, 0xD8, 0xFF, 0x00, 0x01, 0x02, 0xFD, 0xFE, 0xFF],
      'and its bytes are byte-for-byte what they were',
    );

    // The shop is trading again, not left suspended.
    const tenant = await ok(`/api/platform/tenants/${slug}`);
    assert.equal(tenant.status, 'active');
  });
}

/* ══════════════════════════════════════════════════ the downloaded file itself */

test('the downloaded file is a real archive with a readable spreadsheet and a complete snapshot', async () => {
  const slug = 'download-me';
  await makeShop(slug, { driver: 'sqlite' });
  await fillShop(slug, { customers: 120 });

  const taken = await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' });
  const ticket = await ok(`/api/platform/tenants/${slug}/backups/${taken.id}/download-ticket`, { method: 'POST' });
  assert.match(ticket.filename, /^download-me-backup-.*\.zip$/);

  const download = await console_(`/api/platform/backups/download/${ticket.token}`, { raw: true });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="download-me-backup-/);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  // Bigger than what is stored: the workbooks are built on the way out rather
  // than kept — see the measurement in BackupService's header.
  assert.ok(download.buffer.length > taken.byteSize,
    'the delivered file carries more than the stored snapshot');

  const archive = zipFromBuffer(download.buffer);
  const names = await archive.names();
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('spreadsheets/download-me-ar.xlsx'), 'the Arabic workbook is in it');
  assert.ok(names.includes('spreadsheets/download-me-en.xlsx'), 'and the English one');
  assert.ok(names.some((n) => n.startsWith('snapshot/customers.')), 'and the clients');

  const readme = (await archive.read('README.txt')).toString('utf8');
  assert.match(readme, /spreadsheets/);
  assert.match(readme, /العربية/, 'the README speaks Arabic too');

  // The workbook is a real xlsx: a ZIP whose parts are where a reader looks.
  const workbook = zipFromBuffer(await archive.read('spreadsheets/download-me-ar.xlsx'));
  const parts = await workbook.names();
  assert.ok(parts.includes('[Content_Types].xml'));
  assert.ok(parts.includes('xl/workbook.xml'));
  assert.ok(parts.includes('xl/worksheets/sheet3.xml'));
  const sheetNames = (await workbook.read('xl/workbook.xml')).toString('utf8');
  assert.match(sheetNames, /العملاء/, 'the Arabic workbook names its tabs in Arabic');
  const clients = (await workbook.read('xl/worksheets/sheet3.xml')).toString('utf8');
  assert.match(clients, /rightToLeft="1"/, 'and reads right to left');
  assert.match(clients, /عميل رقم 1/, 'and has the shop\'s own clients in it');

  // A password hash is in the snapshot (so a restore can sign people in) and is
  // never in the workbook (so a forwarded spreadsheet is not a cracking job).
  const users = (await archive.read('snapshot/users.0001.jsonl')).toString('utf8');
  assert.match(users, /\$2[aby]\$/, 'the snapshot carries the password hash');
  const usersSheet = (await workbook.read('xl/worksheets/sheet15.xml')).toString('utf8');
  assert.ok(!/\$2[aby]\$/.test(usersSheet), 'the workbook does not');

  // The manifest agrees with what was actually written.
  const manifest = await archive.readJson('snapshot/manifest.json');
  assert.equal(manifest.shop.slug, slug);
  assert.equal(manifest.totals.rows, taken.rowCount);
  const customers = manifest.tables.find((table) => table.name === 'customers');
  assert.equal(customers.rows, 120);
  assert.ok(customers.parts.length >= 2, 'a table larger than one part was split across several');

  // And what is KEPT is the snapshot alone. The workbooks are 84% of a
  // download's bytes and nothing restores from them, so storing them in every
  // nightly copy would spend the control plane's storage on spreadsheets.
  const kept = await backupService.openArchive(taken.id, taken.byteSize);
  const keptNames = await kept.names();
  assert.ok(keptNames.some((n) => n.startsWith('snapshot/')));
  assert.ok(!keptNames.some((n) => n.startsWith('spreadsheets/')),
    'no workbook is stored — it is built on the way out');
});

test('a download ticket is single-use, and the bytes need the console session as well', async () => {
  const slug = 'ticket-rules';
  await makeShop(slug, { driver: 'sqlite' });
  const taken = await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' });
  const ticket = await ok(`/api/platform/tenants/${slug}/backups/${taken.id}/download-ticket`, { method: 'POST' });

  // Without the owner's cookie the ticket is worth nothing at all.
  const anonymous = await api(`/api/platform/backups/download/${ticket.token}`);
  assert.equal(anonymous.status, 401, 'a leaked download link is not a download');

  const first = await console_(`/api/platform/backups/download/${ticket.token}`, { raw: true });
  assert.equal(first.status, 200);

  const second = await console_(`/api/platform/backups/download/${ticket.token}`);
  assert.equal(second.status, 422, 'the same ticket cannot be spent twice');
});

/* ═════════════════════════════════════════════ refusing the wrong shop */

test('a snapshot from another shop is refused three separate ways', async () => {
  const alpha = 'shop-alpha';
  const beta = 'shop-beta';
  await makeShop(alpha, { driver: 'sqlite' });
  await makeShop(beta, { driver: 'sqlite' });
  await fillShop(alpha, { customers: 10 });
  await fillShop(beta, { customers: 3 });

  const alphaBackup = await ok(`/api/platform/tenants/${alpha}/backups`, { method: 'POST' });

  // 1. The listing is scoped by tenant, so alpha's backup does not exist under
  //    beta's slug — the console cannot even offer it.
  const wrongSlug = await console_(`/api/platform/tenants/${beta}/backups/${alphaBackup.id}/restore-plan`, {
    method: 'POST',
  });
  assert.equal(wrongSlug.status, 404, 'alpha\'s backup is not findable under beta');

  const betaList = await ok(`/api/platform/tenants/${beta}/backups`);
  assert.ok(!betaList.rows.some((row) => row.id === alphaBackup.id));

  // 2. The manifest names the shop it came from, checked against the target.
  //    Forced here by re-pointing the row, which is the only way this could
  //    happen in the wild — a backup row moved, or a tenant re-created.
  await platformDb().prepare('UPDATE tenant_backups SET tenant_id = (SELECT id FROM tenants WHERE slug = ?) WHERE id = ?')
    .run(beta, alphaBackup.id);
  const forced = await console_(`/api/platform/tenants/${beta}/backups/${alphaBackup.id}/restore-plan`, {
    method: 'POST',
  });
  assert.equal(forced.status, 422);
  assert.match(forced.data.error.message, /shop-alpha/, 'the refusal names the shop it really came from');

  // 3. And the database's own identity. With the manifest rewritten to claim
  //    beta — which is what an attacker or a corrupted row would look like —
  //    the install id inside beta's database still does not match.
  const stored = await platformDb().prepare('SELECT manifest FROM tenant_backups WHERE id = ?').get(alphaBackup.id);
  const manifest = JSON.parse(stored.manifest);
  const betaRow = await platformDb().prepare('SELECT id FROM tenants WHERE slug = ?').get(beta);
  manifest.shop.slug = beta;
  manifest.shop.tenantId = betaRow.id;
  await platformDb().prepare('UPDATE tenant_backups SET manifest = ?, slug = ? WHERE id = ?')
    .run(JSON.stringify(manifest), beta, alphaBackup.id);

  const lastLine = await console_(`/api/platform/tenants/${beta}/backups/${alphaBackup.id}/restore-plan`, {
    method: 'POST',
  });
  assert.equal(lastLine.status, 422);
  assert.match(lastLine.data.error.message, /different database/i);

  // Beta is untouched by every one of those attempts.
  assert.equal(await countRows(beta, 'customers'), 3);
});

test('restoring needs the shop\'s own name typed, and a ticket that has not been spent', async () => {
  const slug = 'typed-name';
  await makeShop(slug, { driver: 'sqlite' });
  await fillShop(slug, { customers: 5 });
  const taken = await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' });
  const planned = await ok(`/api/platform/tenants/${slug}/backups/${taken.id}/restore-plan`, { method: 'POST' });

  const wrongName = await console_(`/api/platform/tenants/${slug}/backups/restore`, {
    method: 'POST', body: { ticket: planned.token, confirmSlug: 'something-else' },
  });
  assert.equal(wrongName.status, 422);
  assert.match(wrongName.data.error.message, /typed-name/);

  const done = await ok(`/api/platform/tenants/${slug}/backups/restore`, {
    method: 'POST', body: { ticket: planned.token, confirmSlug: slug },
  });
  assert.equal(done.restored, true);

  const replay = await console_(`/api/platform/tenants/${slug}/backups/restore`, {
    method: 'POST', body: { ticket: planned.token, confirmSlug: slug },
  });
  assert.equal(replay.status, 422, 'a restore ticket cannot be replayed');
});

/* ═══════════════════════════════════════════════════════════ the size ceiling */

test('a shop larger than the ceiling is refused, loudly, and leaves nothing behind', async () => {
  const slug = 'too-big';
  await makeShop(slug, { driver: 'sqlite' });
  await fillShop(slug, { customers: 200 });

  const original = process.env.MM_BACKUP_MAX_RAW_BYTES;
  try {
    // Re-read the modules with a ceiling far below what this shop needs. The
    // limits are read at import, so a fresh import is how the ceiling is moved.
    process.env.MM_BACKUP_MAX_RAW_BYTES = '2048';
    process.env.MM_BACKUP_MAX_BYTES = '2048';
    const scoped = await import(`../src/platform/BackupService.js?ceiling=${Date.now()}`);

    await assert.rejects(
      () => scoped.take(slug, { kind: 'manual' }),
      (error) => {
        assert.match(error.message, /larger than one backup may be|MB/,
          'the refusal says what happened in numbers');
        assert.match(error.message, /MM_BACKUP_MAX_BYTES|provider/,
          'and what to do about it');
        return true;
      },
    );
  } finally {
    process.env.MM_BACKUP_MAX_RAW_BYTES = original ?? '';
    delete process.env.MM_BACKUP_MAX_BYTES;
  }

  // A failure is a visible row, not an absence — that is the whole point.
  const listed = await ok(`/api/platform/tenants/${slug}/backups`);
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].status, 'failed');
  assert.equal(listed.rows[0].byteSize, 0);
  assert.ok(listed.rows[0].error, 'and it says why');

  // And nothing half-written is left in the store.
  const chunks = await platformDb().prepare(`
    SELECT COUNT(*) AS n FROM tenant_backup_chunks
     WHERE backup_id IN (SELECT id FROM tenant_backups WHERE slug = ?)
  `).get(slug);
  assert.equal(chunks.n, 0, 'the chunks of the abandoned run were deleted');

  // The fleet view shows this shop as never backed up rather than as fine.
  const fleet = await ok('/api/platform/backups');
  const shop = fleet.shops.find((row) => row.slug === slug);
  assert.equal(shop.lastBackupAt, null);
  assert.ok(shop.lastAttemptAt, 'but it does know an attempt was made');
});

/* ══════════════════════════════════════════════════════════════════ retention */

test('retention keeps the newest of each kind and deletes the bytes of the rest', async () => {
  const slug = 'retained';
  await makeShop(slug, { driver: 'sqlite' });

  const keep = backupService.KEEP.manual;
  const ids = [];
  for (let i = 0; i < keep + 2; i += 1) {
    ids.push((await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' })).id);
  }

  const listed = await ok(`/api/platform/tenants/${slug}/backups`);
  const manual = listed.rows.filter((row) => row.kind === 'manual' && row.status === 'ready');
  assert.equal(manual.length, keep, `only ${keep} manual backups are kept`);
  assert.ok(manual.every((row) => ids.slice(-keep).includes(row.id)), 'and they are the newest');

  const orphans = await platformDb().prepare(`
    SELECT COUNT(*) AS n FROM tenant_backup_chunks
     WHERE backup_id NOT IN (SELECT id FROM tenant_backups)
  `).get();
  assert.equal(orphans.n, 0, 'a pruned backup takes its bytes with it');
});

/* ══════════════════════════════════════════════════════════ who can reach one */

test('nothing about backups is reachable without the owner console session', async () => {
  const slug = 'locked-down';
  await makeShop(slug, { driver: 'sqlite' });
  const taken = await ok(`/api/platform/tenants/${slug}/backups`, { method: 'POST' });

  for (const [method, urlPath] of [
    ['GET', '/api/platform/backups'],
    ['GET', `/api/platform/tenants/${slug}/backups`],
    ['POST', `/api/platform/tenants/${slug}/backups`],
    ['POST', `/api/platform/tenants/${slug}/backups/${taken.id}/download-ticket`],
    ['POST', `/api/platform/tenants/${slug}/backups/${taken.id}/restore-plan`],
    ['POST', `/api/platform/tenants/${slug}/backups/restore`],
  ]) {
    const res = await api(urlPath, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${urlPath} is closed without a session`);
  }

  // An ERP session — even this shop's own administrator — is a different
  // credential and does not open any of it.
  const erp = await api(`/t/${slug}/api/settings/backups`, { method: 'GET' });
  assert.equal(erp.status, 401);
});

/* ═════════════════════════════════════════════════════════ the scheduled job */

test('the scheduled job refuses without CRON_SECRET, and backs up the stalest shop with it', async () => {
  const slug = 'nightly';
  await makeShop(slug, { driver: 'sqlite' });

  const unarmed = await api('/api/cron/backups');
  assert.equal(unarmed.status, 503);
  assert.equal(unarmed.data.error.code, 'CRON_NOT_ARMED');

  const health = await ok('/api/platform/backups');
  assert.equal(health.scheduleArmed, false, 'and the console can see that it is not armed');

  process.env.CRON_SECRET = 'a-secret-only-vercel-has';
  try {
    const wrongSecret = await fetch(`${base}/api/cron/backups`, {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    assert.equal(wrongSecret.status, 401);

    const res = await fetch(`${base}/api/cron/backups`, {
      headers: { authorization: 'Bearer a-secret-only-vercel-has' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ran >= 1, 'it backed something up');
    assert.ok(body.shops.some((shop) => shop.slug === slug && shop.ok),
      'including the shop that had never been backed up');

    const listed = await ok(`/api/platform/tenants/${slug}/backups`);
    assert.equal(listed.rows[0].kind, 'scheduled');

    // Run again immediately: nothing is fresh enough to need another.
    const again = await fetch(`${base}/api/cron/backups`, {
      headers: { authorization: 'Bearer a-secret-only-vercel-has' },
    });
    const second = await again.json();
    assert.ok(!second.shops.some((shop) => shop.slug === slug),
      'a shop backed up minutes ago is skipped rather than backed up twice');
  } finally {
    delete process.env.CRON_SECRET;
  }
});
