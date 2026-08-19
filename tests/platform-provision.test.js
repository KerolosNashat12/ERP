/**
 * One click to a shop: the database is made for the owner, and the links come
 * back with it.
 *
 * The Turso Platform API is stubbed at the only boundary that exists — an HTTP
 * server this file starts on 127.0.0.1, with `TURSO_API_URL` pointed at it
 * before `src/config/index.js` is ever imported. So the real client runs: real
 * `fetch`, real headers, real status codes, real JSON, and not one packet
 * leaves this machine. Nothing here is mocked in the sense of being replaced.
 *
 * The databases the stub "creates" are local `file:` libSQL URLs, the same
 * trick tests/platform-hosted.test.js uses: the driver treats a file database
 * and a Turso one identically, so a provisioned tenant can be seeded, signed
 * into and read back for real.
 *
 * The test that matters most is the third one. A shop owner attaching the
 * database their shop is running on right now must never have it deleted
 * because provisioning tripped over something else — and the rollback that
 * deletes a database is written a few lines away from the one that must not.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-provision-test');
const databasesDir = path.join(testDataDir, 'turso');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(databasesDir, { recursive: true });

const ORG = 'mm-fleet';
const API_TOKEN = 'platform-api-token-that-must-never-be-echoed';

// --------------------------------------------------------------- THE STUB

/**
 * The four calls `src/platform/turso.js` makes, and nothing else. It records
 * every request so a test can assert on what was created — and, in the case
 * that matters, on what was deleted.
 */
function startTursoStub() {
  const databases = new Map();
  const calls = [];
  const control = { failTokenMinting: false };

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); }
    });
  });

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const prefix = `/v1/organizations/${ORG}`;
    const route = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
    calls.push({
      method: req.method, route, body, authorization: req.headers.authorization,
    });

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (!req.url.startsWith(prefix)) return send(404, { error: 'unknown organization' });
    if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
      return send(401, { error: 'invalid api token' });
    }

    if (req.method === 'GET' && route === '/databases') {
      return send(200, {
        databases: [...databases.entries()].map(([Name, Hostname]) => ({ Name, Hostname })),
      });
    }
    if (req.method === 'POST' && route === '/databases') {
      const { name } = body || {};
      if (databases.has(name)) return send(409, { error: 'database already exists' });
      // A `file:` "hostname": the driver opens it exactly as it opens a Turso
      // one, so the tenant that lands on it is a real, working shop.
      const hostname = `file:${path.join(databasesDir, `${name}.db`)}`;
      databases.set(name, hostname);
      return send(200, { database: { Name: name, Hostname: hostname, Group: body?.group } });
    }

    const token = route.match(/^\/databases\/([^/]+)\/auth\/tokens$/);
    if (req.method === 'POST' && token) {
      if (control.failTokenMinting) return send(500, { error: 'token service unavailable' });
      if (!databases.has(token[1])) return send(404, { error: 'database not found' });
      return send(200, { jwt: `stub-database-token-for-${token[1]}` });
    }

    const remove = route.match(/^\/databases\/([^/]+)$/);
    if (req.method === 'DELETE' && remove) {
      const name = remove[1];
      if (!databases.has(name)) return send(404, { error: 'database not found' });
      // Turso deletes the data with the database; so does the stub, which is
      // what lets a test prove the file is gone rather than take a 200 on faith.
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(path.join(databasesDir, `${name}.db${suffix}`), { force: true });
      }
      databases.delete(name);
      return send(200, { database: name });
    }
    return send(404, { error: `no stub route for ${req.method} ${route}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      databases,
      calls,
      control,
      url: `http://127.0.0.1:${server.address().port}`,
      since: () => calls.length,
      after: (mark) => calls.slice(mark),
    }));
  });
}

const turso = await startTursoStub();

