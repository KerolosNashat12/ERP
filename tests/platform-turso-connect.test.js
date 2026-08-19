/**
 * Connecting Turso from the console instead of from a deploy setting.
 *
 * The feature exists because an owner with a token in his hand was blocked by a
 * screen he could not reach: "create a database for me" was disabled, and the
 * note under it named an environment variable. So the console takes the token.
 * These tests are about the two things that makes true or false.
 *
 * VERIFICATION IS THE WHOLE VALUE. A token that is accepted quietly and fails
 * an hour later, in the middle of creating a shop, is worse than the variable
 * it replaced. So the "rejected" tests do not only assert a status code — they
 * assert that `platform_settings` is still empty afterwards, because a stored
 * token that does not work is the exact failure this feature must not ship.
 *
 * THE TOKEN NEVER COMES BACK. Asserted on whole response bodies rather than on
 * named fields: a test that checks `body.apiToken === undefined` passes on the
 * day somebody adds `body.debug.credentials`.
 *
 * The Turso Platform API is stubbed at the only boundary that exists — an HTTP
 * server on 127.0.0.1, with `TURSO_API_URL` pointed at it before
 * `src/config/index.js` is ever imported, exactly as tests/platform-provision
 * .test.js does it. The real client runs: real fetch, real headers, real status
 * codes. Not one packet leaves this machine.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-turso-connect-test');
const databasesDir = path.join(testDataDir, 'turso');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(databasesDir, { recursive: true });

/**
 * Four tokens, because four different things can happen to a person pasting
 * one in. None of them is ever allowed to appear in a response body.
 */
const CONSOLE_TOKEN = 'console-pasted-platform-token-that-must-never-be-echoed';
const ENV_TOKEN = 'environment-platform-token-that-must-never-be-echoed';
const MULTI_TOKEN = 'a-token-that-can-see-two-organisations';
const BAD_TOKEN = 'a-token-turso-has-never-heard-of';

const CONSOLE_ORG = 'habb-el-banat';
const ENV_ORG = 'the-org-on-the-host';
const OTHER_ORG = 'a-second-organisation';

/** Which organisations each token can see — the whole of Turso's authorisation. */
const TOKEN_ORGS = new Map([
  [CONSOLE_TOKEN, [{ name: 'Habb El Banat', slug: CONSOLE_ORG }]],
  [ENV_TOKEN, [{ name: 'Host Org', slug: ENV_ORG }]],
  [MULTI_TOKEN, [
    { name: 'Habb El Banat', slug: CONSOLE_ORG },
    { name: 'Second Org', slug: OTHER_ORG },
  ]],
]);

// --------------------------------------------------------------- THE STUB

