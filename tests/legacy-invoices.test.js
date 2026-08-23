/**
 * فواتيرك — the archive of paper invoices, and the promise that it stays out
 * of the shop's accounts.
 *
 * The owner asked for a page to file the invoices he already had on paper, and
 * in the same breath for the one rule that shapes it:
 *
 *   *"والصفحه دي كلها لكل الداتا القديمه … متدخلهاش في حسابات السيستيم"*
 *
 * The last test in this file is the feature. Everything else is the machinery
 * that makes it worth having:
 *
 *   · The STATUS follows the payments and is never typed — including the case
 *     where there is no total yet to follow (`unknown`), and the case where a
 *     payment overshoots the total (settled, and said out loud rather than
 *     hidden).
 *   · The running total never disagrees with the rows it is the sum of, even
 *     when several payments are recorded at the same instant. This is the one
 *     that decides whether the implementation is real: a total that is read,
 *     incremented in JavaScript and written back loses one of any two payments
 *     that overlap, and the status derived from it would then be wrong too.
 *   · A payment that was wrong is REVERSED, not deleted, and the total and the
 *     status both give the money back.
 *   · Several photographs per invoice, and none of the bytes in a list.
 *   · And the double-count fence: every existing total in the system — the
 *     costs page, the profit report, the dashboard, the supplier's own balance,
 *     purchasing — is byte-identical before and after a legacy invoice is filed
 *     and paid. Twice over, in fact: once by measuring, and once by proving
 *     that no other source file in the codebase so much as mentions the two
 *     tables.
 *
 * Everything runs twice, once per driver: `node:sqlite` is the shop counter,
 * libSQL against a local file is the same client, statement encoding and row
 * decoding a hosted Turso deployment uses. The harness is the one
 * `supplier-payments.test.js` established next door.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'legacy-invoices-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { deriveStatus } = await import('../src/shared/legacyInvoices.js');

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

async function call(pathname, { method = 'GET', body, key, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      // A key of its own unless one is named: without it the idempotency guard
      // fingerprints identical POSTs and would collapse the concurrent payments
      // below into one, which is the opposite of what this file measures.
      'Idempotency-Key': key || `t-${Math.random().toString(36).slice(2)}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/**
 * A shop with a real history: a supplier, a product, a received purchase order
 * that moved stock and was paid for, and a cost. Every one of those feeds a
 * total that the archive must not disturb, which is what the last test needs.
 */
async function seed(connection) {
  await runWithTenant(null, connection, async () => {
    await runMigrations();
    await seedBaseline();
    await transaction(async () => {
      const db = getDb();
      await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (1, 'SUP1', 'Cairo Supplies', 'موردو القاهرة')").run();
      await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (2, 'SUP2', 'Ataba Bags', 'شنط العتبة')").run();
      await db.prepare(`
        INSERT INTO products (id, sku_prefix, name_en, name_ar, base_price, is_active)
        VALUES (1, 'BAG', 'Tote bag', 'شنطة', 250, 1)
      `).run();
      await db.prepare(`
        INSERT INTO product_variants (id, product_id, sku, cost_price, selling_price, is_active)
        VALUES (1, 1, 'BAG-1', 100, 250, 1)
      `).run();
    });
  });
}

const query = (sql, ...params) => scoped(() => getDb().prepare(sql).get(...params));
const queryAll = (sql, ...params) => scoped(() => getDb().prepare(sql).all(...params));

// ---------------------------------------------------------------- fixtures

/**
 * A real JPEG of a given weight — not random bytes with a header glued on.
 * `decodeImageDataUrl` sniffs the magic AND reads the frame header for
 * dimensions, so a fixture that satisfied only the first half would pass for
 * the wrong reason. Lifted deliberately from `supplier-payments.test.js`: the
 * attachment mechanism under both is the same one.
 */
function jpegOfBytes(bytes) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const tail = Buffer.from([0xff, 0xd9]);
  const padding = Math.max(0, bytes - head.length - tail.length - 4);
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([((padding + 2) >> 8) & 0xff, (padding + 2) & 0xff]),
    Buffer.alloc(padding, 0x20),
  ]);
  return Buffer.concat([head, comment, tail]);
}

const asDataUrl = (buffer, type = 'image/jpeg') =>
  `data:${type};base64,${buffer.toString('base64')}`;

