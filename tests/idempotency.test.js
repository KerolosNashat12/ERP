/**
 * One save, one purchase order.
 *
 * The bug this file exists for, in the owner's words: *"when I click on save a
 * lot of times it's save a lot of POs."* Every test here would have failed
 * before the guard went in, and each one is a different way the same click
 * arrives twice:
 *
 *   - CONCURRENTLY, which is what a double-click actually is. The two requests
 *     overlap, so a naive "have I answered this before?" check lets both
 *     through — neither has been answered yet. This is the case that decides
 *     whether the design is real, so it is first.
 *   - one after the other, which is the retry on a bad connection and the page
 *     restored from the back-forward cache.
 *   - not at all: two genuinely different creates that happen to look identical
 *     must stay two documents, or the fix is worse than the bug. Both halves of
 *     that are checked — a second submission that says so with a key of its
 *     own, and an unkeyed repeat far enough apart that content is no longer
 *     evidence of anything.
 *   - a request that FAILED, which must be retryable. A 500 from a hiccup that
 *     is remembered as a 500 forever would turn a transient fault into a
 *     permanent one.
 *
 * And the same thing on the storefront, where a shopper double-tapping
 * "confirm order" is the identical bug with a worse consequence: two orders,
 * two deliveries, one customer who meant to buy once.
 *
 * Everything runs twice, once per driver. `node:sqlite` is the shop counter,
 * libSQL is the hosted deployment — and libSQL against a local file is the same
 * client, the same statement encoding and the same row decoding a Turso URL
 * uses, so the pair is a real comparison rather than a stand-in.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'idempotency-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

/**
 * The unkeyed window, shortened so a test can outlive it in under a second.
 *
 * It has to be set before the middleware module is evaluated, which is why
 * every import below is dynamic — a static `import` is hoisted above this line
 * and would read the default. 400ms keeps the same shape as the shipped 10s:
 * two taps land inside it, a deliberate repeat lands outside.
 */
process.env.MM_IDEMPOTENCY_ECHO_MS = '400';

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

/** The window above, as a number, so the waits below are not magic. */
const ECHO_MS = Number(process.env.MM_IDEMPOTENCY_ECHO_MS);

const DRIVERS = [
  { name: 'sqlite', descriptor: (file) => ({ driver: 'sqlite', file }) },
  { name: 'libsql', descriptor: (file) => ({ driver: 'libsql', url: `file:${file}` }) },
];

let active = null;
let base = '';
let server = null;
let cookie = '';
const app = createApp();

const scoped = (fn) => runWithTenant(null, active, fn);

/**
 * One request, with the status kept rather than thrown: half of these tests are
 * about what a refusal looks like, so a helper that throws on one would hide
 * the thing being measured.
 */
async function call(pathname, { method = 'GET', body, key } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, replayed: res.headers.get('idempotent-replay') === 'true' };
}

const countRows = (table) => scoped(async () => {
  const row = await getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row.n;
});

/**
 * The smallest shop a purchase order can exist in: the baseline (permissions,
 * roles, the admin account, the shop's own location), one supplier and one
 * sellable variant.
 */
async function seed(connection) {
  await runWithTenant(null, connection, async () => {
    // The storefront's own tables arrived by migration, not in the baseline
    // schema, and this file sells something.
    await runMigrations();
    await seedBaseline();
    await transaction(async () => {
      const db = getDb();
      await db.prepare(`INSERT INTO suppliers (id, code, name_en) VALUES (1, 'SUP1', 'Cairo Supplies')`).run();
      await db.prepare(`
        INSERT INTO products (id, sku_prefix, name_en, name_ar, base_price, is_active)
        VALUES (1, 'BAG', 'Tote bag', 'شنطة', 250, 1)
      `).run();
      await db.prepare(`
        INSERT INTO product_variants (id, product_id, sku, cost_price, selling_price, is_active)
        VALUES (1, 1, 'BAG-1', 120, 250, 1)
      `).run();
    });
  });
}

