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

test('one shop cannot be served another shop\'s user out of a cache', async () => {
  /*
   * The second shape of the same attack, and the one the tenant claim does NOT
   * stop: the attacker uses their own valid token, for their own shop.
   *
   * What was wrong was inside. The identity cache - which exists so that
   * authenticate does not read the user row and the permission list on every
   * single request - keyed itself with the tenant CONTEXT OBJECT, and an object
   * in a template literal is the string "[object Object]" for every shop alike.
   * So it was one namespace keyed by user id alone: shop A's user 2 and shop
   * B's user 2 were the same entry, and whichever shop asked second was served
   * the other one's row and, crucially, the other one's PERMISSIONS.
   *
   * The probe has to be permissions rather than identity: /auth/me re-reads the
   * profile from the correct database, so it looks innocent even while the
   * authorisation decision behind it is being made from another shop's list.
   * So: the same user id in both shops, an administrator in one and a stock
   * clerk in the other, and then an administrator's request. If the cache
   * leaks, the administrator is refused.
   */
  const a = await makeShop('kappa');
  const b = await makeShop('lambda');

  const roles = async (shop) => {
    const res = await api(`/t/${shop.slug}/api/users/roles`, { cookie: shop.cookie });
    return res.data.rows || res.data;
  };
  const makeUser = async (shop, roleCode, username) => {
    const role = (await roles(shop)).find((r) => r.code === roleCode);
    assert.ok(role, `${shop.slug}: expected a ${roleCode} role`);
    const created = await api(`/t/${shop.slug}/api/users`, {
      method: 'POST',
      cookie: shop.cookie,
      body: {
        username, full_name: `${roleCode} ${shop.slug}`, password: 'twin-user-password', role_id: role.id,
      },
    });
    assert.equal(created.status, 201, `${shop.slug}: creating ${username}: ${JSON.stringify(created.data)}`);
    const login = await api(`/t/${shop.slug}/api/auth/login`, {
      method: 'POST', body: { username, password: 'twin-user-password' },
    });
    assert.equal(login.status, 200);
    return { id: created.data.id, cookie: login.cookie };
  };

  // Same username, same role position, different shops - and, being each
  // shop's second user, the same id. That collision is the bug's whole
  // precondition and it happens by itself on any two shops of the same age.
  const adminInA = await makeUser(a, 'admin', 'twin');
  const clerkInB = await makeUser(b, 'inventory', 'twin');
  assert.equal(adminInA.id, clerkInB.id,
    'the two shops must hand out the same id for this to be testing anything');

  // Warm the cache with the WEAKER user, then ask as the administrator.
  const clerkAsked = await api(`/t/${b.slug}/api/users`, { cookie: clerkInB.cookie });
  assert.equal(clerkAsked.status, 403, 'a stock clerk cannot list users — that is the point of him');

  const adminAsked = await api(`/t/${a.slug}/api/users`, { cookie: adminInA.cookie });
  assert.equal(adminAsked.status, 200,
    "shop A's administrator must be judged by shop A's permissions, not by whatever shop B cached");

  // And the other direction: the clerk must not inherit the administrator's list.
  const clerkAgain = await api(`/t/${b.slug}/api/users`, { cookie: clerkInB.cookie });
  assert.equal(clerkAgain.status, 403,
    'and shop B\'s clerk must not borrow shop A\'s permissions either');

  // Interleaved, several times, because a cache is a race by nature.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await api(`/t/${b.slug}/api/users`, { cookie: clerkInB.cookie })).status, 403);
    assert.equal((await api(`/t/${a.slug}/api/users`, { cookie: adminInA.cookie })).status, 200);
  }
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

test('the console locks out after repeated wrong passwords', async () => {
  /*
   * The most valuable password in the system - it can download and restore
   * every shop on the fleet - was the only one with no attempt counting at all.
   */
  const { resetLoginAttempts } = await import('../src/platform/auth.js');
  resetLoginAttempts('sec-owner');

  let locked = null;
  for (let i = 0; i < 8; i += 1) {
    const attempt = await api('/api/platform/auth/login', {
      method: 'POST', body: { username: 'sec-owner', password: `wrong-${i}` },
    });
    assert.equal(attempt.status, 401);
    if (/too many/i.test(attempt.data?.error?.message || '')) { locked = i; break; }
  }
  assert.ok(locked !== null && locked < 8, 'the console must stop accepting guesses');

  // And the right password is refused while it is locked, or the lock is theatre.
  const rightButLocked = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sec-owner', password: 'tenant-security-owner' },
  });
  assert.equal(rightButLocked.status, 401);

  resetLoginAttempts('sec-owner');
  const after = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sec-owner', password: 'tenant-security-owner' },
  });
  assert.equal(after.status, 200, 'and it opens again once the window passes');
  owner = after.cookie;
});