const photo = (bytes = 40 * 1024) => ({
  dataUrl: asDataUrl(jpegOfBytes(bytes)),
  thumbDataUrl: asDataUrl(jpegOfBytes(2 * 1024)),
});

/** File one invoice. `total` may be omitted — that is the point of it. */
async function fileInvoice({
  title = 'Old invoice', supplierId = 1, total = 1000, pages = 1,
  invoiceNo = null, invoiceDate = '2024-05-11', notes = null,
} = {}) {
  const created = await call('/api/legacy-invoices', {
    method: 'POST',
    body: {
      title,
      supplier_id: supplierId,
      invoice_no: invoiceNo,
      invoice_date: invoiceDate,
      total_amount: total,
      notes,
      photos: Array.from({ length: pages }, () => photo(30 * 1024)),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

const pay = (id, body, key) => call(`/api/legacy-invoices/${id}/payments`, { method: 'POST', body, key });

/**
 * A shop with a REAL history: stock bought from the same supplier on a purchase
 * order that was received and part-paid, and an electricity bill on the costs
 * page.
 *
 * This exists for the last test in the file. Comparing every total before and
 * after only proves something if the totals are numbers: a snapshot of zeros
 * would match a snapshot of zeros no matter what the archive did.
 */
async function buildRealHistory() {
  const order = await call('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: 1,
      warehouse_id: 1,
      order_date: '2026-01-06',
      discount_amount: 0,
      shipping_amount: 0,
      lines: [{
        variant_id: 1, quantity_ordered: 20, unit_cost: 150, discount_percent: 0, tax_rate: 0,
      }],
    },
  });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  await call(`/api/purchases/${order.data.id}/approve`, { method: 'POST', body: {} });
  const lineId = order.data.lines[0].id;
  const received = await call(`/api/purchases/${order.data.id}/receive`, {
    method: 'POST', body: { receipts: [{ line_id: lineId, quantity: 20 }] },
  });
  assert.equal(received.status, 200, JSON.stringify(received.data));
  const paid = await call(`/api/purchases/${order.data.id}/payments`, {
    method: 'POST', body: { amount: 1200, method: 'cash', paidOn: '2026-01-20' },
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));

  const categories = await call('/api/cost-categories/options');
  const category = categories.data.rows.find((row) => row.kind !== 'salary');
  const cost = await call('/api/costs', {
    method: 'POST',
    body: {
      category_id: category.id, amount: 850, spent_on: '2026-01-18',
      description: 'Electricity', payment_method: 'cash',
    },
  });
  assert.equal(cost.status, 201, JSON.stringify(cost.data));
}

// ---------------------------------------------------------------- the tests

test('فواتيرك — a record of old paper that never reaches the shop\'s accounts', async (t) => {
  server = await new Promise((resolve) => {
    const listening = http.createServer((req, res) => scoped(() => app(req, res)))
      .listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  /**
   * The structural half of the double-count fence, and the only test here that
   * needs no database at all.
   *
   * Measuring that the totals did not move proves it for the aggregates that
   * exist TODAY. This proves it for the ones written next year: if nothing
   * outside the four files that own the feature can even name the tables, no
   * sum anywhere can be reading them. A report added later that joins
   * `legacy_invoices` into the profit figure fails here, loudly, with the file
   * named — which is exactly the moment somebody should be made to stop and
   * read `shared/legacyInvoices.js`.
   */
  await t.test('no other source file can read the two tables', () => {
    const allowed = new Set([
      'src/shared/legacyInvoices.js',
      'src/infrastructure/database/schema.js',
      'src/infrastructure/database/migrations/015-legacy-invoices.js',
      'src/infrastructure/repositories/LegacyInvoiceRepository.js',
      'src/services/LegacyInvoiceService.js',
      // The backup, which names `legacy_invoices` only to put an invoice into
      // the readable workbook ahead of its own payments. It copies every table
      // it finds in `sqlite_master` and sums nothing at all — and a shop's
      // backup had better contain its archive and the photographs in it.
      'src/platform/snapshot.js',
    ]);
    // Deliberately about SQL and not about the word: `legacy_invoices` is also
    // the MODULE name, and it is supposed to appear in permissions.js, in the
    // module ledger and on the routes. What may not appear anywhere else is a
    // query against the tables.
    const reads = /\b(from|into|update|join|table|exists\s*\(\s*select[\s\S]{0,80}from)\s+`?legacy_invoices?\b|legacy_invoice_payments/i;
    const root = path.join(here, '..', 'src');
    const offenders = [];
    const walk = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const relative = path.relative(path.join(here, '..'), full).split(path.sep).join('/');
        if (allowed.has(relative)) continue;
        if (reads.test(fs.readFileSync(full, 'utf8'))) offenders.push(relative);
      }
    };
    walk(root);
    assert.deepEqual(offenders, [],
      'a file outside the archive queries the archive\'s tables — read shared/legacyInvoices.js first');

    // And the guard itself works. Three of the five allowed files really do
    // contain SQL against the tables (the schema and the migration only
    // interpolate the shared string, which is the whole reason it is shared),
    // so a regex that had quietly stopped matching anything fails here rather
    // than reporting a clean sweep of nothing.
    for (const owner of [
      'src/shared/legacyInvoices.js',
      'src/infrastructure/repositories/LegacyInvoiceRepository.js',
      'src/services/LegacyInvoiceService.js',
    ]) {
      assert.ok(reads.test(fs.readFileSync(path.join(here, '..', owner), 'utf8')),
        `${owner} should query the tables — the detector above is not looking for the right thing`);
    }
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

      // ------------------------------------------------- the status follows

      await dt.test('the status is derived from the payments, never typed', async () => {
        const invoice = await fileInvoice({ title: 'Bags, March 2024', total: 1000 });
        assert.equal(invoice.status, 'unpaid', 'nothing paid yet');
        assert.equal(invoice.outstanding, 1000);

        const half = await pay(invoice.id, { amount: 400, method: 'cash', paidOn: '2024-06-01' });
        assert.equal(half.status, 200, JSON.stringify(half.data));
        assert.equal(half.data.status, 'partial');
        assert.equal(half.data.paid_amount, 400);
        assert.equal(half.data.outstanding, 600);

        const rest = await pay(invoice.id, { amount: 600, method: 'transfer', paidOn: '2024-07-01' });
        assert.equal(rest.data.status, 'paid');
        assert.equal(rest.data.paid_amount, 1000);
        assert.equal(rest.data.outstanding, 0);
        assert.equal(rest.data.over_paid, 0);

        // And a status a caller tried to type is ignored: it is not a writable
        // column, so the request cannot reach it.
        const forced = await call(`/api/legacy-invoices/${invoice.id}`, {
          method: 'PUT', body: { status: 'unpaid', paid_amount: 0 },
        });
        assert.equal(forced.status, 200);
        assert.equal(forced.data.status, 'paid', 'the status is the payments\' answer, not the caller\'s');
        assert.equal(forced.data.paid_amount, 1000);
      });

      await dt.test('an invoice with no amount yet is `unknown`, and typing the amount settles it', async () => {
        // The owner photographs a bill in the shop and reads the total off it
        // next week. A page that refuses the photograph until then is a page he
        // stops using — so this has to work, and the status has to be honest
        // rather than calling it unpaid.
        const invoice = await fileInvoice({ title: 'Unreadable receipt', total: null });
        assert.equal(invoice.total_amount, null);
        assert.equal(invoice.status, 'unknown');
        assert.equal(invoice.outstanding, null);

        // A payment can be recorded against it, and it is STILL unknown: 700
        // paid says nothing about whether the invoice is settled.
        const part = await pay(invoice.id, { amount: 700, method: 'cash' });
        assert.equal(part.data.status, 'unknown');
        assert.equal(part.data.paid_amount, 700);

        const named = await call(`/api/legacy-invoices/${invoice.id}`, {
          method: 'PUT', body: { total_amount: 900 },
        });
        assert.equal(named.data.status, 'partial', 'the amount arrives and the status follows at once');
        assert.equal(named.data.outstanding, 200);

        // And it can be un-said again — he read it wrong.
        const cleared = await call(`/api/legacy-invoices/${invoice.id}`, {
          method: 'PUT', body: { total_amount: null },
        });
        assert.equal(cleared.data.status, 'unknown');
        assert.equal(cleared.data.total_amount, null);
      });

      await dt.test('a payment that overshoots settles the invoice and says so', async () => {
        // Deliberately NOT refused, unlike a purchase order's payment: the
        // total here is a number somebody read off a photograph, and the
        // receipt in his hand is the better evidence of the two. What must not
        // happen is that the excess disappears quietly.
        const invoice = await fileInvoice({ title: 'Overpaid one', total: 500 });
        const over = await pay(invoice.id, { amount: 800, method: 'cash' });
        assert.equal(over.status, 200, JSON.stringify(over.data));
        assert.equal(over.data.status, 'paid');
        assert.equal(over.data.paid_amount, 800);
        assert.equal(over.data.outstanding, 0, 'nothing is owed — but nothing is negative either');
        assert.equal(over.data.over_paid, 300, 'and the excess is reported, not hidden');

        // Correcting the total the payment exceeded takes the flag away.
        const fixed = await call(`/api/legacy-invoices/${invoice.id}`, {
          method: 'PUT', body: { total_amount: 800 },
        });
        assert.equal(fixed.data.over_paid, 0);
        assert.equal(fixed.data.status, 'paid');
      });

      /**
       * The one that decides whether this is real.
       *
       * Six payments fired without awaiting in between, each with a key of its
       * own so the idempotency guard treats them as six deliberate
       * submissions. A running total that is read, incremented and written
       * back loses some of them — and the status derived from it would be
       * wrong in the same breath.
       */
      await dt.test('six payments recorded at the same instant all survive, and the status is the sum\'s', async () => {
        const invoice = await fileInvoice({ title: 'Concurrent', total: 233.31 });
        const amounts = [11.11, 22.22, 33.33, 44.44, 55.55, 66.66];    // 233.31

        const answers = await Promise.all(amounts.map((amount, index) => pay(
          invoice.id, { amount, method: 'cash' }, `legacy-concurrent-${index}`,
        )));
        for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.data));

        const rows = await queryAll(
          'SELECT amount FROM legacy_invoice_payments WHERE invoice_id = ? ORDER BY id', invoice.id,
        );
        assert.equal(rows.length, amounts.length, 'every payment left a row');

        const header = await query(
          'SELECT paid_amount, total_amount, status FROM legacy_invoices WHERE id = ?', invoice.id,
        );
        const summed = Math.round(rows.reduce((acc, row) => acc + row.amount, 0) * 100) / 100;
        assert.equal(header.paid_amount, summed, 'the running total is the sum of the rows');
        assert.equal(header.paid_amount, 233.31, 'and it is the sum that was actually paid');
        assert.equal(header.status, 'paid', 'the status is the status of that sum, computed with it');
      });

      await dt.test('the invariant holds for every record in the database', async () => {
        // Not a restatement of the test above: this sweeps everything the whole
        // file has done so far, the records other subtests left behind
        // included, and checks the status against the rule written in plain
        // JavaScript in shared/legacyInvoices.js rather than against the SQL
        // that produced it.
        const rows = await queryAll(`
          SELECT i.id, i.total_amount, i.paid_amount, i.status,
                 ROUND(COALESCE((SELECT SUM(p.amount) FROM legacy_invoice_payments p
                                 WHERE p.invoice_id = i.id AND p.status = 'recorded'), 0), 2) AS summed
          FROM legacy_invoices i
        `);
        assert.ok(rows.length >= 4, 'the sweep has something to sweep');
        for (const row of rows) {
          assert.ok(Math.abs(row.paid_amount - row.summed) < 0.001,
            `invoice ${row.id} disagrees with its own payments`);
          assert.equal(row.status, deriveStatus(row),
            `invoice ${row.id} carries a status its numbers do not support`);
        }
      });

      // ------------------------------------------------ a payment that was wrong

      await dt.test('a wrong payment is reversed, not deleted, and the status drops back with the total', async () => {
        const invoice = await fileInvoice({ title: 'Mistyped', total: 1000 });
        const wrong = await pay(invoice.id, { amount: 1000, method: 'cash' });
        assert.equal(wrong.data.status, 'paid');
        const paymentId = wrong.data.payment.id;

        const bare = await call(`/api/legacy-invoices/${invoice.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: '' },
        });
        assert.equal(bare.status, 422, 'a reversal has to say why');

        const reversed = await call(`/api/legacy-invoices/${invoice.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: 'Typed 1000 instead of 100' },
        });
        assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
        assert.equal(reversed.data.paid_amount, 0, 'the total gave the money back');
        assert.equal(reversed.data.status, 'unpaid', 'and the status followed it');

        const listed = await call(`/api/legacy-invoices/${invoice.id}/payments`);
        assert.equal(listed.data.rows.length, 1, 'the row is still there — history, not a gap');
        assert.equal(listed.data.rows[0].status, 'reversed');
        assert.equal(listed.data.rows[0].reversal_reason, 'Typed 1000 instead of 100');
        assert.equal(listed.data.rows[0].reversed_by_name, 'System Administrator');

        const again = await call(`/api/legacy-invoices/${invoice.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: 'again' },
        });
        assert.equal(again.status, 400, 'and it cannot be reversed twice');

        // The correction is a new payment for the right amount.
        const right = await pay(invoice.id, { amount: 100, method: 'cash' });
        assert.equal(right.data.paid_amount, 100);
        assert.equal(right.data.status, 'partial');
      });

      await dt.test('a record with money on it cannot be deleted, and can once the money is reversed', async () => {
        const invoice = await fileInvoice({ title: 'To be deleted', total: 300 });
        const paid = await pay(invoice.id, { amount: 300, method: 'cash', photo: photo(30 * 1024) });
        const paymentId = paid.data.payment.id;

        const refused = await call(`/api/legacy-invoices/${invoice.id}`, { method: 'DELETE' });
        assert.equal(refused.status, 400, JSON.stringify(refused.data));
        assert.match(refused.data.error.message, /reverse the payments first/i);

        await call(`/api/legacy-invoices/${invoice.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: 'Filed twice by mistake' },
        });
        const gone = await call(`/api/legacy-invoices/${invoice.id}`, { method: 'DELETE' });
        assert.equal(gone.status, 200, JSON.stringify(gone.data));

        // The photographs went with it — of the invoice AND of its payments.
        // `owner_id` has no foreign key, so nothing cascades on its own and
        // these bytes would otherwise sit in the shop's backup forever.
        const orphans = await query(`
          SELECT COUNT(*) AS n FROM attachments
          WHERE (owner_type = 'legacy_invoice' AND owner_id = ?)
             OR (owner_type = 'legacy_invoice_payment' AND owner_id = ?)
        `, invoice.id, paymentId);
        assert.equal(orphans.n, 0, 'no photograph is left pointing at a record that is gone');
        const payments = await query(
          'SELECT COUNT(*) AS n FROM legacy_invoice_payments WHERE invoice_id = ?', invoice.id,
        );
        assert.equal(payments.n, 0, 'and no payment row is left pointing at nothing');
      });

      // ------------------------------------------------------- the photographs

      await dt.test('an invoice is several photographs, and a list serves previews', async () => {
        const invoice = await fileInvoice({ title: 'Three pages', total: 4200, pages: 3 });
        assert.equal(invoice.attachments.length, 3, 'a paper invoice runs to several pages');

        const listed = await call('/api/legacy-invoices', { });
        const row = listed.data.rows.find((r) => r.id === invoice.id);
        assert.equal(row.attachments.length, 3);
        for (const attachment of row.attachments) {
          assert.equal(attachment.content_type, 'image/jpeg');
          assert.ok(attachment.thumb_byte_size > 0 && attachment.thumb_byte_size < attachment.byte_size);
          // The metadata must never carry the bytes: a list of twenty-five
          // invoices with three pages each would be seventy-five photographs
          // down the shop's connection.
          assert.equal(attachment.data, undefined);
          assert.equal(attachment.thumb, undefined);
        }

        // A fourth page, added afterwards through the generic attachment
        // endpoint — this feature wrote no route of its own for it.
        const added = await call(`/api/attachments/legacy_invoice/${invoice.id}`, {
          method: 'POST', body: photo(20 * 1024),
        });
        assert.equal(added.status, 201, JSON.stringify(added.data));
        const reread = await call(`/api/legacy-invoices/${invoice.id}`);
        assert.equal(reread.data.attachments.length, 4);
      });

      await dt.test('a record with no photograph of the invoice is refused', async () => {
        // The page IS the photographs. A name, a supplier and no picture is a
        // note, and he would find it in six months with nothing to read.
        const naked = await call('/api/legacy-invoices', {
          method: 'POST',
          body: { title: 'No picture', supplier_id: 1, total_amount: 100, photos: [] },
        });
        assert.equal(naked.status, 422, JSON.stringify(naked.data));
        assert.match(naked.data.error.message, /photograph/i);
      });

      // -------------------------------------------- finding one six months later

      await dt.test('an invoice is found again by the name, the number or the supplier', async () => {
        await fileInvoice({
          title: 'Ramadan stock', supplierId: 2, total: 7300,
          invoiceNo: 'AT-2024-119', invoiceDate: '2024-03-02', notes: 'Two boxes short',
        });

        const byName = await call('/api/legacy-invoices', {}).then(() => call('/api/legacy-invoices?search=Ramadan'));
        assert.equal(byName.data.rows.length, 1);
        assert.equal(byName.data.rows[0].invoice_no, 'AT-2024-119');

        const byNumber = await call('/api/legacy-invoices?search=AT-2024');
        assert.equal(byNumber.data.rows.length, 1, 'the number written on the paper finds it');

        // The supplier's name, typed rather than picked: he does not think of
        // those as two different acts.
        const bySupplierName = await call('/api/legacy-invoices?search=Ataba');
        assert.ok(bySupplierName.data.rows.length >= 1);
        assert.ok(bySupplierName.data.rows.every((row) => row.supplier_id === 2));

        const byArabicSupplier = await call(`/api/legacy-invoices?search=${encodeURIComponent('شنط العتبة')}`);
        assert.ok(byArabicSupplier.data.rows.length >= 1, 'and in Arabic');

        const bySupplier = await call('/api/legacy-invoices?supplierId=2');
        assert.ok(bySupplier.data.rows.every((row) => row.supplier_id === 2));

        // "What do I still owe?" — the question that brings him to the page.
        const owing = await call('/api/legacy-invoices?outstandingOnly=1');
        assert.ok(owing.data.rows.length >= 1);
        assert.ok(owing.data.rows.every((row) => ['unpaid', 'partial', 'unknown'].includes(row.status)),
          'nothing settled is in the list of what is still owed');

        const settled = await call('/api/legacy-invoices?status=paid');
        assert.ok(settled.data.rows.every((row) => row.status === 'paid'));

        const dated = await call('/api/legacy-invoices?dateFrom=2024-03-01&dateTo=2024-03-31');
        assert.ok(dated.data.rows.every((row) => row.invoice_date >= '2024-03-01' && row.invoice_date <= '2024-03-31'));
      });

      await dt.test('the header counts the archive, and says how much of it has no amount yet', async () => {
        const summary = await call('/api/legacy-invoices/summary');
        assert.equal(summary.status, 200, JSON.stringify(summary.data));
        const rows = await queryAll('SELECT total_amount, paid_amount, status FROM legacy_invoices');
        const expectedTotal = Math.round(rows.reduce((a, r) => a + (r.total_amount || 0), 0) * 100) / 100;
        const expectedPaid = Math.round(rows.reduce((a, r) => a + r.paid_amount, 0) * 100) / 100;
        assert.equal(summary.data.invoices, rows.length);
        assert.equal(summary.data.total_amount, expectedTotal);
        assert.equal(summary.data.paid_amount, expectedPaid);
        assert.equal(summary.data.without_amount, rows.filter((r) => r.total_amount === null).length);
      });

      await dt.test('every write is in the audit trail', async () => {
        const entries = await queryAll(
          "SELECT action FROM audit_logs WHERE module = 'legacy_invoices' ORDER BY id",
        );
        const actions = new Set(entries.map((row) => row.action));
        for (const action of ['CREATE', 'UPDATE', 'PAYMENT', 'REVERSE_PAYMENT', 'DELETE', 'ATTACH', 'DETACH']) {
          assert.ok(actions.has(action), `${action} is not in the audit trail`);
        }
      });

      // ═══════════════════════════════════════════════════════════════════
      //  THE FEATURE: this page is a record, not a transaction.
      // ═══════════════════════════════════════════════════════════════════

      /**
       * *"والصفحه دي كلها لكل الداتا القديمه … متدخلهاش في حسابات السيستيم"*
       *
       * A shop owner who later finds these amounts double-counted in his profit
       * has lost trust in every number on the screen. So: take a photograph of
       * every total the system publishes, file a large legacy invoice and pay
       * it in full, and take the photograph again. Not one figure may have
       * moved — not the costs, not the profit, not the stock, not the supplier's
       * own balance, not the purchasing screen, not the dashboard.
       *
       * The amounts are deliberately enormous and the supplier is deliberately
       * one the shop really trades with: if any join anywhere picked these rows
       * up, no rounding could hide 99,000.
       */
      await dt.test('a legacy invoice does not appear in the shop\'s costs, profit, stock or supplier balances', async () => {
        const snapshot = async () => {
          const [
            costs, profit, purchasesBySupplier, purchaseOrders, ledger, valuation,
            supplier, purchases, dashboard,
          ] = await Promise.all([
            call('/api/costs/summary?dateFrom=2000-01-01&dateTo=2100-01-01'),
            call('/api/reports/profit_and_costs?dateFrom=2000-01-01&dateTo=2100-01-01'),
            call('/api/reports/purchases_by_supplier?dateFrom=2000-01-01&dateTo=2100-01-01'),
            call('/api/reports/purchase_orders?dateFrom=2000-01-01&dateTo=2100-01-01'),
            call('/api/reports/costs_ledger?dateFrom=2000-01-01&dateTo=2100-01-01'),
            call('/api/reports/inventory_valuation'),
            call('/api/suppliers/1'),
            call('/api/purchases'),
            call('/api/dashboard'),
          ]);
          return {
            costs: costs.data,
            profit: profit.data.summary,
            profitRows: profit.data.rows,
            purchasesBySupplier: purchasesBySupplier.data.summary,
            purchaseOrderRows: purchaseOrders.data.rows.length,
            costRows: ledger.data.rows.length,
            costLedgerSummary: ledger.data.summary,
            stockValue: valuation.data.summary,
            supplierStatistics: supplier.data.statistics,
            purchaseCount: purchases.data.total,
            purchaseSummary: purchases.data.summary,
            dashboard: dashboard.data.kpis,
          };
        };

        // Real numbers first: a snapshot of zeros would match a snapshot of
        // zeros however badly this feature leaked.
        await buildRealHistory();
        const before = await snapshot();
        assert.ok(before.costs.total > 0, 'the shop has costs to be disturbed');
        assert.ok(before.supplierStatistics.total_purchased > 0, 'and a supplier balance');
        assert.ok(before.supplierStatistics.outstanding > 0, 'with money outstanding on it');
        assert.ok(Number(before.stockValue.value ?? before.stockValue.stock_value ?? 0) > 0
          || before.purchaseCount > 0, 'and stock that was bought and received');

        const invoice = await fileInvoice({
          title: 'The big one — before the system',
          supplierId: 1,
          total: 99000,
          invoiceDate: '2023-11-04',
          pages: 2,
        });
        const first = await pay(invoice.id, { amount: 49000, method: 'transfer', paidOn: '2023-12-01', photo: photo(30 * 1024) });
        assert.equal(first.data.status, 'partial');
        const second = await pay(invoice.id, { amount: 50000, method: 'cash', paidOn: '2024-02-01' });
        assert.equal(second.data.status, 'paid');
        assert.equal(second.data.paid_amount, 99000);

        const after = await snapshot();

        // One assertion for the whole thing, so a diff names exactly which
        // total moved rather than only the first one that did.
        assert.deepEqual(after, before,
          'a legacy invoice moved one of the shop\'s own totals — see shared/legacyInvoices.js');

        // And the tables really did receive the money, so the test above is not
        // passing because nothing happened.
        const stored = await query(
          'SELECT paid_amount, status FROM legacy_invoices WHERE id = ?', invoice.id,
        );
        assert.equal(stored.paid_amount, 99000);
        assert.equal(stored.status, 'paid');

        // Nothing leaked sideways into the tables every aggregate is built from.
        const strays = await query(`
          SELECT
            (SELECT COUNT(*) FROM costs WHERE amount = 99000 OR amount = 49000 OR amount = 50000) AS costs,
            (SELECT COUNT(*) FROM purchase_payments WHERE amount = 49000 OR amount = 50000) AS payments,
            (SELECT COUNT(*) FROM purchase_orders WHERE total_amount = 99000) AS orders,
            (SELECT COUNT(*) FROM stock_movements WHERE reference_type = 'legacy_invoice') AS movements
        `);
        assert.deepEqual(strays, { costs: 0, payments: 0, orders: 0, movements: 0 });
      });
    });
  }
});