function startTursoStub() {
  /** org slug -> Map(database name -> hostname) */
  const orgs = new Map([...TOKEN_ORGS.values()].flat().map((org) => [org.slug, new Map()]));
  const calls = [];
  const control = { failOrganisations: false };

  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); }
    });
  });

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    calls.push({
      method: req.method, url: req.url, body, token: bearer,
    });

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Every route is bearer-authenticated, exactly as Turso's is.
    if (!TOKEN_ORGS.has(bearer)) return send(401, { error: 'could not authenticate api token' });

    if (req.method === 'GET' && req.url === '/v1/locations') {
      return send(200, { locations: control.locations ?? { fra: 'Frankfurt' } });
    }

    if (req.method === 'GET' && req.url === '/v1/organizations') {
      if (control.failOrganisations) return send(500, { error: 'organizations service unavailable' });
      // Turso answers with a bare array.
      return send(200, TOKEN_ORGS.get(bearer));
    }

    const scoped = req.url.match(/^\/v1\/organizations\/([^/]+)(.*)$/);
    if (!scoped) return send(404, { error: `no stub route for ${req.method} ${req.url}` });
    const [, org, route] = scoped;

    // A token can only reach organisations it belongs to — the property the
    // "control plane wins" test turns into an assertion.
    if (!TOKEN_ORGS.get(bearer).some((row) => row.slug === org)) {
      return send(403, { error: `token cannot see organization ${org}` });
    }
    const databases = orgs.get(org);

    // Groups: an account may have one, several, or none, and the group is
    // where a database is actually created. `control.groups` lets a test say
    // which of those this account is — the "none" case is the one that took a
    // live console down with "group not found".
    if (req.method === 'GET' && route === '/groups') {
      return send(200, { groups: (control.groups ?? ['default']).map((name) => ({ name, primary: 'fra' })) });
    }
    if (req.method === 'POST' && route === '/groups') {
      const name = body?.name || 'default';
      // Turso refuses a region code the account cannot use — the exact
      // failure a live owner hit: "invalid location fra".
      const allowed = Object.keys(control.locations ?? { fra: 'Frankfurt' });
      if (body?.location && !allowed.includes(body.location)) {
        return send(400, { error: `invalid location ${body.location}: invalid location: ${body.location}` });
      }
      control.groups = [...(control.groups ?? []), name];
      return send(200, { group: { name, primary: body?.location || allowed[0] || 'unknown' } });
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
      const hostname = `file:${path.join(databasesDir, `${org}--${name}.db`)}`;
      databases.set(name, hostname);
      return send(200, { database: { Name: name, Hostname: hostname, Group: body?.group } });
    }
    const token = route.match(/^\/databases\/([^/]+)\/auth\/tokens$/);
    if (req.method === 'POST' && token) {
      if (!databases.has(token[1])) return send(404, { error: 'database not found' });
      return send(200, { jwt: `stub-database-token-for-${org}-${token[1]}` });
    }
    const remove = route.match(/^\/databases\/([^/]+)$/);
    if (req.method === 'DELETE' && remove) {
      databases.delete(remove[1]);
      return send(200, { database: remove[1] });
    }
    return send(404, { error: `no stub route for ${req.method} ${req.url}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      orgs,
      calls,
      control,
      url: `http://127.0.0.1:${server.address().port}`,
      since: () => calls.length,
      after: (mark) => calls.slice(mark),
    }));
  });
}

const turso = await startTursoStub();

// Every variable the config reads, before anything reads the config. The
// environment is deliberately populated: half these tests are about the
// environment path continuing to work, and the other half about the control
// plane overruling it.
process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.TURSO_API_URL = turso.url;
process.env.TURSO_API_TOKEN = ENV_TOKEN;
process.env.TURSO_ORG = ENV_ORG;

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const config = (await import('../src/config/index.js')).default;

const OWNER_PASSWORD = 'turso-connect-owner-password';
let base = '';
let server = null;
let ownerCookie = '';