// Every variable the config reads, before anything reads the config.
process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.TURSO_API_URL = turso.url;
process.env.TURSO_API_TOKEN = API_TOKEN;
process.env.TURSO_ORG = ORG;

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, openConnection, runWithTenant } = await import('../src/infrastructure/database/connection.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const config = (await import('../src/config/index.js')).default;

const OWNER_PASSWORD = 'provision-test-owner-password';
let base = '';
let server = null;
let ownerCookie = '';

before(async () => {
  // A guard, not a nicety: if the stub URL were ever not honoured, these tests
  // would create databases in a real Turso organisation.
  assert.equal(config.turso.apiUrl, turso.url, 'the client must be pointed at the local stub');
  assert.equal(config.turso.org, ORG);

  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('owner', ?, 'Provisioning Owner', 1, ?)
  `).run(bcrypt.hashSync(OWNER_PASSWORD, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'owner', password: OWNER_PASSWORD },
  });
  assert.equal(login.status, 200);
  ownerCookie = login.cookie;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => turso.server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api(urlPath, {
  method = 'GET', body, cookie, headers = {},
} = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

const allModules = () => Object.keys(MODULES);
const rowFor = (slug) => platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);

// ------------------------------------------------- 1. THE ONE-CLICK SHOP

test('auto mode makes the database, mints its token, seeds it, and hands back a password and both links', async () => {
  const mark = turso.since();

  const created = await api('/api/platform/tenants', {
    method: 'POST',
    cookie: ownerCookie,
    // Everything the owner typed: a name. No URL, no token.
    body: {
      slug: 'auto-shop',
      nameEn: 'Auto Shop',
      nameAr: 'متجر تلقائي',
      modules: allModules(),
      database: { mode: 'auto' },
    },
  });

  assert.equal(created.status, 201, created.data?.error?.message);
  assert.equal(created.data.adminUsername, 'admin');
  assert.ok(created.data.adminPassword?.length >= 16, 'a one-time password comes back with it');

  // The links, whole, ready to be sent to staff and to customers.
  assert.deepEqual(created.data.links, {
    erp: `${base}/t/auto-shop`,
    shop: `${base}/t/auto-shop/shop`,
  });

  // What was actually asked of Turso, in order.
  const calls = turso.after(mark);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.route}`), [
    'GET /databases',
    'POST /databases',
    'POST /databases/mm-auto-shop/auth/tokens',
  ], 'the name is checked, the database is made, a token is minted — and nothing is deleted');
  assert.deepEqual(calls[1].body, { name: 'mm-auto-shop', group: 'default' });
  assert.ok(calls.every((c) => c.authorization === `Bearer ${API_TOKEN}`),
    'the platform token travels in the header and nowhere else');
  assert.ok(turso.databases.has('mm-auto-shop'), 'the database is still there when the dust settles');

  // The tenant row points at what was made, and holds the token it was given.
  const row = await rowFor('auto-shop');
  assert.equal(row.driver, 'libsql');
  assert.equal(row.db_url, turso.databases.get('mm-auto-shop'));
  assert.equal(row.db_auth_token, 'stub-database-token-for-mm-auto-shop');
  assert.equal(row.db_file, null, 'a provisioned database is not a file on this machine');

  // It is a working shop: the seeded admin signs in with the one-time password
  // and the ERP answers on the link the owner was just given.
  const login = await api('/t/auto-shop/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: created.data.adminPassword },
  });
  assert.equal(login.status, 200, 'the password that was returned is the password that works');
  const products = await api('/t/auto-shop/api/products', { cookie: login.cookie });
  assert.equal(products.status, 200);
  assert.equal(products.data.rows.length, 0, 'a brand-new shop starts empty');

  // Secrets: the platform token is not in anything the console was sent.
  assert.ok(!JSON.stringify(created.data).includes(API_TOKEN), 'the API token is nowhere in the reply');
  const detail = await api('/api/platform/tenants/auto-shop', { cookie: ownerCookie });
  assert.ok(!JSON.stringify(detail.data).includes(API_TOKEN));
  assert.ok(!JSON.stringify(detail.data).includes(row.db_auth_token), 'nor is the database token');
  assert.equal(detail.data.database.hasAuthToken, true, 'only the fact that one is set');
});

// ----------------------------------------- 2. ROLLBACK OF WHAT WE CREATED

