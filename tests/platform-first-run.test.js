/**
 * A console that has never been opened.
 *
 * Turning the fleet on should not depend on an environment variable holding a
 * password nobody has chosen yet, so the first person to open the console makes
 * the owner account there. The interesting property is not that it works — it
 * is that the door closes: once an owner exists this endpoint must never create
 * a second account, or anyone who finds the URL owns the fleet.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'first-run-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dir, 'tenants');
process.env.MM_DB_FILE = path.join(dir, 'shop.db');
delete process.env.MM_PLATFORM_OWNER_PASSWORD;
delete process.env.MM_DEFAULT_TENANT;

const { createApp } = await import('../src/server.js');
const { initDb, applySchema, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');

let base = '';
let server = null;

before(async () => {
  await initDb();
  await applySchema();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (path_, body) => fetch(`${base}${path_}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('nothing is seeded, so there is no published default password to find', async () => {
  const row = await platformDb().prepare('SELECT COUNT(*) AS n FROM platform_users').get();
  assert.equal(row.n, 0);
  const state = await (await fetch(`${base}/api/platform/auth/state`)).json();
  assert.equal(state.needsSetup, true);
});

test('a short password is refused', async () => {
  const res = await post('/api/platform/auth/setup', { password: 'short' });
  assert.equal(res.status, 422);
  const row = await platformDb().prepare('SELECT COUNT(*) AS n FROM platform_users').get();
  assert.equal(row.n, 0, 'and nothing is created by a refused attempt');
});

test('the first caller becomes the owner and is signed in', async () => {
  const res = await post('/api/platform/auth/setup', { password: 'a-password-i-chose' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.username, 'owner');
  assert.match(res.headers.get('set-cookie') || '', /mm_platform=/);
});

test('and the door is shut behind them', async () => {
  const res = await post('/api/platform/auth/setup', { password: 'another-password-entirely' });
  assert.equal(res.status, 409, 'a second owner cannot be created by anyone who finds this URL');

  const row = await platformDb().prepare('SELECT COUNT(*) AS n FROM platform_users').get();
  assert.equal(row.n, 1);

  const state = await (await fetch(`${base}/api/platform/auth/state`)).json();
  assert.equal(state.needsSetup, false);

  const signIn = await post('/api/platform/auth/login', { username: 'owner', password: 'a-password-i-chose' });
  assert.equal(signIn.status, 200, 'and the password chosen first is still the one that works');

  const wrong = await post('/api/platform/auth/login', { username: 'owner', password: 'another-password-entirely' });
  assert.equal(wrong.status, 401);
});