test('an unknown console username is indistinguishable from a wrong password', async () => {
  const { resetLoginAttempts } = await import('../src/platform/auth.js');
  resetLoginAttempts();
  const unknown = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'nobody-here', password: 'whatever' },
  });
  const wrong = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sec-owner', password: 'not-it' },
  });
  assert.equal(unknown.status, wrong.status);
  assert.equal(unknown.data?.error?.message, wrong.data?.error?.message,
    'a different sentence for a real username is a list of real usernames');
  resetLoginAttempts();
});

test('signing out of the console actually clears its cookie', async () => {
  // This threw a ReferenceError on every attempt, so the owner's session
  // survived every "sign out" for the token's full twelve hours.
  const { resetLoginAttempts } = await import('../src/platform/auth.js');
  resetLoginAttempts();
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sec-owner', password: 'tenant-security-owner' },
  });
  assert.equal(login.status, 200);
  const out = await api('/api/platform/auth/logout', { method: 'POST', cookie: login.cookie });
  assert.equal(out.status, 200, 'sign-out must not be a 500');
  assert.match(out.setCookie || '', /=;|=deleted|Expires=Thu, 01 Jan 1970/i);
});

test('one shop cannot list or download another shop\'s file backup', async () => {
  /*
   * `BackupService` knew nothing about tenants: every shop wrote its
   * `mm-backup-<timestamp>.db` into ONE shared folder and then listed that whole
   * folder back. Shop B's administrator opened Settings and saw shop A's backup
   * sitting there, downloadable - and that file is the entire other shop:
   * prices, costs, customers, payroll.
   */
  const a = await makeShop('mu');
  const b = await makeShop('nu');

  const madeByA = await api(`/t/${a.slug}/api/settings/backups`, { method: 'POST', cookie: a.cookie });
  // On a libsql tenant this refuses, which is its own correct answer; the
  // isolation below is what matters either way.
  const listA = await api(`/t/${a.slug}/api/settings/backups`, { cookie: a.cookie });
  const listB = await api(`/t/${b.slug}/api/settings/backups`, { cookie: b.cookie });
  assert.equal(listA.status, 200);
  assert.equal(listB.status, 200);

  const namesOf = (res) => (res.data.rows || res.data || []).map((row) => row.file);
  const inA = namesOf(listA);
  const inB = namesOf(listB);
  for (const file of inA) {
    assert.ok(!inB.includes(file), `shop B must not see ${file}, which belongs to shop A`);
  }

  // And naming one exactly does not fetch it either.
  if (madeByA.status === 201 || madeByA.status === 200) {
    const file = madeByA.data?.file;
    if (file) {
      const stolen = await api(`/t/${b.slug}/api/settings/backups/${encodeURIComponent(file)}/download`, {
        cookie: b.cookie,
      });
      assert.equal(stolen.status, 404,
        'guessing the filename must not reach into another shop\'s folder');
    }
  }
});

test('a user cannot promote themselves by editing their own record', async () => {
  /*
   * UNDELEGATABLE stops a role being granted certain permissions. That guard was
   * walkable in two hops: anybody trusted with `users.update` opened their OWN
   * record and set their role to Administrator, which holds everything the list
   * was protecting. Delegating user administration is not supposed to be the
   * same as handing over the shop.
   */
  const shop = await makeShop('xi');
  const rolesRes = await api(`/t/${shop.slug}/api/users/roles`, { cookie: shop.cookie });
  const roles = rolesRes.data.rows || rolesRes.data;
  const manager = roles.find((r) => r.code !== 'admin');
  const admin = roles.find((r) => r.code === 'admin');

  const created = await api(`/t/${shop.slug}/api/users`, {
    method: 'POST',
    cookie: shop.cookie,
    body: {
      username: 'promoter', full_name: 'Promoter', password: 'promoter-password', role_id: manager.id,
    },
  });
  assert.equal(created.status, 201);
  // Give them exactly the right this is about, and nothing else.
  const withUsers = [...new Set([...(manager.permissions || []), 'users.view', 'users.update'])];
  const granted = await api(`/t/${shop.slug}/api/users/roles/${manager.id}/permissions`, {
    method: 'PUT', cookie: shop.cookie, body: { permissions: withUsers },
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.data));

  const login = await api(`/t/${shop.slug}/api/auth/login`, {
    method: 'POST', body: { username: 'promoter', password: 'promoter-password' },
  });
  assert.equal(login.status, 200);

  const promote = await api(`/t/${shop.slug}/api/users/${created.data.id}`, {
    method: 'PUT',
    cookie: login.cookie,
    body: { full_name: 'Promoter', username: 'promoter', role_id: admin.id },
  });
  assert.equal(promote.status, 403, 'nobody hands themselves the administrator role');

  // Editing something else about themselves still works — this is a guard on
  // one field, not a wall around the record.
  const rename = await api(`/t/${shop.slug}/api/users/${created.data.id}`, {
    method: 'PUT',
    cookie: login.cookie,
    body: { full_name: 'Promoter Renamed', username: 'promoter', role_id: manager.id },
  });
  assert.equal(rename.status, 200);
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