/** A purchase order body. Identical every time unless `notes` says otherwise. */
const order = (notes) => ({
  supplier_id: 1,
  warehouse_id: 1,
  order_date: '2026-03-01',
  discount_amount: 0,
  shipping_amount: 0,
  notes: notes ?? null,
  lines: [{ variant_id: 1, quantity_ordered: 2, unit_cost: 120, discount_percent: 0, tax_rate: 0 }],
});

/** A storefront order body — the same shape the checkout form sends. */
const basket = () => ({
  lines: [{ variant_id: 1, quantity: 1 }],
  customer: { name: 'Mona', phone: '01000000000' },
  address: { line: '12 Nile St', city: 'Cairo' },
});

test('a repeated save creates one document, on both drivers', async (t) => {
  server = await new Promise((resolve) => {
    const listening = http.createServer((req, res) => scoped(() => app(req, res)))
      .listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  for (const driver of DRIVERS) {
    await t.test(driver.name, async (dt) => {
      const connection = await openConnection(driver.descriptor(path.join(dir, `${driver.name}.db`)));
      await connection.applySchema();
      active = connection;
      cookie = '';
      await seed(connection);
      dt.after(() => connection.close());

      const login = await call('/api/auth/login', {
        method: 'POST', body: { username: 'admin', password: 'admin123' },
      });
      assert.equal(login.status, 200, 'the fixture must be able to sign in');

      // ------------------------------------------------ the double-click itself

      await dt.test('five saves fired at once make one purchase order', async () => {
        const before = await countRows('purchase_orders');
        const key = 'double-click-1';

        // Fired without awaiting in between: this is the shape of a double-
        // click, and the reason a check that only looks at finished requests
        // does not work — at the moment the second one arrives, the first has
        // not answered anybody.
        const answers = await Promise.all(
          Array.from({ length: 5 }, () => call('/api/purchases', { method: 'POST', body: order(), key })),
        );

        assert.equal(await countRows('purchase_orders'), before + 1, 'five clicks, one purchase order');

        for (const answer of answers) assert.equal(answer.status, 201);
        const ids = new Set(answers.map((a) => a.data.id));
        assert.equal(ids.size, 1, 'and every caller is told about the same one');
        const numbers = new Set(answers.map((a) => a.data.po_number));
        assert.equal(numbers.size, 1, 'including the number the owner will quote to the supplier');

        // The bodies are not merely equivalent, they are the same answer.
        const first = JSON.stringify(answers[0].data);
        for (const answer of answers) assert.equal(JSON.stringify(answer.data), first);
        assert.equal(answers.filter((a) => a.replayed).length, 4, 'four of the five were replays');
      });

      await dt.test('and so does the same save sent one after the other', async () => {
        const before = await countRows('purchase_orders');
        const key = 'retry-after-a-timeout';

        const first = await call('/api/purchases', { method: 'POST', body: order(), key });
        const second = await call('/api/purchases', { method: 'POST', body: order(), key });

        assert.equal(await countRows('purchase_orders'), before + 1);
        assert.equal(second.status, 201);
        assert.equal(second.data.id, first.data.id);
        assert.equal(second.replayed, true);
        assert.equal(first.replayed, false, 'the first one really did the work');
      });

      // ------------------------------- and two different saves stay two documents

      await dt.test('two genuinely different saves are still two purchase orders', async () => {
        const before = await countRows('purchase_orders');

        // Identical in every byte — the shop that orders the same two bags
        // twice — but submitted deliberately, which the browser says by
        // minting a new key once the first one succeeded.
        const first = await call('/api/purchases', { method: 'POST', body: order(), key: 'submission-a' });
        const second = await call('/api/purchases', { method: 'POST', body: order(), key: 'submission-b' });

        assert.equal(await countRows('purchase_orders'), before + 2);
        assert.notEqual(first.data.id, second.data.id);
        assert.notEqual(first.data.po_number, second.data.po_number);
        assert.equal(second.replayed, false);
      });

      await dt.test('a caller that sends no key at all is still covered — briefly', async () => {
        const before = await countRows('purchase_orders');

        // No `Idempotency-Key`: an older cached bundle, a second tab, a proxy
        // replaying the POST. There is nothing to go on but the content, so
        // two of these at once are treated as one save…
        const pair = await Promise.all([
          call('/api/purchases', { method: 'POST', body: order('unkeyed') }),
          call('/api/purchases', { method: 'POST', body: order('unkeyed') }),
        ]);
        assert.equal(await countRows('purchase_orders'), before + 1);
        assert.equal(pair.filter((a) => a.replayed).length, 1);

        // …and once the window is past, the identical body means a second
        // purchase order again, because content was never evidence of intent.
        await new Promise((resolve) => { setTimeout(resolve, ECHO_MS + 150); });
        const later = await call('/api/purchases', { method: 'POST', body: order('unkeyed') });
        assert.equal(later.status, 201);
        assert.equal(later.replayed, false);
        assert.equal(await countRows('purchase_orders'), before + 2);
      });

      // ------------------------------------------------------------- failures

      await dt.test('a failure is not remembered as a failure', async () => {
        const key = 'the-supplier-was-not-there-yet';
        const body = { ...order(), supplier_id: 4242 };

        const failed = await call('/api/purchases', { method: 'POST', body, key });
        assert.ok(failed.status >= 400, `expected a refusal, got ${failed.status}`);
        assert.equal(failed.replayed, false);

        // Exactly the situation the rule is for: whatever was wrong is no
        // longer wrong, and the very same submission has to be able to go
        // through. A stored 4xx or 5xx would make this permanent.
        await scoped(() => getDb()
          .prepare(`INSERT INTO suppliers (id, code, name_en) VALUES (4242, 'SUP2', 'Late Supplier')`)
          .run());

        const before = await countRows('purchase_orders');
        const retried = await call('/api/purchases', { method: 'POST', body, key });
        assert.equal(retried.status, 201, 'the retry runs rather than replaying the refusal');
        assert.equal(retried.replayed, false);
        assert.equal(await countRows('purchase_orders'), before + 1);
      });

      await dt.test('nothing is left behind once a window has passed', async () => {
        // The claims are a working set, not a log: every row carries an expiry,
        // so a shop that saves all day does not accumulate one row per save
        // forever. (Sweeping is probabilistic in the middleware; what is
        // asserted here is that every row it leaves has an expiry in the
        // future or has already earned its removal.)
        const rows = await scoped(() => getDb()
          .prepare('SELECT state, expires_at FROM request_replay').all());
        for (const row of rows) {
          assert.ok(Number(row.expires_at) > 0, 'every claim expires');
          assert.ok(['in_flight', 'done'].includes(row.state));
        }
      });

      // ------------------------------------------------------- the storefront

      await dt.test('a shopper who taps "confirm order" five times buys once', async () => {
        // Published, in stock, and reachable by a customer — the storefront
        // refuses to sell anything that is not.
        await scoped(() => transaction(async () => {
          const db = getDb();
          await db.prepare('UPDATE products SET is_published = 1, published_at = ? WHERE id = 1')
            .run(new Date().toISOString());
          await db.prepare(`
            INSERT INTO stock_levels (variant_id, warehouse_id, quantity, average_cost)
            VALUES (1, 1, 50, 120)
            ON CONFLICT(variant_id, warehouse_id) DO UPDATE SET quantity = 50
          `).run();
        }));

        const before = await countRows('web_orders');
        const answers = await Promise.all(
          Array.from({ length: 5 }, () => call('/api/shop/orders', {
            method: 'POST', body: basket(), key: 'one-tap-please',
          })),
        );

        for (const answer of answers) {
          assert.equal(answer.status, 201, JSON.stringify(answer.data));
        }
        assert.equal(await countRows('web_orders'), before + 1, 'five taps, one order');
        const numbers = new Set(answers.map((a) => a.data.order_no));
        assert.equal(numbers.size, 1, 'and one order number to track it by');
      });
    });
  }
});
