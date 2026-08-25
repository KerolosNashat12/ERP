/**
 * The two reports the owner asked for by name, and the arithmetic behind them.
 *
 *   *"تقرير شامل كل مصاريف المحل … عشان اكون عارف انا صارف كام لحد دلوقتي علي
 *   المحل"* and *"تقرير يوضح كل المكسب للمحل بعد خصم كل حاجه"*
 *
 * The first is `shop_spend` and the second is `profit_and_costs`, which already
 * existed and was grown rather than cloned — two reports that differ only by
 * their date range is how a shop owner stops believing either.
 *
 * What is checked here, and what each one would let through if it were missing:
 *
 *   · **The exact figure.** A fixture with no rounding in it and every tile
 *     asserted to the penny. A spend report that is approximately right is a
 *     report the owner will one day reconcile against his bank and abandon.
 *   · **The rows are the total.** Every row is disjoint and they sum to the
 *     headline. Wages are a subset of costs everywhere else in this system, so
 *     the one place they are split out is the one place they could be counted
 *     twice.
 *   · **The two reports agree where they overlap.** The costs and the wages
 *     are the same figure in both, computed by different queries. They are
 *     asserted equal, because the day they disagree is the day both are worth
 *     nothing.
 *   · **What is spent is not what is owed and not what is on order.** A
 *     payment that was REVERSED is money that never left. Goods received and
 *     unpaid are owed and shown separately. An order raised and not received
 *     is in neither and is named in a warning rather than silently dropped.
 *   · **The blind spots are said out loud.** Opening stock, and items sold
 *     with no cost recorded, both appear as warnings carrying their own
 *     numbers — in both languages.
 *   · **A paper invoice from the archive moves neither report.** Filed and
 *     paid through its own routes; every figure in both reports is
 *     byte-identical before and after.
 *   · **The wage bill stays behind the costs permission**, in the catalogue
 *     and on the route, because the report centre must not be a side door.
 *
 * Everything that touches a database runs twice, once per driver: `node:sqlite`
 * is the shop counter, libSQL against a local file is the same client,
 * statement encoding and row decoding a hosted Turso deployment uses. The
 * harness is the one `costs-payroll.test.js` established next door.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'spend-and-profit-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { REPORTS, reportService } = await import('../src/services/ReportService.js');

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

async function call(pathname, { method = 'GET', body, as, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as === null ? {} : { cookie: as || cookie }),
      'Idempotency-Key': `t-${Math.random().toString(36).slice(2)}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  // Only the default identity keeps the module-level cookie: a call made
  // `as` somebody else must not sign this test in as them for good.
  if (setCookie && as === undefined) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers, cookie: setCookie?.split(';')[0] };
}

const query = (sql, ...params) => scoped(() => getDb().prepare(sql).get(...params));
const round = (n) => Math.round(n * 100) / 100;

/**
 * A shop with round numbers in it, so every total below can be asserted rather
 * than approximated.
 *
 * ── sales, all in March ──────────────────────────────────────────────────
 *   INV-1   10,000 revenue against 4,000 of goods
 *   INV-2    5,000 revenue against 2,000 of goods
 *   INV-3    1,000 revenue against     0 of goods   ← sold with no cost known
 * ── one return, in March ────────────────────────────────────────────────
 *   RET-1    1,200 refunded; one item back on the shelf that cost 500, and
 *            one written off that cost 100 (its cost stays a cost)
 * ── opening stock ───────────────────────────────────────────────────────
 *   30 units the shop already had: 20 valued at 25 each, 10 with no cost
 *
 * Everything else — the suppliers, the orders, the payments, the costs and the
 * wages — is written through the real HTTP routes inside the test, because
 * those are the write paths the figures have to come out of.
 */