before(async () => {
  // A guard, not a nicety: if the stub URL were ever not honoured, these tests
  // would paste tokens at the real Turso.
  assert.equal(config.turso.apiUrl, turso.url, 'the client must be pointed at the local stub');

  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('owner', ?, 'Turso Owner', 1, ?)
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

async function api(urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return {
    status: res.status, data, text, cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

const owner = (extra = {}) => ({ cookie: ownerCookie, ...extra });
const settingsRows = () => platformDb().prepare('SELECT key, value FROM platform_settings ORDER BY key').all();
const settingsCount = async () => (await platformDb()
  .prepare('SELECT COUNT(*) AS n FROM platform_settings').get()).n;

/**
 * A deployment that was never given anything on the host — the state the owner
 * this feature was written for is actually in. `config.turso` is frozen only at
 * the top level, and the client reads it per call, which is what makes taking
 * the two values away and putting them back meaningful rather than cosmetic.
 */
async function withNothingInTheEnvironment(fn) {
  const token = config.turso.apiToken;
  const org = config.turso.org;
  config.turso.apiToken = '';
  config.turso.org = '';
  try {
    return await fn();
  } finally {
    config.turso.apiToken = token;
    config.turso.org = org;
  }
}

/** Every token this test file knows about, looked for in one blob of JSON. */
function assertNoTokenAnywhere(payload, what) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const secret of [CONSOLE_TOKEN, ENV_TOKEN, MULTI_TOKEN, BAD_TOKEN]) {
    assert.ok(!text.includes(secret), `${what} must not contain an API token`);
  }
}

// ------------------------------------------- 1. NOTHING CONFIGURED AT ALL

test('with nothing configured, the console is told it is not connected — and told nothing else', async () => {
  await withNothingInTheEnvironment(async () => {
    const status = await api('/api/platform/integrations/turso', owner());
    assert.equal(status.status, 200);
    assert.deepEqual(status.data, {
      connected: false,
      source: null,
      org: null,
      group: null,
      databases: null,
      checkedAt: null,
      error: null,
    }, 'not connected is the whole answer — no token, no fields hinting at one');

    const environment = await api('/api/platform/environment', owner());
    assert.equal(environment.data.canProvision, false);
    assert.equal(await settingsCount(), 0, 'and nothing has been written');
  });
});

// ----------------------------------- 2. A TOKEN THAT FAILS IS NOT STORED

test('a token Turso rejects is refused with a sentence that names the part that failed — and nothing is written', async () => {
  await withNothingInTheEnvironment(async () => {
    const mark = turso.since();
    const refused = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: BAD_TOKEN },
    }));

    assert.equal(refused.status, 502, 'Turso said no; this deployment is not the thing that is broken');
    assert.match(refused.data.error.message, /API token was rejected/i,
      'which part failed, said in words: the token, not "something went wrong"');
    assert.match(refused.data.error.message, /Platform API token/i,
      'and the difference that catches most people — a platform token, not a database token');
    assertNoTokenAnywhere(refused.text, 'a rejection');

    // The point of the test. A token that cannot be verified must leave no
    // trace, or the next shop creation fails an hour later instead.
    assert.equal(await settingsCount(), 0, 'nothing was stored');
    const environment = await api('/api/platform/environment', owner());
    assert.equal(environment.data.canProvision, false, 'and the console still knows it cannot provision');

    // One call was made, and it was the verification — no database was touched.
    assert.deepEqual(turso.after(mark).map((c) => `${c.method} ${c.url}`), ['GET /v1/organizations']);
  });
});

test('a token that cannot see the organisation it was given is refused, and told which ones it can see', async () => {
  await withNothingInTheEnvironment(async () => {
    const refused = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: CONSOLE_TOKEN, org: 'an-org-that-is-not-his' },
    }));
    assert.equal(refused.status, 422);
    assert.match(refused.data.error.message, /an-org-that-is-not-his/);
    assert.match(refused.data.error.message, new RegExp(CONSOLE_ORG),
      'the refusal lists what the token can actually see, so the next attempt is a choice, not a guess');
    assert.equal(await settingsCount(), 0, 'nothing was stored');
  });
});

test('Turso being unreachable during verification stores nothing and blames the network, not the token', async () => {
  await withNothingInTheEnvironment(async () => {
    turso.control.failOrganisations = true;
    try {
      const refused = await api('/api/platform/integrations/turso', owner({
        method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
      }));
      assert.equal(refused.status, 502);
      assert.match(refused.data.error.message, /^Turso refused: /);
      assert.ok(!/API token was rejected/i.test(refused.data.error.message),
        'a broken service must not be reported as a bad token — that sends the owner hunting for a new one');
      assert.equal(await settingsCount(), 0);
    } finally {
      turso.control.failOrganisations = false;
    }
  });
});

// ------------------------------ 3. ONE ORGANISATION, ADOPTED WITHOUT ASKING

