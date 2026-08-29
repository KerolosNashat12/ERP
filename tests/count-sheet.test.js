/**
 * THE STOCK COUNT SHEET HAS TO BE THE WHOLE SHOP, OR SAY THAT IT IS NOT.
 *
 * The bug this file exists for: `buildCountSheet()` asked `stockOnHand()` for
 * one page of 1000 and returned it. `stockOnHand()` clamps `pageSize` to 1000.
 * So a shop with more than a thousand active variants got a sheet that stopped
 * at the thousandth name in alphabetical order, with nothing on the screen
 * saying so — the ERP toasted "1000 products" as though that were the shop.
 *
 * Nothing gets written off by it: posting an adjustment only touches the lines
 * it carries. What is lost is the point of counting. The shop believes it has
 * counted itself, and the discrepancy the count existed to find is sitting in
 * the part that never appeared on the sheet.
 *
 * It was found by a smoke test failing on an unrelated day — the seeded
 * catalogue crossed a thousand variants and a variant that had always been on
 * the sheet fell off the end of it. That is luck, not coverage, which is why
 * this file is here.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'count-sheet-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { initDb, closeDb, applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { InventoryService } = await import('../src/services/InventoryService.js');

/**
 * A stand-in for the repository, because the thing under test is how the
 * service PAGES — and a fake is the only way to hold a shop of a given size
 * without inserting thousands of rows for every case.
 *
 * It reproduces the two behaviours that caused the bug and would hide it:
 *   · `pageSize` is clamped to 1000, exactly as the real one does;
 *   · `total` reports the whole shop regardless of what one page returned.
 */
function fakeInventory(variantCount) {
  const all = Array.from({ length: variantCount }, (_, i) => ({
    variant_id: i + 1,
    sku: `SKU-${String(i + 1).padStart(5, '0')}`,
    product_name_en: `Product ${String(i + 1).padStart(5, '0')}`,
    product_name_ar: `منتج ${i + 1}`,
    variant_label: '',
    quantity: 3,
    average_cost: 10,
  }));
  const calls = [];
  return {
    calls,
    async stockOnHand({ page = 1, pageSize = 50 }) {
      const size = Math.min(Math.max(Number(pageSize) || 50, 1), 1000);
      const current = Math.max(Number(page) || 1, 1);
      calls.push({ page: current, pageSize: size });
      return {
        rows: all.slice((current - 1) * size, current * size),
        total: all.length,
        page: current,
        pageSize: size,
        pages: Math.ceil(all.length / size) || 1,
      };
    },
  };
}

const serviceFor = (variantCount) => {
  const inventory = fakeInventory(variantCount);
  const service = new InventoryService({ inventory });
  // The sheet's only other dependency: which warehouse it is counting.
  service.locationId = async () => 1;
  return { service, inventory };
};

test('a shop smaller than one page is fetched in one page', async () => {
  const { service, inventory } = serviceFor(40);
  const sheet = await service.buildCountSheet({});
  assert.equal(sheet.rows.length, 40);
  assert.equal(sheet.total, 40);
  assert.equal(sheet.truncated, false);
  assert.equal(inventory.calls.length, 1, 'a small shop should not cost extra round trips');
});

test('a shop of exactly one page does not ask for a second', async () => {
  /*
   * The off-by-one that a `while (rows.length === pageSize)` loop gets wrong:
   * 1000 of 1000 is complete, and asking again would be a wasted query on
   * every stock take in a shop of exactly that size.
   */
  const { service, inventory } = serviceFor(1000);
  const sheet = await service.buildCountSheet({});
  assert.equal(sheet.rows.length, 1000);
  assert.equal(sheet.truncated, false);
  assert.equal(inventory.calls.length, 1);
});

test('a shop LARGER than one page is counted whole — this is the bug', async () => {
  /*
   * 1,430 variants: the shape of a real shop that has been trading for a while,
   * and one page more than the old code could see.
   */
  const { service, inventory } = serviceFor(1430);
  const sheet = await service.buildCountSheet({});

  assert.equal(sheet.total, 1430);
  assert.equal(sheet.rows.length, 1430, 'the sheet stopped short of the shop');
  assert.equal(sheet.truncated, false);
  assert.ok(inventory.calls.length > 1, 'only one page was ever requested');

  // Named, not counted: the last variant alphabetically is the one that fell
  // off the end before, and counting the rows would pass if the second page
  // repeated the first.
  const ids = sheet.rows.map((r) => r.variant_id);
  assert.equal(new Set(ids).size, 1430, 'a page came back twice');
  assert.ok(ids.includes(1430), 'the last line in the shop is not on the sheet');
  assert.ok(ids.includes(1001), 'the first line past the old cut is not on the sheet');
});

test('every line is pre-filled with what the system believes, and no difference yet', async () => {
  const { service } = serviceFor(1200);
  const sheet = await service.buildCountSheet({});
  for (const row of sheet.rows) {
    assert.equal(row.counted_qty, row.system_qty);
    assert.equal(row.difference, 0);
    assert.ok(row.sku, 'a line with no SKU cannot be counted by a person');
  }
});

test('a shop too big for one sheet is capped — and SAYS so', async () => {
  /*
   * The ceiling stays: a sheet is a table a person scrolls while walking a
   * shop. What must never happen again is the cap being silent, so the
   * flag and the real total are the assertion, not the cap itself.
   */
  const { service } = serviceFor(9000);
  const sheet = await service.buildCountSheet({});
  assert.equal(sheet.truncated, true, 'a capped sheet reported itself as complete');
  assert.equal(sheet.total, 9000, 'the shop\'s real size is not reported');
  assert.ok(sheet.rows.length < 9000);
  assert.ok(sheet.rows.length >= 1000, 'the cap is too low to count anything with');
});

test('the endpoint hands the browser the whole answer, not just the rows', async (t) => {
  /*
   * The service can be as honest as it likes; if the route drops `total` and
   * `truncated` on the way out, the clerk is back to being told nothing. This
   * runs against the real database and the real router.
   */
  const http = await import('node:http');
  const { createApp } = await import('../src/server.js');

  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  const server = await new Promise((resolve) => {
    const listening = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];

  const res = await fetch(`${base}/api/inventory/count-sheet`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.rows), 'the sheet has no rows');
  assert.equal(typeof body.total, 'number', 'the browser is not told how big the shop is');
  assert.equal(typeof body.truncated, 'boolean', 'the browser cannot tell a partial sheet from a whole one');
  assert.equal(body.truncated, false);
  assert.equal(body.rows.length, body.total, 'a seeded shop should fit on one sheet');
});
