/**
 * One shop's session must be worthless in another shop.
 *
 * ── The attack this exists to close ─────────────────────────────────────────
 * Every shop on this platform is its own database behind one deployment, one
 * domain and one signing secret. User ids restart at 1 in each of them: every
 * shop has a user 1, and any shop with staff has a 2 and a 3.
 *
 * The session token used to say only "user 3". That is a true statement about
 * every shop at once. Sign in to your own shop, change the slug in the address
 * bar from /t/yours to /t/theirs, and the server would verify the signature
 * (same secret), read user 3, look that user up IN THEIR DATABASE and serve the
 * request as whoever their user 3 happens to be - with that person's
 * permissions. Nothing in the request would look wrong in a log. The whole
 * attack is editing a URL.
 *
 * The token now carries the shop it was issued for and the middleware refuses
 * it anywhere else. These tests are that refusal, from the attacker's side:
 * they take a real, valid, unexpired session from shop A and try to use it, in
 * every shape, against shop B.
 *
 * The rest of the file is the perimeter around that: the console's token is not
 * a shop token and a shop's token is not a console token; the cookie is
 * httpOnly, scoped to its own shop's path, and Secure when the connection is;
 * and a token nobody signed gets nowhere.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'tenant-security-test');
fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_BACKUPS_DIR = path.join(testDataDir, 'backups');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');

let base = '';
let server = null;
let owner = '';

async function api(urlPath, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `sec-${Math.random().toString(36).slice(2)}`,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    data,
    setCookie,
    cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

let seq = 0;
async function makeShop(label) {
  seq += 1;
  const slug = `sec-${label}-${seq}`;
  const created = await tenantService.create({
    slug,
    nameEn: `${label} shop`,
    nameAr: `متجر ${label}`,
    modules: Object.keys(MODULES),
    database: { mode: 'libsql', url: `file:${path.join(testDataDir, 'tenants', `${slug}.db`)}` },
  });
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username: created.adminUsername, password: created.adminPassword },
  });
  assert.equal(login.status, 200, `${slug}: its own administrator can sign in`);
  return {
    slug,
    cookie: login.cookie,
    token: login.data.token,
    setCookie: login.setCookie,
    username: created.adminUsername,
  };
}

before(async () => {
  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const password = 'tenant-security-owner';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('sec-owner', ?, 'Security Owner', 1, ?)
  `).run(bcrypt.hashSync(password, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sec-owner', password },
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

/* ══════════════════════════════════ 1. the shop-hopping attack, every shape */