test('a token that verifies is stored, canProvision flips to true, and the organisation is adopted without asking', async () => {
  await withNothingInTheEnvironment(async () => {
    const mark = turso.since();
    // Everything the owner does: paste a token. No organisation slug — he has
    // never heard the phrase, and should not have to.
    const connected = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
    }));

    assert.equal(connected.status, 200, connected.data?.error?.message);
    assert.equal(connected.data.connected, true);
    assert.equal(connected.data.org, CONSOLE_ORG, 'the only organisation the token can see, taken silently');
    assert.equal(connected.data.source, 'console');
    assert.equal(connected.data.databases, 0, 'a live count, from a call made with the token just given');
    assertNoTokenAnywhere(connected.text, 'the connect reply');

    // Verified before stored: the organisation list, then the databases in it.
    assert.deepEqual(turso.after(mark).map((c) => `${c.method} ${c.url}`), [
      'GET /v1/organizations',
      `GET /v1/organizations/${CONSOLE_ORG}/databases`,
      // And the group is settled while the owner is still here, rather than at
      // the moment a shop is being created — the failure that reached one.
      `GET /v1/organizations/${CONSOLE_ORG}/groups`,
    ], 'the token is proved twice, and the group it will use is resolved once');
    assert.ok(turso.after(mark).every((c) => c.token === CONSOLE_TOKEN),
      'and it travels in the Authorization header, nowhere else');

    // Stored, in the control plane, under the three documented keys.
    assert.deepEqual(await settingsRows(), [
      { key: 'turso.api_token', value: CONSOLE_TOKEN },
      { key: 'turso.group', value: 'default' },
      { key: 'turso.org', value: CONSOLE_ORG },
    ]);

    const environment = await api('/api/platform/environment', owner());
    assert.equal(environment.data.canProvision, true,
      'the create-shop form can now offer to make a database — with nothing set on the host');
  });
});

test('and creating a shop then provisions a database, in the organisation that was connected', async () => {
  await withNothingInTheEnvironment(async () => {
    const mark = turso.since();
    const created = await api('/api/platform/tenants', owner({
      method: 'POST',
      body: {
        slug: 'habb-el-banat',
        nameEn: 'Habb El Banat',
        nameAr: 'حب البنات',
        modules: ['dashboard', 'products', 'sales'],
        database: { mode: 'auto' },
      },
    }));

    assert.equal(created.status, 201, created.data?.error?.message);
    assert.equal(created.data.adminUsername, 'admin');
    assert.ok(created.data.adminPassword?.length >= 16, 'a one-time password comes back with it');

    assert.deepEqual(turso.after(mark).map((c) => `${c.method} ${c.url}`), [
      `GET /v1/organizations/${CONSOLE_ORG}/databases`,
      `GET /v1/organizations/${CONSOLE_ORG}/groups`,
      `POST /v1/organizations/${CONSOLE_ORG}/databases`,
      `POST /v1/organizations/${CONSOLE_ORG}/databases/mm-habb-el-banat/auth/tokens`,
    ], 'the console-pasted credentials are what provisioning uses');
    assert.ok(turso.after(mark).every((c) => c.token === CONSOLE_TOKEN));
    assert.ok(turso.orgs.get(CONSOLE_ORG).has('mm-habb-el-banat'), 'the database exists');

    // A working shop: the seeded admin signs in on the link the owner was given.
    const login = await api('/t/habb-el-banat/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: created.data.adminPassword },
    });
    assert.equal(login.status, 200, 'the password that came back is the password that works');

    // The count on the Integrations card is live, and it moved.
    const status = await api('/api/platform/integrations/turso', owner());
    assert.equal(status.data.databases, 1);
    assert.ok(status.data.checkedAt, 'and it says when it last asked');
  });
});

// ------------------------------------------ 4. THE TOKEN NEVER COMES BACK

test('no endpoint returns the token, and no audit row records it', async () => {
  await withNothingInTheEnvironment(async () => {
    for (const urlPath of [
      '/api/platform/integrations/turso',
      '/api/platform/environment',
      '/api/platform/tenants',
      '/api/platform/tenants/habb-el-banat',
      '/api/platform/overview',
      '/api/platform/auth/me',
    ]) {
      const res = await api(urlPath, owner());
      assert.equal(res.status, 200, urlPath);
      // The whole body, not a named field: a test that checks one key passes
      // on the day somebody adds another.
      assertNoTokenAnywhere(res.text, urlPath);
    }

    // Connecting again returns the freshly verified status — and still no token.
    const again = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: CONSOLE_TOKEN, org: CONSOLE_ORG },
    }));
    assert.equal(again.status, 200);
    assertNoTokenAnywhere(again.text, 'a repeat connect');

    // The audit says that Turso was connected and by whom. Not what with.
    const rows = await platformDb()
      .prepare("SELECT platform_user_id, action, detail FROM platform_audit WHERE action LIKE 'TURSO%'").all();
    assert.ok(rows.length >= 1, 'connecting Turso is audited');
    assert.ok(rows.every((row) => row.platform_user_id), 'by whom');
    assertNoTokenAnywhere(JSON.stringify(rows), 'a platform_audit row');
    assert.match(rows[0].detail, new RegExp(CONSOLE_ORG), 'the organisation is fine to record; the token is not');
  });
});

