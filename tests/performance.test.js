/**
 * The two things that make this system feel fast, fenced so they stay done.
 *
 * 1. COMPRESSION. The shop was sending 423KB of raw CSS and JavaScript to every
 *    phone that opened it. Nothing about that was visible in a test - the page
 *    worked, the bytes were correct, there were just a great many of them - so
 *    it survived every release until somebody measured. These tests assert the
 *    wire, not the page: what encoding came back, how many bytes, and that the
 *    bytes still decode to exactly what the file says.
 *
 * 2. THE IDENTITY CACHE. `authenticate` used to read the user row and that
 *    user's permissions on EVERY request - two network round trips per call on
 *    the hosted database, four screens' worth on one page load. They are now
 *    remembered for a few seconds, which buys speed with a window in which a
 *    revoked permission could still be honoured. These tests are about closing
 *    that window: a disabled account, a changed role and a migration that grants
 *    a permission must all take effect on the NEXT request, not eight seconds
 *    later. If one of these ever fails, the cache is a security bug, not an
 *    optimisation.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'performance-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DATA_DIR = dir;
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const express = (await import('express')).default;
const compress = (await import('../src/api/middleware/compress.js')).default;
const {
  initDb, closeDb, getDb, applySchema,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const repositories = (await import('../src/infrastructure/repositories/index.js')).default;
const { forgetAllIdentities } = await import('../src/api/middleware/identity.js');

await initDb();
await applySchema();
await seedBaseline();
await runMigrations();
const app = createApp();
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ══════════════════════════════════════════════════════ 1. what goes on the wire */

/*
 * `fetch()` decodes content-encoding transparently and leaves the header in
 * place, so it cannot answer "what actually went over the wire" - it reports
 * brotli and hands back decoded bytes, which is precisely the shape of a test
 * that passes while nothing is being compressed. So this reads the socket.
 */
function wire(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}${pathname}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          encoding: res.headers['content-encoding'] || null,
          vary: res.headers.vary || '',
          bytes: body.length,
          body,
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('a stylesheet arrives compressed, and decodes to exactly the file on disk', async () => {
  const onDisk = fs.readFileSync(path.join(here, '..', 'public', 'shop', 'shop.css'));

  const br = await wire('/shop/shop.css', { 'accept-encoding': 'br' });
  assert.equal(br.status, 200);
  assert.equal(br.encoding, 'br', 'brotli was offered and should have been used');
  assert.ok(br.bytes < onDisk.length / 2,
    `compression should more than halve it: ${onDisk.length} → ${br.bytes}`);
  assert.deepEqual(zlib.brotliDecompressSync(br.body), onDisk,
    'the customer must receive the stylesheet, not an approximation of it');

  const gz = await wire('/shop/shop.css', { 'accept-encoding': 'gzip' });
  assert.equal(gz.encoding, 'gzip');
  assert.deepEqual(zlib.gunzipSync(gz.body), onDisk);

  // A shared cache that ignored this would hand brotli to a client that cannot
  // read it, which looks like a corrupt stylesheet rather than a caching bug.
  assert.match(br.vary || '', /accept-encoding/i);
});

test('a client that did not ask is not given compressed bytes', async () => {
  const onDisk = fs.readFileSync(path.join(here, '..', 'public', 'shop', 'shop.css'));
  const plain = await wire('/shop/shop.css', { 'accept-encoding': 'identity' });
  assert.equal(plain.encoding, null);
  assert.deepEqual(plain.body, onDisk);
});

test('an API answer is compressed too, and is still the same JSON', async () => {
  const res = await wire('/api/shop/config', { 'accept-encoding': 'gzip' });
  assert.equal(res.encoding, 'gzip');
  const parsed = JSON.parse(zlib.gunzipSync(res.body).toString('utf8'));
  assert.equal(typeof parsed, 'object');
});

test('already-compressed bytes are left alone', async () => {
  /*
   * Running a PNG through gzip spends CPU to make it very slightly bigger. The
   * favicon is the smallest such file that is always present.
   */
  const shot = await wire('/shop/favicon.ico', { 'accept-encoding': 'br, gzip' })
    .catch(() => null);
  if (shot && shot.status === 200) {
    assert.equal(shot.encoding, null, 'an icon must not be re-compressed');
  }
});