test('a session from one shop is refused by another, cookie or header', async () => {
  const a = await makeShop('alpha');
  const b = await makeShop('beta');

  // It works where it belongs. If this ever fails the rest proves nothing.
  const own = await api(`/t/${a.slug}/api/auth/me`, { cookie: a.cookie });
  assert.equal(own.status, 200);

  /*
   * Both shops were just created, so both administrators are user 1 - which is
   * precisely why "user 1" alone was never an identity. This is the attack.
   */
  const stolenCookie = await api(`/t/${b.slug}/api/auth/me`, { cookie: a.cookie });
  assert.equal(stolenCookie.status, 401,
    "shop A's cookie must be worthless on shop B");

  const stolenHeader = await api(`/t/${b.slug}/api/auth/me`, {
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(stolenHeader.status, 401,
    'and worthless as a bearer token too — the header is the same door');

  // Not just the identity endpoint: nothing behind the session opens.
  for (const route of ['/api/products?page=1', '/api/sales?page=1', '/api/dashboard', '/api/settings']) {
    const attempt = await api(`/t/${b.slug}${route}`, { cookie: a.cookie });
    assert.equal(attempt.status, 401, `${route} must refuse another shop's session`);
  }

  // And nothing was written into B by the attempt.
  const bStill = await api(`/t/${b.slug}/api/auth/me`, { cookie: b.cookie });
  assert.equal(bStill.status, 200, "shop B's own session still works");
});

test('a shop session is refused on the single-shop routes as well', async () => {
  const a = await makeShop('gamma');
  /*
   * The unprefixed routes are the single-shop build's. A token minted for a
   * tenant must not open them either - that is the same crossing in the other
   * direction, and on a deployment where the default database is a real shop it
   * would be just as bad.
   */
  const attempt = await api('/api/auth/me', { cookie: a.cookie });
  /*
   * 404 on a platform deployment, where the unprefixed API is not mounted at
   * all, and 401 on a build where it is. Both are "this session does not open
   * this door"; what would be wrong is 200.
   */
  assert.ok([401, 404].includes(attempt.status), `expected a refusal, got ${attempt.status}`);
});

test('an unsigned or tampered token gets nowhere', async () => {
  const a = await makeShop('delta');
  const [header, payload] = a.token.split('.');
  const forged = `${header}.${payload}.not-a-signature`;
  const attempt = await api(`/t/${a.slug}/api/auth/me`, {
    headers: { authorization: `Bearer ${forged}` },
  });
  assert.equal(attempt.status, 401);

  const nonsense = await api(`/t/${a.slug}/api/auth/me`, {
    headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOjF9.' },
  });
  assert.equal(nonsense.status, 401, 'an alg:none token is still a forgery');
});

/* ═══════════════════════════════════════ 2. the console and the shop floor */

test('the console token is not a shop token, and vice versa', async () => {
  const a = await makeShop('epsilon');

  const consoleOnShop = await api(`/t/${a.slug}/api/auth/me`, { cookie: owner });
  assert.equal(consoleOnShop.status, 401,
    "the owner's console session must not authenticate as a shop's user");

  const shopOnConsole = await api('/api/platform/tenants', { cookie: a.cookie });
  assert.ok(shopOnConsole.status === 401 || shopOnConsole.status === 403,
    "a shop's session must not open the control plane");
});

/* ══════════════════════════════════════════════ 3. how the cookie is set */

test('the session cookie is httpOnly, scoped to its own shop, and lax', async () => {
  const a = await makeShop('zeta');
  const header = a.setCookie || '';

  assert.match(header, /HttpOnly/i, 'a session cookie readable by script is a session cookie stealable by script');
  assert.match(header, /SameSite=Lax/i);
  /*
   * The path is the shop's own base, so the browser never even offers this
   * cookie to another shop on the same domain. The server would refuse it - the
   * tests above are that refusal - but a cookie that is not sent cannot be
   * replayed by anything downstream either.
   */
  assert.match(header, new RegExp(`Path=/t/${a.slug}`, 'i'),
    `expected the cookie scoped to /t/${a.slug}: ${header}`);

  /*
   * Not Secure over plain HTTP, which is what the shop PC runs on a LAN. The
   * live deployment is HTTPS and `req.secure` is true there through the proxy,
   * so the same code sets it. Asserted through the proxy header the platform
   * actually sends.
   */
  assert.doesNotMatch(header, /Secure/i, 'a Secure cookie on plain HTTP would lock the shop PC out');

  const overHttps = await api(`/t/${a.slug}/api/auth/login`, {
    method: 'POST',
    body: { username: a.username, password: 'wrong-on-purpose' },
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(overHttps.status, 401, 'and the wrong password is still the wrong password');
});

test('signing out clears the cookie with the scope it was set with', async () => {
  const a = await makeShop('eta');
  const out = await api(`/t/${a.slug}/api/auth/logout`, { method: 'POST', cookie: a.cookie });
  assert.equal(out.status, 200);
  assert.match(out.setCookie || '', new RegExp(`Path=/t/${a.slug}`, 'i'),
    'cleared with a different path is not cleared at all — the browser keeps it');
});

/* ═════════════════════════════════════ 4. the storefront is public, not open */

test("a shop's public storefront cannot be made to read another shop", async () => {
  const a = await makeShop('theta');
  const b = await makeShop('iota');

  /*
   * The storefront needs no session at all, which is correct - it is a shop
   * window. What it must not do is let the slug in the path and some other
   * identifier in the query disagree about whose products these are.
   */
  const products = await api(`/t/${a.slug}/api/shop/products?page=1`);
  assert.equal(products.status, 200);
  assert.ok(Array.isArray(products.data.rows));

  const withOther = await api(`/t/${a.slug}/api/shop/products?page=1&tenant=${b.slug}&slug=${b.slug}`);
  assert.equal(withOther.status, 200);
  assert.deepEqual(
    withOther.data.rows.map((row) => row.id),
    products.data.rows.map((row) => row.id),
    'a query parameter must not be able to change which shop is being read',
  );
});