// -------------------------------------- 5. MORE THAN ONE ORGANISATION

test('a token that sees several organisations asks the owner to pick from the list it just fetched', async () => {
  await withNothingInTheEnvironment(async () => {
    // Start clean so "nothing was written" means something on this path too.
    await api('/api/platform/integrations/turso', owner({ method: 'DELETE' }));

    const asked = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: MULTI_TOKEN },
    }));
    assert.equal(asked.status, 422);
    assert.equal(asked.data.error.code, 'TURSO_MANY_ORGS',
      'a code the console can act on without parsing English');
    assert.deepEqual(asked.data.error.details.organisations.map((o) => o.slug), [CONSOLE_ORG, OTHER_ORG],
      'the list comes back with the question, so the owner picks from what exists rather than from memory');
    assert.equal(await settingsCount(), 0, 'and until he picks, nothing is stored');

    const chosen = await api('/api/platform/integrations/turso', owner({
      method: 'PUT', body: { apiToken: MULTI_TOKEN, org: OTHER_ORG },
    }));
    assert.equal(chosen.status, 200);
    assert.equal(chosen.data.org, OTHER_ORG);
    assertNoTokenAnywhere(chosen.text, 'the connect reply');
  });
});

// --------------------------------- 6. THE ENVIRONMENT STILL WORKS ALONE

test('the environment variables still work when the control plane has nothing', async () => {
  const forgotten = await api('/api/platform/integrations/turso', owner({ method: 'DELETE' }));
  assert.equal(forgotten.status, 200);
  assert.equal(forgotten.data.connected, true,
    'forgetting the console token falls back to the host, rather than to nothing');
  assert.equal(await settingsCount(), 0, 'the control plane really is empty');

  const status = await api('/api/platform/integrations/turso', owner());
  assert.equal(status.data.source, 'environment');
  assert.equal(status.data.org, ENV_ORG);
  assertNoTokenAnywhere(status.text, 'the status of an environment-configured deployment');

  const environment = await api('/api/platform/environment', owner());
  assert.equal(environment.data.canProvision, true);

  const mark = turso.since();
  const created = await api('/api/platform/tenants', owner({
    method: 'POST',
    body: {
      slug: 'env-shop', nameEn: 'Env Shop', nameAr: 'متجر البيئة', modules: [], database: { mode: 'auto' },
    },
  }));
  assert.equal(created.status, 201, created.data?.error?.message);
  assert.ok(turso.after(mark).every((c) => c.token === ENV_TOKEN && c.url.includes(`/${ENV_ORG}/`)),
    'a deployment set up the old way is untouched by any of this');
  assert.ok(turso.orgs.get(ENV_ORG).has('mm-env-shop'));
});

// ------------------------------------ 7. THE CONTROL PLANE WINS THE TIE

test('the control plane wins when both are present', async () => {
  // The host still has its variables set — this is the upgrade case: a
  // deployment that was configured the old way, whose owner has now pasted a
  // token for a different organisation into the console.
  assert.equal(config.turso.apiToken, ENV_TOKEN, 'the environment is still set');
  assert.equal(config.turso.org, ENV_ORG);

  const connected = await api('/api/platform/integrations/turso', owner({
    method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
  }));
  assert.equal(connected.status, 200);
  assert.equal(connected.data.org, CONSOLE_ORG, 'the console\'s organisation, not the host\'s');
  assert.equal(connected.data.source, 'console');

  const mark = turso.since();
  const created = await api('/api/platform/tenants', owner({
    method: 'POST',
    body: {
      slug: 'tie-break', nameEn: 'Tie Break', nameAr: 'الفاصل', modules: [], database: { mode: 'auto' },
    },
  }));
  assert.equal(created.status, 201, created.data?.error?.message);

  const calls = turso.after(mark);
  assert.ok(calls.every((c) => c.token === CONSOLE_TOKEN),
    'every call carries the token pasted in the console');
  assert.ok(calls.every((c) => c.url.includes(`/${CONSOLE_ORG}/`)),
    'and lands in the organisation it named');
  assert.ok(turso.orgs.get(CONSOLE_ORG).has('mm-tie-break'));
  assert.equal(turso.orgs.get(ENV_ORG).has('mm-tie-break'), false,
    'the stale variable on the host did not get a say');
  assertNoTokenAnywhere(created.text, 'a created tenant');
});

