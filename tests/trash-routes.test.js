/**
 * سلة المهملات over HTTP — the doors, not the machinery.
 *
 * `recycle-bin.test.js` next door tests what deleting a thing DOES: what is
 * reversed, what refuses, what the money does. This file tests the seven routes
 * that stand in front of it, because a policy that is right and a route that is
 * open to the wrong person are the same bug from the shop's point of view.
 *
 * The one that matters most is the POST. Deleting is not a `trash.*` right at
 * all: the bin is only where the thing LANDS, so the permission asked for is
 * the right to delete THAT KIND OF THING — `products.delete` for a product,
 * `sales.void` for an invoice. Getting that wrong in the generous direction
 * would mean anybody who can see the bin can delete anything in the shop
 * through it, which is precisely the door this feature must not open.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'trash-routes-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema, transaction,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body, as } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as === null ? {} : { cookie: as || cookie }),
      'Idempotency-Key': `t-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

/** Sign in and keep the cookie, without disturbing the ambient one. */
async function signIn(username, password) {
  const res = await call('/api/auth/login', {
    method: 'POST', body: { username, password }, as: null,
  });
  assert.equal(res.status, 200, `${username} signs in`);
  return res.cookie;
}

test('the recycle bin over HTTP', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  server = await new Promise((resolve) => {
    const listening = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  cookie = await signIn('admin', 'admin123');

  // A brand nothing points at, and a cashier who may not delete one.
  await transaction(async () => {
    await getDb().prepare(
      "INSERT INTO brands (id, code, name_en, name_ar) VALUES (700,'B700','Routes','مسارات')",
    ).run();
  });

  const cashier = await call('/api/users', {
    method: 'POST',
    body: {
      username: 'binclerk',
      full_name: 'Bin Clerk',
      password: 'clerk12345',
      role_id: (await getDb().prepare("SELECT id FROM roles WHERE code = 'cashier'").get()).id,
    },
  });
  assert.equal(cashier.status, 201, 'the fixture cashier is created');
  const clerkCookie = await signIn('binclerk', 'clerk12345');

  let entryId = 0;

  await t.test('the preview says what would happen, before anything happens', async () => {
    const res = await call('/api/trash/preview/brand/700');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    // The label comes back in the reader's own language — the seeded
    // administrator reads Arabic — so both spellings are the same brand.
    assert.ok(['Routes', 'مسارات'].includes(res.data.label), res.data.label);
    assert.equal(res.data.retentionDays, 30);
  });

  await t.test('an unknown entity type is refused rather than guessed at', async () => {
    const res = await call('/api/trash/preview/unicorn/1');
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  });

  await t.test('and the preview is open to whoever may do the deleting', async () => {
    /*
     * The dialog has to be readable by the person about to press the button.
     * A cashier may not delete a brand — so the preview refuses too, with the
     * same words — but the right that decides it is `brands.delete`, never
     * `trash.view`, or the confirm dialog would 403 for every role but one.
     */
    const refused = await call('/api/trash/preview/brand/700', { as: clerkCookie });
    assert.equal(refused.status, 403);
    assert.match(JSON.stringify(refused.data), /brands\.delete/);
  });

  await t.test('deleting asks for the right to delete THAT, not the right to see the bin', async () => {
    const refused = await call('/api/trash', {
      method: 'POST',
      as: clerkCookie,
      body: { entityType: 'brand', entityId: 700 },
    });
    assert.equal(refused.status, 403,
      'a cashier cannot delete a brand by pointing at the bin');
    assert.match(JSON.stringify(refused.data), /brands\.delete/);
  });

  await t.test('the administrator deletes it, and it lands in the bin', async () => {
    const res = await call('/api/trash', {
      method: 'POST',
      body: { entityType: 'brand', entityId: 700, reason: 'created by mistake' },
    });
    assert.equal(res.status, 201);
    entryId = res.data.id;
    assert.equal(res.data.entityType, 'brand');
    assert.equal(res.data.reason, 'created by mistake');

    // And it is off the screen it used to be on.
    const brands = await call('/api/brands?pageSize=200');
    assert.equal(brands.data.rows.some((r) => r.id === 700), false,
      'what is in the bin is not on the brands page');
  });

  await t.test('the list and the summary answer the two questions the page asks', async () => {
    const list = await call('/api/trash?status=in_bin');
    assert.equal(list.status, 200);
    const row = list.data.rows.find((r) => r.id === entryId);
    assert.ok(row, 'the entry is in the register');
    assert.ok(['Routes', 'مسارات'].includes(row.label), row.label);
    assert.equal(row.deletedByName, 'System Administrator');
    assert.ok(row.purgeAfter > row.deletedAt);

    const summary = await call('/api/trash/summary');
    assert.equal(summary.status, 200);
    assert.ok(summary.data.inBin >= 1);
    assert.equal(summary.data.retentionDays, 30);
    assert.ok(summary.data.byModule.some((m) => m.module === 'brands'));
  });

  await t.test('a cashier cannot see the bin at all', async () => {
    const res = await call('/api/trash', { as: clerkCookie });
    assert.equal(res.status, 403, 'the bin is a record of deletions, not a public page');
  });

  await t.test('restoring puts it back on the screen it came off', async () => {
    const res = await call(`/api/trash/${entryId}/restore`, { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    const brands = await call('/api/brands?pageSize=200');
    assert.equal(brands.data.rows.some((r) => r.id === 700), true);
  });

  await t.test('the sweep destroys only what is due, and says what it kept', async () => {
    const again = await call('/api/trash', {
      method: 'POST', body: { entityType: 'brand', entityId: 700 },
    });
    assert.equal(again.status, 201);

    const early = await call('/api/trash/sweep', { method: 'POST', body: {} });
    assert.equal(early.status, 200);
    assert.equal(early.data.purged, 0, 'nothing is thirty days old yet');

    await getDb().prepare(
      "UPDATE trash_items SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(again.data.id);

    const due = await call('/api/trash/sweep', { method: 'POST', body: {} });
    assert.equal(due.data.purged, 1);
    assert.ok(!await getDb().prepare('SELECT id FROM brands WHERE id = 700').get(),
      'the record itself is gone now');
  });
});