async function seed(connection) {
  await runWithTenant(null, connection, async () => {
    await runMigrations();
    await seedBaseline();
    await transaction(async () => {
      const db = getDb();
      await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (1,'S1','Cairo Leather','جلود القاهرة')").run();
      await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (2,'S2','Nile Straps','سيور النيل')").run();
      await db.prepare("INSERT INTO products (id, sku_prefix, name_en, name_ar) VALUES (1,'P1','Belt','حزام')").run();
      await db.prepare("INSERT INTO product_variants (id, product_id, sku, cost_price, selling_price) VALUES (1,1,'P1-A',25,60)").run();
      await db.prepare("INSERT INTO product_variants (id, product_id, sku, cost_price, selling_price) VALUES (2,1,'P1-B',25,60)").run();

      const sale = `INSERT INTO sales (id, invoice_no, sale_date, warehouse_id, status, subtotal,
                      discount_amount, tax_amount, total_amount, total_cost, paid_amount,
                      payment_method, created_by)
                    VALUES (?,?,?,1,'completed',?,0,0,?,?,?,'cash',1)`;
      await db.prepare(sale).run(1, 'INV-1', '2026-03-05', 10000, 10000, 4000, 10000);
      await db.prepare(sale).run(2, 'INV-2', '2026-03-12', 5000, 5000, 2000, 5000);
      await db.prepare(sale).run(3, 'INV-3', '2026-03-18', 1000, 1000, 0, 1000);
      const line = `INSERT INTO sale_lines (sale_id, variant_id, sku, description, quantity,
                      unit_price, unit_cost, line_total) VALUES (?,1,'P1-A','Belt',?,?,?,?)`;
      await db.prepare(line).run(1, 100, 100, 40, 10000);
      await db.prepare(line).run(2, 50, 100, 40, 5000);
      // The one that cost nothing anybody recorded — the honesty check's fixture.
      await db.prepare(line).run(3, 10, 100, 0, 1000);

      await db.prepare(`INSERT INTO sales_returns (id, return_no, sale_id, warehouse_id, return_date,
                          reason_code, subtotal, total_amount, items_restocked, items_written_off, created_by)
                        VALUES (1,'RET-1',1,1,'2026-03-20','changed_mind',1200,1200,1,1,1)`).run();
      const rline = `INSERT INTO sales_return_lines (return_id, variant_id, sku, quantity,
                       unit_price, unit_cost, line_total, condition) VALUES (1,1,'P1-A',1,?,?,?,?)`;
      await db.prepare(rline).run(700, 500, 700, 'resellable');
      await db.prepare(rline).run(500, 100, 500, 'damaged');

      const opening = `INSERT INTO stock_movements (variant_id, warehouse_id, movement_type,
                         quantity, unit_cost, balance_after, created_at)
                       VALUES (?,1,'opening_balance',?,?,?, '2026-03-01T08:00:00.000Z')`;
      await db.prepare(opening).run(1, 20, 25, 20);
      await db.prepare(opening).run(2, 10, 0, 10);
    });
  });
}