// ------------------------------------------------ 6. GROUPS, FOUND OR MADE

test('an account with no group at all still gets a shop — the failure a real owner hit', async () => {
  // "Turso refused: group not found (HTTP 400)", in front of an owner who had
  // done everything right: a fresh Turso account has no group called
  // `default`, and this code assumed one. A group is Turso's unit of
  // infrastructure, not a decision about a shop, so the platform finds one or
  // makes one rather than asking.
  await withNothingInTheEnvironment(async () => {
    const previous = turso.control.groups;
    turso.control.groups = [];
    try {
      await api('/api/platform/integrations/turso', owner({
        method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
      }));

      const created = await api('/api/platform/tenants', owner({
        method: 'POST',
        body: {
          slug: 'no-group-shop',
          nameEn: 'No Group Shop',
          modules: ['dashboard'],
          database: { mode: 'auto' },
        },
      }));

      assert.equal(created.status, 201, created.data?.error?.message);
      assert.ok(turso.control.groups.includes('default'), 'the group was created by the platform');
      assert.ok(created.data.adminPassword, 'and the shop came out the other side');
    } finally {
      turso.control.groups = previous;
    }
  });
});

test('an account whose group is called something else is used as it is', async () => {
  await withNothingInTheEnvironment(async () => {
    const previous = turso.control.groups;
    turso.control.groups = ['production'];
    try {
      await api('/api/platform/integrations/turso', owner({
        method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
      }));

      const mark = turso.since();
      const created = await api('/api/platform/tenants', owner({
        method: 'POST',
        body: {
          slug: 'other-group-shop',
          nameEn: 'Other Group Shop',
          modules: ['dashboard'],
          database: { mode: 'auto' },
        },
      }));

      assert.equal(created.status, 201, created.data?.error?.message);
      const create = turso.after(mark).filter((c) => c.method === 'POST' && c.url.endsWith('/databases')).pop();
      assert.equal(create.body.group, 'production', "the account's own group, not an invented name");
      assert.deepEqual(turso.control.groups, ['production'], 'and nothing was created that did not need to be');
    } finally {
      turso.control.groups = previous;
    }
  });
});

test('a region code this account cannot use is not a dead end', async () => {
  // "Turso refused: invalid location fra" — the second thing that stopped a
  // real shop being created. The set of region codes differs between accounts
  // and plans, so the platform asks which ones exist and tries them in turn
  // rather than believing any one of them.
  await withNothingInTheEnvironment(async () => {
    const groups = turso.control.groups;
    const locations = turso.control.locations;
    turso.control.groups = [];
    turso.control.locations = { 'aws-eu-west-1': 'Ireland' };
    try {
      await api('/api/platform/integrations/turso', owner({
        method: 'PUT', body: { apiToken: CONSOLE_TOKEN },
      }));

      const created = await api('/api/platform/tenants', owner({
        method: 'POST',
        body: {
          slug: 'odd-region-shop',
          nameEn: 'Odd Region Shop',
          modules: ['dashboard'],
          database: { mode: 'auto' },
        },
      }));

      assert.equal(created.status, 201, created.data?.error?.message);
      assert.ok(turso.control.groups.includes('default'),
        'the group landed in a region the account really has');
    } finally {
      turso.control.groups = groups;
      turso.control.locations = locations;
    }
  });
});