test('a very large response is not held in memory to be compressed', async () => {
  /*
   * Compressing means buffering. A shop asking for a CSV of everything it has
   * ever sold must not be answered by a function that first tries to hold the
   * whole file in memory - so past a ceiling the response gives up on
   * compression and streams instead. This runs on its own little app, because
   * the real one answers an unknown path with the SPA rather than a 404, and a
   * route added after the catch-all is never reached.
   */
  const tiny = express();
  tiny.use(compress());
  tiny.get('/big', (_req, res) => {
    res.type('text/plain');
    for (let i = 0; i < 9; i += 1) res.write('x'.repeat(1024 * 1024));
    res.end();
  });
  const listening = await new Promise((resolve) => {
    const s = tiny.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = listening.address().port;

  const answer = await new Promise((resolve, reject) => {
    const request = http.request(
      `http://127.0.0.1:${port}/big`,
      { headers: { 'accept-encoding': 'gzip, br' } },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => { bytes += chunk.length; });
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'] || null, bytes }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  await new Promise((resolve) => listening.close(resolve));

  assert.equal(answer.encoding, null, 'past the ceiling it must stream, uncompressed');
  assert.equal(answer.bytes, 9 * 1024 * 1024, 'and every byte must still arrive');
});

/* ═══════════════════════════════════════════ 2. the window the cache opens */

const login = async (username, password) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { status: res.status, cookie };
};

const asUser = (cookie, pathname) => fetch(`${base}${pathname}`, { headers: { cookie } });

test('a disabled account cannot keep working off a cached identity', async () => {
  const { cookie, status } = await login('admin', 'admin123');
  assert.equal(status, 200, 'the seeded administrator should be able to sign in');

  assert.equal((await asUser(cookie, '/api/auth/me')).status, 200);
  // Warm the cache thoroughly: several requests in a row, as one screen makes.
  for (let i = 0; i < 3; i += 1) await asUser(cookie, '/api/products?page=1');

  const admin = await repositories.users.findByUsername('admin');
  await repositories.users.update(admin.id, { is_active: 0 });

  const after = await asUser(cookie, '/api/products?page=1');
  assert.equal(after.status, 401,
    'the account was switched off — the very next request must be refused');

  await repositories.users.update(admin.id, { is_active: 1 });
  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 200,
    'and switching it back on must work just as promptly');
});

test('a permission taken away is gone on the next request', async () => {
  const { cookie } = await login('admin', 'admin123');
  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 200);

  const admin = await repositories.users.findByUsername('admin');
  const db = getDb();
  const role = await db.prepare('SELECT role_id FROM users WHERE id = ?').get(admin.id);
  const kept = (await db.prepare(`
    SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ?
  `).all(role.role_id)).map((r) => r.code).filter((code) => code !== 'products.view');

  await repositories.roles.setPermissions(role.role_id, kept);
  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 403,
    'the role lost products.view — the next request must be refused');

  await repositories.roles.setPermissions(role.role_id, [...kept, 'products.view']);
  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 200);
});

test('a migration that grants a permission is honoured immediately', async () => {
  /*
   * On the fleet, migrations run lazily - on a tenant's first request after a
   * deploy, with identities already cached from the request before. A migration
   * that hands the administrator a new permission (017 and 023 both do) must not
   * be invisible for the life of a cache entry.
   */
  const { cookie } = await login('admin', 'admin123');
  await asUser(cookie, '/api/products?page=1');

  const db = getDb();
  await db.prepare(`
    DELETE FROM role_permissions
     WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'products.view')
  `).run();
  forgetAllIdentities(); // the hand-edit above went behind the application's back
  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 403);

  await db.prepare("DELETE FROM schema_migrations WHERE name = '022-gender-and-offers'").run();
  const granted = await db.prepare('SELECT id FROM permissions WHERE code = ?').get('products.view');
  await db.prepare(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, ? FROM roles r WHERE r.code = 'admin'
  `).run(granted.id);
  // Re-running a migration is what clears the caches, and is the point here.
  await runMigrations();

  assert.equal((await asUser(cookie, '/api/products?page=1')).status, 200,
    'the permission is back and the next request must see it');
});

/* ═══════════════════════════════ 3. the screens are still fetched on demand */

test('neither shell statically imports its screens', () => {
  const erp = fs.readFileSync(path.join(here, '..', 'public', 'js', 'app.js'), 'utf8');
  const shop = fs.readFileSync(path.join(here, '..', 'public', 'shop', 'js', 'main.js'), 'utf8');

  /*
   * One static `import … from './views/…'` is enough to undo this: the browser
   * fetches it before the first screen is drawn, and a shell that imports one
   * view usually grows back to importing all of them.
   */
  const staticViewImports = (source) => source
    .split('\n')
    .filter((line) => /^import[^(]*from\s+'\.\/views\//.test(line.trim()));

  assert.deepEqual(staticViewImports(shop), [],
    'the storefront must fetch a page when it is opened');
  assert.deepEqual(staticViewImports(erp), ["import { renderLogin, promptPasswordChange } from './views/auth.js';"],
    'the ERP may load the sign-in screen up front — it is the first thing drawn — and nothing else');
});