test('a failure minting the token deletes the database this call just created, and leaves no tenant row', async () => {
  turso.control.failTokenMinting = true;
  const mark = turso.since();

  await assert.rejects(
    () => tenantService.create({
      slug: 'token-fails', nameEn: 'Token Fails', modules: [], database: { mode: 'auto' },
    }),
    (error) => {
      assert.match(error.message, /^Turso refused: /, 'one readable sentence, not a response body');
      assert.ok(!error.message.includes(API_TOKEN), 'and never the API token');
      assert.ok(!/node_modules|\.js:\d+/.test(error.message), 'nor a stack trace');
      return true;
    },
  );
  turso.control.failTokenMinting = false;

  const calls = turso.after(mark).map((c) => `${c.method} ${c.route}`);
  assert.deepEqual(calls, [
    'GET /databases',
    'POST /databases',
    'POST /databases/mm-token-fails/auth/tokens',
    'DELETE /databases/mm-token-fails',
  ], 'the database that was made seconds ago is deleted again');

  assert.equal(turso.databases.has('mm-token-fails'), false, 'Turso is left with nothing to bill for');
  assert.equal(fs.existsSync(path.join(databasesDir, 'mm-token-fails.db')), false);
  assert.equal(await rowFor('token-fails'), null, 'and the control plane is exactly as it was');

  // Nothing is stranded: the same shop name can be created again.
  const retry = await tenantService.create({
    slug: 'token-fails', nameEn: 'Token Fails', modules: [], database: { mode: 'auto' },
  });
  assert.ok(retry.adminPassword, 'the retry succeeds, because the name was freed');
});

// ------------------------------------- 3. A CUSTOMER'S DATABASE IS SACRED

/**
 * A failure late in `create`, after the customer's database has been opened and
 * written to. The audit table is taken away for the duration: it is the last
 * write `create` makes, so the failure lands after every step that touches the
 * customer's data — which is the only place from which "we never delete an
 * attached database" is worth proving.
 */
async function withProvisioningBrokenAtTheLastStep(fn) {
  const db = platformDb();
  await db.prepare('ALTER TABLE platform_audit RENAME TO platform_audit_hidden').run();
  try {
    return await fn();
  } finally {
    await db.prepare('ALTER TABLE platform_audit_hidden RENAME TO platform_audit').run();
  }
}

test('a failure while attaching a customer\'s own database deletes nothing', async () => {
  const url = `file:${path.join(testDataDir, 'the-customers-own-shop.db')}`;
  const file = url.slice('file:'.length);

  // A shop that is serving customers right now: their password, their company
  // name, their products.
  const connection = await openConnection({ driver: 'libsql', url });
  try {
    await runWithTenant({ slug: 'fixture' }, connection, async () => {
      await connection.applySchema();
      await runMigrations();
      await seedBaseline();
      const db = connection.facade;
      await db.prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'")
        .run(bcrypt.hashSync('the-owners-own-password', 4));
      await db.prepare("UPDATE settings SET value = ? WHERE key = 'company.name'").run('The Customer\'s Own Shop');
      for (const name of ['Silver Bracelet', 'Linen Bag']) {
        await db.prepare(`
          INSERT INTO products (sku_prefix, name_en, name_ar, base_cost, base_price, tax_rate)
          VALUES (?, ?, ?, 10, 25, 14)
        `).run(name.slice(0, 6).toUpperCase(), name, name);
      }
    });
  } finally {
    await connection.close();
  }

  const read = async () => {
    const conn = await openConnection({ driver: 'libsql', url });
    try {
      return await runWithTenant({ slug: 'fixture' }, conn, async () => ({
        users: (await conn.facade.prepare('SELECT COUNT(*) AS n FROM users').get()).n,
        adminHash: (await conn.facade.prepare("SELECT password_hash AS h FROM users WHERE username = 'admin'").get()).h,
        companyName: (await conn.facade.prepare("SELECT value AS v FROM settings WHERE key = 'company.name'").get()).v,
        products: (await conn.facade.prepare('SELECT name_en FROM products ORDER BY id').all()).map((r) => r.name_en),
      }));
    } finally {
      await conn.close();
    }
  };

  const before_ = await read();
  assert.equal(before_.products.length, 2);

  const mark = turso.since();
  const failure = await withProvisioningBrokenAtTheLastStep(() => tenantService.create({
    slug: 'customer-own', nameEn: 'Customer Own', modules: [], database: { mode: 'libsql', url },
  }).then(() => null, (error) => error));

  // Where it broke matters: anything earlier would prove nothing, because the
  // customer's database would not have been opened, let alone written to.
  assert.ok(failure, 'provisioning did fail');
  assert.match(String(failure.message), /platform_audit/,
    'it failed at the last step, with every step that touches the customer\'s data behind it');

  // The point of the whole test: nothing was destroyed, anywhere.
  assert.equal(fs.existsSync(file), true, 'the customer\'s database file is still on disk');
  assert.deepEqual(await read(), before_,
    'their users, their password, their company name and every product are exactly as they were');
  assert.deepEqual(turso.after(mark), [], 'not one call was made to Turso — least of all a delete');
  assert.equal(await rowFor('customer-own'), null, 'only the half-made control-plane row is gone');
});