/** A real (tiny) JPEG — the archive will not file an invoice with no photograph. */
function jpeg() {
  const bytes = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

const MARCH = 'dateFrom=2026-03-01&dateTo=2026-03-31';
const spend = async (q = MARCH) => (await call(`/api/reports/shop_spend?${q}`)).data;
const profit = async (q = MARCH) => (await call(`/api/reports/profit_and_costs?${q}`)).data;
const warned = (report, code) => (report.warnings || []).find((w) => w.code === code);

// ============================================================ no database yet

test('both reports are declared the way a report that shows the wage bill has to be', async (t) => {
  await t.test('each needs a second permission, in the module that sells it', () => {
    for (const key of ['shop_spend', 'profit_and_costs']) {
      // `requirePermission` enforces the tenant's module entitlement against
      // the MATCHED code, so naming `costs.view` here is also what stops a
      // shop whose plan has no costs module reading its own wages out of the
      // report centre. The module on the definition has to agree with it.
      assert.equal(REPORTS[key].permission, 'costs.view', `${key} names the second permission`);
      assert.equal(REPORTS[key].module, 'costs', `${key} belongs to the module that gates it`);
      assert.equal(reportService.permissionFor(key), 'costs.view');
    }
  });

  await t.test('both open on the shop\'s whole history, not on this month', () => {
    // The question has no month in it. Every other report in the centre keeps
    // the screen's usual "this month so far".
    assert.equal(REPORTS.shop_spend.defaultRange, 'all');
    assert.equal(REPORTS.profit_and_costs.defaultRange, 'all');
    const monthly = Object.entries(REPORTS)
      .filter(([, def]) => def.defaultRange === 'all').map(([key]) => key);
    assert.deepEqual(monthly.sort(), ['profit_and_costs', 'shop_spend']);
  });

  await t.test('every string is in both languages', () => {
    for (const key of ['shop_spend', 'profit_and_costs']) {
      const definition = REPORTS[key];
      assert.ok(definition.titleAr && definition.titleAr !== definition.titleEn, `${key} title`);
      assert.ok(definition.noteAr && definition.noteAr !== definition.noteEn, `${key} note`);
      for (const column of definition.columns) {
        assert.ok(column.labelEn, `${key}.${column.key} has an English label`);
        assert.ok(column.labelAr, `${key}.${column.key} has an Arabic label`);
        assert.notEqual(column.labelAr, column.labelEn,
          `${key}.${column.key} falls back to English in an Arabic report`);
      }
    }
  });
});

// ================================================================== over HTTP

test('what the shop has spent, and what it has actually made', async (t) => {
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

      const category = async (code) => (await query('SELECT id FROM cost_categories WHERE code = ?', code)).id;

      // ------------------------------------------------------- goods bought
      //   PO-1  6,000 — fully received, paid 4,000 then 2,000 → 6,000 out
      //   PO-2  3,000 — fully received, paid 1,000            → 2,000 owed
      //   PO-3  2,500 — ordered, nothing received, nothing paid
      // and a fourth payment of 900 against PO-1 that is REVERSED, which must
      // leave every figure exactly where it was.
      const raise = async (supplierId, unitCost, quantity, orderDate) => {
        const created = await call('/api/purchases', {
          method: 'POST',
          body: {
            supplier_id: supplierId,
            order_date: orderDate,
            status: 'ordered',
            discount_amount: 0,
            shipping_amount: 0,
            lines: [{ variant_id: 1, quantity_ordered: quantity, unit_cost: unitCost }],
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        return created.data;
      };
      const po1 = await raise(1, 60, 100, '2026-03-02');
      const po2 = await raise(2, 60, 50, '2026-03-08');
      const po3 = await raise(1, 50, 50, '2026-03-25');
      assert.equal(po1.total_amount, 6000);
      assert.equal(po2.total_amount, 3000);
      assert.equal(po3.total_amount, 2500);

      const receive = async (order, quantity) => {
        const lines = (await call(`/api/purchases/${order.id}`)).data.lines;
        const done = await call(`/api/purchases/${order.id}/receive`, {
          method: 'POST', body: { receipts: [{ line_id: lines[0].id, quantity }] },
        });
        assert.equal(done.status, 200, JSON.stringify(done.data));
      };
      await receive(po1, 100);
      await receive(po2, 50);

      const pay = async (order, amount, paidOn) => {
        const done = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST', body: { amount, paidOn, method: 'cash' },
        });
        assert.equal(done.status, 200, JSON.stringify(done.data));
        return done.data.payment;
      };
      await pay(po1, 4000, '2026-03-03');
      await pay(po1, 2000, '2026-03-10');
      await pay(po2, 1000, '2026-03-09');

      // ------------------------------------------------------- costs & wages
      const cost = async (code, amount, spentOn) => {
        const done = await call('/api/costs', {
          method: 'POST',
          body: {
            category_id: await category(code), amount, spent_on: spentOn, description: code,
          },
        });
        assert.equal(done.status, 201, JSON.stringify(done.data));
      };
      await cost('RENT', 4000, '2026-03-01');
      await cost('ELECTRICITY', 1180, '2026-03-18');
      await cost('TAXES', 820, '2026-03-22');

      const hire = async (name, amount) => {
        const done = await call('/api/employees', {
          method: 'POST',
          body: {
            name, job_title: 'Assistant', salary_amount: amount,
            salary_period: 'month', hired_on: '2026-03-01',
          },
        });
        assert.equal(done.status, 201, JSON.stringify(done.data));
        return done.data;
      };
      const hoda = await hire('Hoda Kamal', 3000);
      const mahmoud = await hire('Mahmoud Sayed', 2000);
      for (const [person, amount] of [[hoda, 3000], [mahmoud, 2000]]) {
        const paid = await call(`/api/employees/${person.id}/payments`, {
          method: 'POST',
          body: {
            amount, paid_on: '2026-03-28', period_start: '2026-03-01', period_end: '2026-03-31',
          },
        });
        assert.ok(paid.status < 300, JSON.stringify(paid.data));
      }

      // ------------------------------------------------------ the exact figure
      await dt.test('every total is the arithmetic, to the penny', async () => {
        const report = await spend();
        assert.deepEqual(report.summary, {
          // 6,000 to Cairo Leather + 1,000 to Nile Straps
          goods_paid: 7000,
          // rent 4,000 + electricity 1,180 + taxes 820
          costs_paid: 6000,
          // two salaries
          wages_paid: 5000,
          spent_cash: 18000,
          // PO-2 arrived and 2,000 of it is still unpaid. PO-3 was never
          // received, so nothing of its 2,500 is owed.
          owed_to_suppliers: 2000,
          total_committed: 20000,
          first_spend: '2026-03-01',
        });
      });

      await dt.test('the rows are the total — nothing counted twice, nothing dropped', async () => {
        const report = await spend();
        const total = report.rows.reduce((sum, row) => sum + row.amount, 0);
        assert.equal(Math.round(total * 100) / 100, report.summary.spent_cash);
        assert.equal(Math.round(report.rows.reduce((s, r) => s + r.share_percent, 0)), 100);

        const bucket = (name) => report.rows.filter((row) => row.bucket === name);
        assert.deepEqual(bucket('goods').map((r) => [r.detail_en, r.amount]),
          [['Cairo Leather', 6000], ['Nile Straps', 1000]]);
        // Costs by what they were for; wages by WHO they paid — and the two
        // together are the costs ledger, once.
        assert.deepEqual(bucket('costs').map((r) => [r.detail_en, r.amount]),
          [['Rent', 4000], ['Electricity', 1180], ['Taxes', 820]]);
        assert.deepEqual(bucket('wages').map((r) => [r.detail_en, r.amount]),
          [['Hoda Kamal', 3000], ['Mahmoud Sayed', 2000]]);
      });

      await dt.test('the profit report is the other question, and its arithmetic holds', async () => {
        const report = await profit();
        assert.deepEqual(report.summary, {
          months: 1,
          // 10,000 + 5,000 + 1,000
          revenue: 16000,
          refunds: 1200,
          // 6,000 of goods sold, less the 500 that came back sellable. The 100
          // that came back damaged stays a cost — the money for it is gone.
          cogs: 5500,
          // 16,000 − 1,200 − 5,500
          gross_profit: 9300,
          // the same 11,000 the spend report calls costs + wages
          costs: 11000,
          wages: 5000,
          // Nothing was broken, lost or stolen in this fixture, so the shop
          // lost nothing beyond what it spent. The line is still here: a zero
          // that is printed is a zero somebody has checked.
          wastage: 0,
          net_profit: -1700,
        });
        const march = report.rows.find((row) => row.month === '2026-03');
        assert.equal(march.revenue - march.refunds - march.cogs, march.gross_profit,
          'a reader must be able to add up the row he is looking at');
        assert.equal(march.gross_profit - march.costs - march.wastage, march.net_profit);
        // 14,800 kept, 1,700 lost.
        assert.equal(march.net_margin_percent, -11.49);
      });

      await dt.test('the two reports agree where they overlap', async () => {
        // Different queries, different shapes, the same money. The day these
        // two disagree is the day neither is worth reading.
        const [out, made] = [await spend(), await profit()];
        assert.equal(
          Math.round((out.summary.costs_paid + out.summary.wages_paid) * 100) / 100,
          made.summary.costs,
        );
        assert.equal(out.summary.wages_paid, made.summary.wages);
      });

      await dt.test('a reversed payment is money that never left', async () => {
        const before = await spend();
        // Against PO-2, which still has 2,000 outstanding — PO-1 is settled
        // and the service is right to refuse an overpayment on it.
        const payment = await pay(po2, 900, '2026-03-11');
        const withIt = await spend();
        assert.equal(withIt.summary.spent_cash, before.summary.spent_cash + 900,
          'while it stands it is spent');

        const reversed = await call(`/api/purchases/${po2.id}/payments/${payment.id}/reverse`, {
          method: 'POST', body: { reason: 'entered against the wrong order' },
        });
        assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
        assert.deepEqual((await spend()).summary, before.summary,
          'reversing it puts every figure back exactly where it was');
      });

      await dt.test('an order raised and not received is counted nowhere, and says so', async () => {
        const report = await spend();
        // PO-3 is 2,500 and appears in none of the three figures.
        assert.equal(report.summary.spent_cash, 18000);
        assert.equal(report.summary.owed_to_suppliers, 2000);
        assert.equal(report.summary.total_committed, 20000);
        const warning = warned(report, 'on_order_not_counted');
        assert.ok(warning, 'the report names it rather than dropping it');
        assert.match(warning.en, /2500/);
        assert.match(warning.ar, /2500/);
      });

      await dt.test('stock the shop had before the system is missing, and the report says so', async () => {
        for (const report of [await spend(), await profit()]) {
          const warning = warned(report, 'opening_stock');
          assert.ok(warning, `${report.key} admits the opening stock`);
          assert.match(warning.en, /30 unit/);
          // 20 units at 25 each; the other ten have no cost at all.
          assert.match(warning.en, /500/);
          assert.match(warning.en, /10 of them carry no cost/);
          assert.match(warning.ar, /30 قطعة/);
          assert.match(warning.ar, /10 قطعة من غير تكلفة/);
        }
      });

      await dt.test('an item sold with no cost is named, because it flatters the profit', async () => {
        const report = await profit();
        const warning = warned(report, 'sold_without_cost');
        assert.ok(warning, 'the profit report admits what it could not cost');
        assert.match(warning.en, /10 unit/);
        assert.match(warning.en, /1000/);
        assert.ok(warning.ar.includes('10'));
        // And the window it covers is stated, so "nothing before March" reads
        // as "the shop was not here", not as "the shop spent nothing".
        assert.ok(warned(report, 'coverage'), 'the first recorded date is stated');
        assert.ok(warned(report, 'window'), 'a filtered window says it is not the whole history');
      });

      await dt.test('all-time is the default, and it reaches further than the month', async () => {
        // No dates at all — what the screen sends for these two.
        const lifetime = (await call('/api/reports/shop_spend')).data;
        assert.equal(lifetime.defaultRange, 'all');
        assert.equal(lifetime.summary.spent_cash, 18000);
        assert.ok(!warned(lifetime, 'window'), 'no window warning when there is no window');

        // A cost outside March is invisible to the month and visible to the
        // lifetime — which is the whole reason the default moved.
        await cost('MAINTENANCE', 640.5, '2026-01-15');
        assert.equal((await spend()).summary.spent_cash, 18000, 'March is still March');
        const after = (await call('/api/reports/shop_spend')).data;
        assert.equal(after.summary.spent_cash, 18640.5);
        assert.equal(after.summary.first_spend, '2026-01-15');
      });

      await dt.test('money is rounded on the server, not left as float dust', async () => {
        await cost('SUPPLIES', 0.1, '2026-03-14');
        await cost('SUPPLIES', 0.2, '2026-03-15');
        const report = await spend();
        const supplies = report.rows.find((row) => row.detail_en === 'Shop supplies');
        assert.equal(supplies.amount, 0.3, '0.1 + 0.2 is 0.3 by the time it leaves the server');
        for (const [key, value] of Object.entries(report.summary)) {
          if (typeof value !== 'number') continue;
          assert.equal(value, Math.round(value * 100) / 100, `${key} carries more than two decimals`);
        }
      });

      await dt.test('the Arabic export says the Arabic words', async () => {
        const report = await spend();
        const arabic = reportService.toCsv(report, 'ar');
        const english = reportService.toCsv(report, 'en');
        assert.ok(arabic.includes('جلود القاهرة'), 'the supplier is named in Arabic');
        assert.ok(arabic.includes('بضاعة من الموردين'), 'and so is the group it is in');
        assert.ok(english.includes('Cairo Leather'));
        assert.ok(!english.includes('جلود القاهرة'), 'and the English export is English');
        // Both halves of every pair are on the row, which is what lets the
        // screen and the export agree without a second request.
        assert.ok(report.rows.every((row) => row.group_en && row.group_ar));
      });

      /**
       * The fence, from the other side.
       *
       * The archive of paper invoices is a record and not a transaction: it
       * must not reach stock, costs, profit or a supplier balance. Its own
       * tests prove that no other file can even query its tables. This proves
       * the consequence the owner actually cares about — the two reports that
       * add up everything he has spent and everything he has made do not move
       * when he files one and pays it.
       */
      await dt.test('a paper invoice from the archive moves neither report', async () => {
        const before = { out: await spend(), made: await profit() };

        const filed = await call('/api/legacy-invoices', {
          method: 'POST',
          body: {
            title: 'Old invoice book, page 4',
            supplier_id: 1,
            invoice_no: 'OLD-114',
            invoice_date: '2026-03-06',
            total_amount: 9500,
            photos: [{ dataUrl: jpeg(), thumbDataUrl: jpeg() }],
          },
        });
        assert.equal(filed.status, 201, JSON.stringify(filed.data));
        const settled = await call(`/api/legacy-invoices/${filed.data.id}/payments`, {
          method: 'POST', body: { amount: 9500, paidOn: '2026-03-07', method: 'cash' },
        });
        assert.ok(settled.status < 300, JSON.stringify(settled.data));

        const after = { out: await spend(), made: await profit() };
        assert.deepEqual(after.out.summary, before.out.summary,
          '9,500 filed and paid on paper is not 9,500 the shop spent through this system');
        assert.deepEqual(after.made.summary, before.made.summary);
        assert.deepEqual(after.out.rows, before.out.rows, 'and no row appeared for it either');
      });

      await dt.test('the wage bill stays behind the costs permission', async () => {
        const roles = await call('/api/users/roles');
        const cashier = roles.data.rows.find((row) => row.code === 'cashier');
        const created = await call('/api/users', {
          method: 'POST',
          body: {
            username: 'till', full_name: 'Till', password: 'password123', role_id: cashier.id,
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const theirs = (await call('/api/auth/login', {
          method: 'POST', as: null, body: { username: 'till', password: 'password123' },
        })).cookie;

        // Not offered in the catalogue...
        const catalogue = await call('/api/reports', { as: theirs });
        const offered = (catalogue.data?.rows || []).map((row) => row.key);
        assert.ok(!offered.includes('shop_spend'), 'not listed to somebody who cannot see costs');
        assert.ok(!offered.includes('profit_and_costs'));
        // ...and not reachable by typing the URL either.
        for (const key of ['shop_spend', 'profit_and_costs']) {
          const blocked = await call(`/api/reports/${key}`, { as: theirs });
          assert.equal(blocked.status, 403, `${key} is refused, not merely hidden`);
        }
        // The admin, who has costs.view, is offered both.
        const mine = (await call('/api/reports')).data.rows.map((row) => row.key);
        assert.ok(mine.includes('shop_spend') && mine.includes('profit_and_costs'));
      });

      /**
       * الهدر — what the shop LOST.
       *
       * A bottle knocked off the counter is money as surely as a bill is, and
       * until this test existed nothing in the system agreed: a damage
       * adjustment moved the stock level and then vanished from every figure
       * the owner could read. The shop was down a bottle and the books said it
       * had had a good month.
       *
       * Left last in this file on purpose: it is the only subtest that moves
       * the profit figures the ones above assert exactly.
       */
      await dt.test('what was broken, lost or stolen comes off the profit', async (wt) => {
        const before = await profit();
        assert.equal(before.summary.wastage, 0, 'nothing has been lost in this shop yet');

        const adjust = async (reason, counted) => {
          const created = await call('/api/inventory/adjustments', {
            method: 'POST',
            body: {
              reason,
              notes: `${reason} test`,
              // 20 on the shelf at 25 each; `counted` is what is really there.
              lines: [{ variant_id: 1, system_qty: 20, counted_qty: counted, unit_cost: 25 }],
            },
          });
          assert.equal(created.status, 201, JSON.stringify(created.data));
          return created.data;
        };

        await wt.test('a draft is not a loss — nobody has accepted it yet', async () => {
          await adjust('damage', 16);
          assert.equal((await profit()).summary.wastage, 0,
            'a draft adjustment counted as waste; it has not happened yet');
        });

        /**
         * A loss lands in the month it was ACCEPTED, which is the same rule
         * every other document here follows — so a document posted today is
         * correctly absent from a March report, and the fixture backdates it
         * rather than widening the window and proving nothing.
         */
        const backdate = (id, when) => scoped(() => getDb()
          .prepare('UPDATE stock_adjustments SET posted_at = ? WHERE id = ?')
          .run(when, id));

        await wt.test('posting four broken units costs the shop what they cost it', async () => {
          const draft = await adjust('damage', 16);
          const posted = await call(`/api/inventory/adjustments/${draft.id}/post`, { method: 'POST' });
          assert.equal(posted.status, 200, JSON.stringify(posted.data));
          assert.equal((await profit()).summary.wastage, 0,
            'posted today, so a March report must not show it');
          await backdate(draft.id, '2026-03-22T10:00:00.000Z');

          const report = await profit();
          // Four units at 25.
          assert.equal(report.summary.wastage, 100);
          // Everything above it is untouched: waste is not a cost in the
          // ledger — no money left the till — and it is not a cost of goods
          // sold, because nobody sold them.
          assert.equal(report.summary.revenue, before.summary.revenue);
          assert.equal(report.summary.cogs, before.summary.cogs);
          assert.equal(report.summary.gross_profit, before.summary.gross_profit);
          assert.equal(report.summary.costs, before.summary.costs);
          // And it lands where it belongs: on the bottom line.
          assert.equal(report.summary.net_profit, before.summary.net_profit - 100);
        });

        await wt.test('a stock-take correction is not waste, it is an error being fixed', async () => {
          const withWaste = (await profit()).summary.wastage;
          const draft = await adjust('correction', 12);
          const done = await call(`/api/inventory/adjustments/${draft.id}/post`, { method: 'POST' });
          assert.equal(done.status, 200, JSON.stringify(done.data));
          await backdate(draft.id, '2026-03-23T10:00:00.000Z');
          assert.equal((await profit()).summary.wastage, withWaste,
            'a miscount found and fixed was counted as a loss — every stock count '
            + 'would then read as a disaster');
        });

        await wt.test('the row a person reads still adds up', async () => {
          const march = (await profit()).rows.find((row) => row.month === '2026-03');
          assert.equal(
            round(march.revenue - march.refunds - march.cogs), march.gross_profit,
          );
          assert.equal(
            round(march.gross_profit - march.costs - march.wastage), march.net_profit,
          );
        });
      });
    });
  }
});