// ------------------------------------------------------ 4. LINKS, BEHIND A PROXY

test('links are the address the request arrived at, not the address the process thinks it has', async () => {
  const proxied = {
    'x-forwarded-proto': 'https',
    // A chain, as a real proxy writes it: the visitor's host comes first.
    'x-forwarded-host': 'erp-rust-one.vercel.app, internal-lb.vercel.internal',
  };
  const expected = {
    erp: 'https://erp-rust-one.vercel.app/t/auto-shop',
    shop: 'https://erp-rust-one.vercel.app/t/auto-shop/shop',
  };

  const list = await api('/api/platform/tenants', { cookie: ownerCookie, headers: proxied });
  assert.equal(list.status, 200);
  const row = list.data.rows.find((r) => r.slug === 'auto-shop');
  assert.deepEqual(row.links, expected, 'the list shows links an owner can send as they are');
  assert.ok(list.data.rows.every((r) => r.links?.erp && r.links?.shop), 'every tenant carries both');

  const detail = await api('/api/platform/tenants/auto-shop', { cookie: ownerCookie, headers: proxied });
  assert.deepEqual(detail.data.links, expected, 'and so does the manage page');

  // Without a proxy in front — a shop PC on the LAN — it is the host that was
  // actually used, still whole and still clickable.
  const direct = await api('/api/platform/tenants/auto-shop', { cookie: ownerCookie });
  assert.deepEqual(direct.data.links, { erp: `${base}/t/auto-shop`, shop: `${base}/t/auto-shop/shop` });
});

// ----------------------------------------------- 5. NOTHING CONFIGURED YET

test('with no API token the console is told it cannot provision, and auto mode is refused by name', async () => {
  // `config` is frozen only at the top level, so the one fact this test is
  // about — is a token configured? — can be taken away and put back. The
  // client reads it per call, which is what makes that meaningful.
  const configured = config.turso.apiToken;
  config.turso.apiToken = '';
  const mark = turso.since();
  try {
    const environment = await api('/api/platform/environment', { cookie: ownerCookie });
    assert.deepEqual(environment.data, { hostedControlPlane: false, canProvision: false },
      'the form learns it cannot offer to make a database — and learns nothing about the token');

    const refused = await api('/api/platform/tenants', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        slug: 'no-token', nameEn: 'No Token', modules: [], database: { mode: 'auto' },
      },
    });
    assert.equal(refused.status, 422);
    assert.match(refused.data.error.message, /TURSO_API_TOKEN/,
      'the refusal names the thing to configure, not just the fact that it is missing');
    assert.match(refused.data.error.message, /paste its URL|paste a database URL|URL/i,
      'and says what to do meanwhile');
  } finally {
    config.turso.apiToken = configured;
  }

  assert.deepEqual(turso.after(mark), [], 'nothing was asked of Turso');
  assert.equal(await rowFor('no-token'), null, 'and no tenant row was left behind');

  // Put back, the console can offer it again.
  const environment = await api('/api/platform/environment', { cookie: ownerCookie });
  assert.equal(environment.data.canProvision, true);
});
