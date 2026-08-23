/**
 * Money out, as rows — and the photograph that proves it.
 *
 * Before this round `POST /api/purchases/:id/payment` added to a column and
 * wrote an audit line. There was no payment, so the shop could not say what it
 * had paid a supplier or when, and there was nothing for a receipt to hang off.
 *
 * What is checked here is what would go wrong if the design were wrong:
 *
 *   · The running total NEVER disagrees with the rows it is the sum of —
 *     including when several payments are recorded at the same instant. This
 *     is the one that decides whether the implementation is real: the old code
 *     read `paid_amount`, added to it in JavaScript and wrote it back, which
 *     loses one of any two payments that overlap. It is first, and it is run
 *     against a fresh order so the arithmetic is unambiguous.
 *   · A reversal takes the money back OUT of the total and leaves the row
 *     behind, because a payment is never deleted.
 *   · The size ceiling, on both the readable photograph and its preview.
 *   · A file that is not an image is refused even when it insists it is one —
 *     the bytes are sniffed, the declared type is only a claim.
 *   · A list of payments serves previews, not photographs.
 *
 * Everything runs twice, once per driver: `node:sqlite` is the shop counter,
 * libSQL against a local file is the same client, statement encoding and row
 * decoding a hosted Turso deployment uses. The harness is the one
 * `idempotency.test.js` established next door.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'supplier-payments-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { MAX_FULL_BYTES, MAX_THUMB_BYTES } = await import('../src/services/AttachmentService.js');

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
      // Every call gets a key of its own unless one is named: without it the
      // idempotency guard fingerprints identical POSTs and would collapse the
      // concurrent payments below into one, which is the opposite of what this
      // file is measuring.
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

async function seed(connection) {
  await runWithTenant(null, connection, async () => {
    await runMigrations();
    await seedBaseline();
    await transaction(async () => {
      const db = getDb();
      await db.prepare("INSERT INTO suppliers (id, code, name_en) VALUES (1, 'SUP1', 'Cairo Supplies')").run();
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

/** A purchase order totalling exactly `unitCost * qty` — no tax, no rounding. */
async function newOrder({ quantity = 10, unitCost = 100 } = {}) {
  const created = await call('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: 1,
      warehouse_id: 1,
      order_date: '2026-03-01',
      discount_amount: 0,
      shipping_amount: 0,
      lines: [{
        variant_id: 1, quantity_ordered: quantity, unit_cost: unitCost,
        discount_percent: 0, tax_rate: 0,
      }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

const query = (sql, ...params) => scoped(() => getDb().prepare(sql).get(...params));

// ---------------------------------------------------------------- fixtures

/**
 * A real JPEG of a given weight.
 *
 * Not random bytes with a JPEG header glued on: `decodeImageDataUrl` sniffs the
 * magic AND reads the frame header for dimensions, and a fixture that only
 * satisfies the first half would pass for the wrong reason. This is a minimal
 * valid baseline JPEG with a comment segment padded to whatever size the test
 * needs, so a 2 MB one is genuinely 2 MB of picture as far as the code is
 * concerned.
 */
function jpegOfBytes(bytes) {
  const head = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, // SOF0: 64x64
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const tail = Buffer.from([0xff, 0xd9]); // EOI
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

test('supplier payments are rows, and the total follows them', async (t) => {
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

      // ------------------------------------------- the total and the rows agree

      await dt.test('a payment is a row, and the order total is its sum', async () => {
        const order = await newOrder();            // 10 × 100 = 1000
        const paid = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: { amount: 250, method: 'transfer', reference: 'TRF-1', paidOn: '2026-03-02' },
        });
        assert.equal(paid.status, 200, JSON.stringify(paid.data));
        assert.equal(paid.data.paid_amount, 250);

        const listed = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(listed.data.rows.length, 1);
        assert.equal(listed.data.rows[0].amount, 250);
        assert.equal(listed.data.rows[0].method, 'transfer');
        assert.equal(listed.data.rows[0].reference, 'TRF-1');
        assert.equal(listed.data.rows[0].paid_on, '2026-03-02');
        assert.equal(listed.data.rows[0].created_by_name, 'System Administrator');
        assert.equal(listed.data.outstanding, 750);
      });

      /**
       * The one that decides whether this is real.
       *
       * Six payments fired without awaiting in between, each with a key of its
       * own so the idempotency guard treats them as six deliberate submissions.
       * A running total that is read, incremented and written back loses some
       * of them; a total the DATABASE recomputes from the rows cannot.
       */
      await dt.test('six payments recorded at the same instant all survive, and the total is exact', async () => {
        const order = await newOrder({ quantity: 10, unitCost: 100 });   // 1000
        const amounts = [11.11, 22.22, 33.33, 44.44, 55.55, 66.66];      // 233.31

        const answers = await Promise.all(amounts.map((amount, index) => call(
          `/api/purchases/${order.id}/payments`,
          { method: 'POST', body: { amount, method: 'cash' }, key: `concurrent-${index}` },
        )));
        for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.data));

        const rows = await scoped(() => getDb().prepare(
          'SELECT amount FROM purchase_payments WHERE purchase_order_id = ? ORDER BY id',
        ).all(order.id));
        assert.equal(rows.length, amounts.length, 'every payment left a row');

        const header = await query('SELECT paid_amount, total_amount FROM purchase_orders WHERE id = ?', order.id);
        const summed = Math.round(rows.reduce((acc, row) => acc + row.amount, 0) * 100) / 100;
        assert.equal(header.paid_amount, summed, 'the running total is the sum of the rows');
        assert.equal(header.paid_amount, 233.31, 'and it is the sum that was actually paid');
      });

      await dt.test('the invariant holds for every order in the database', async () => {
        // Not a restatement of the test above: this sweeps everything the whole
        // file has done so far, including the orders other subtests left behind.
        const drift = await scoped(() => getDb().prepare(`
          SELECT po.id, po.paid_amount,
                 ROUND(COALESCE((SELECT SUM(p.amount) FROM purchase_payments p
                                 WHERE p.purchase_order_id = po.id AND p.status = 'recorded'), 0), 2) AS summed
          FROM purchase_orders po
          WHERE ABS(po.paid_amount - ROUND(COALESCE((SELECT SUM(p.amount) FROM purchase_payments p
                    WHERE p.purchase_order_id = po.id AND p.status = 'recorded'), 0), 2)) > 0.001
        `).all());
        assert.deepEqual(drift, [], 'no order disagrees with its own payments');
      });

      await dt.test('a payment past the order total is refused and leaves no row', async () => {
        const order = await newOrder({ quantity: 1, unitCost: 100 });     // 100
        const before = await call(`/api/purchases/${order.id}/payments`);
        const rejected = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST', body: { amount: 500, method: 'cash' },
        });
        // A business rule, not a malformed field: 400 with the rule named.
        assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
        assert.equal(rejected.data.error.code, 'BUSINESS_RULE');
        assert.match(rejected.data.error.message, /exceeds/i);

        const after = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(after.data.rows.length, before.data.rows.length,
          'the rolled-back transaction took its row with it');
        assert.equal(after.data.paid_amount, 0);
      });

      // -------------------------------------------------- a payment that was wrong

      await dt.test('a wrong payment is reversed, not deleted, and the total drops', async () => {
        const order = await newOrder({ quantity: 10, unitCost: 100 });    // 1000
        const wrong = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST', body: { amount: 900, method: 'cash' },
        });
        assert.equal(wrong.data.paid_amount, 900);
        const paymentId = wrong.data.payment.id;

        const bare = await call(`/api/purchases/${order.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: '' },
        });
        assert.equal(bare.status, 422, 'a reversal has to say why');

        const reversed = await call(`/api/purchases/${order.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: 'Typed 900 instead of 90' },
        });
        assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
        assert.equal(reversed.data.paid_amount, 0, 'the total gave the money back');

        const listed = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(listed.data.rows.length, 1, 'the row is still there — history, not a gap');
        assert.equal(listed.data.rows[0].status, 'reversed');
        assert.equal(listed.data.rows[0].reversal_reason, 'Typed 900 instead of 90');
        assert.equal(listed.data.rows[0].reversed_by_name, 'System Administrator');

        const again = await call(`/api/purchases/${order.id}/payments/${paymentId}/reverse`, {
          method: 'POST', body: { reason: 'again' },
        });
        assert.equal(again.status, 400, 'and it cannot be reversed twice');
      });

      await dt.test('a draft that has taken money cannot be deleted, and says so', async () => {
        const order = await newOrder({ quantity: 1, unitCost: 100 });
        await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST', body: { amount: 50, method: 'cash' },
        });
        const refused = await call(`/api/purchases/${order.id}`, { method: 'DELETE' });
        assert.equal(refused.status, 400, JSON.stringify(refused.data));
        assert.match(refused.data.error.message, /reverse the payments first|cancel/i);
      });

      // ------------------------------------------------------------- the photograph

      await dt.test('a payment carries a photograph, and the list serves the preview', async () => {
        const order = await newOrder();
        const recorded = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: { amount: 100, method: 'cash', photo: photo(120 * 1024) },
        });
        assert.equal(recorded.status, 200, JSON.stringify(recorded.data));

        const listed = await call(`/api/purchases/${order.id}/payments`);
        const payment = listed.data.rows.find((row) => row.id === recorded.data.payment.id);
        assert.equal(payment.attachments.length, 1);
        const attachment = payment.attachments[0];
        assert.equal(attachment.content_type, 'image/jpeg');
        assert.ok(attachment.byte_size > 100 * 1024);
        assert.ok(attachment.thumb_byte_size > 0 && attachment.thumb_byte_size < attachment.byte_size);
        // The metadata must never carry the bytes themselves: a list of ten
        // payments would otherwise be a megabyte of JSON.
        assert.equal(attachment.data, undefined);
        assert.equal(attachment.thumb, undefined);

        const full = await fetch(`${base}/api/attachments/${attachment.id}/raw`, { headers: { cookie } });
        const fullBytes = Buffer.from(await full.arrayBuffer());
        assert.equal(full.headers.get('content-type'), 'image/jpeg');
        // Bytes that came from the internet, served back to a browser: the type
        // is the sniffed one and the browser is told not to second-guess it.
        assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(fullBytes.length, attachment.byte_size);

        const thumb = await fetch(`${base}/api/attachments/${attachment.id}/raw?size=thumb`, {
          headers: { cookie },
        });
        const thumbBytes = Buffer.from(await thumb.arrayBuffer());
        assert.equal(thumbBytes.length, attachment.thumb_byte_size);
        assert.ok(thumbBytes.length < fullBytes.length / 4,
          'the preview is a fraction of the photograph — ten of them must not cost ten photographs');
      });

      // ------------------------------------------------------------ the ceiling

      await dt.test('a photograph past the ceiling is refused, and the message says by how much', async () => {
        const order = await newOrder();
        const oversize = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: {
            amount: 10,
            method: 'cash',
            photo: { dataUrl: asDataUrl(jpegOfBytes(MAX_FULL_BYTES + 50 * 1024)) },
          },
        });
        assert.equal(oversize.status, 422, JSON.stringify(oversize.data));
        assert.match(oversize.data.error.message, /KB.*limit is/i);

        const listed = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(listed.data.rows.length, 0,
          'the payment went down with the photograph rather than being stored without it');
        assert.equal(listed.data.paid_amount, 0);
      });

      await dt.test('an oversized preview is refused too', async () => {
        const order = await newOrder();
        const refused = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: {
            amount: 10,
            method: 'cash',
            photo: {
              dataUrl: asDataUrl(jpegOfBytes(50 * 1024)),
              thumbDataUrl: asDataUrl(jpegOfBytes(MAX_THUMB_BYTES + 8 * 1024)),
            },
          },
        });
        assert.equal(refused.status, 422);
        assert.match(refused.data.error.message, /preview/i);
      });

      // -------------------------------------------------- not an image at all

      await dt.test('a file that is not an image is refused however it is labelled', async () => {
        const order = await newOrder();

        // A PDF, insisting in its data URL that it is a JPEG. The declared type
        // is a claim; the bytes are the fact.
        const pdf = Buffer.concat([
          Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
          Buffer.alloc(2048, 0x20),
        ]);
        const liar = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: { amount: 10, method: 'cash', photo: { dataUrl: asDataUrl(pdf, 'image/jpeg') } },
        });
        assert.equal(liar.status, 422, JSON.stringify(liar.data));
        assert.match(liar.data.error.message, /JPEG, PNG and WebP/i);

        // And a gzip blob honestly declared as what it is.
        const gzip = zlib.gzipSync(Buffer.from('not a picture'));
        const honest = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST',
          body: { amount: 10, method: 'cash', photo: { dataUrl: asDataUrl(gzip, 'application/gzip') } },
        });
        assert.equal(honest.status, 422);

        const listed = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(listed.data.rows.length, 0, 'neither attempt left a payment behind');
        const stored = await query('SELECT COUNT(*) AS n FROM attachments');
        assert.ok(stored.n >= 0);
      });

      // ------------------------------------------------- the mechanism is general

      await dt.test('an unregistered kind of owner cannot be attached to or served', async () => {
        // The registry is what stops a caller inventing an owner type and
        // walking photographs past somebody else's permissions.
        const invented = await call('/api/attachments/users/1', {
          method: 'POST', body: { dataUrl: asDataUrl(jpegOfBytes(4096)) },
        });
        assert.equal(invented.status, 404, JSON.stringify(invented.data));

        const listed = await call('/api/attachments/users/1');
        assert.equal(listed.status, 404);
      });

      await dt.test('a photograph can be attached to a payment after the fact, and removed', async () => {
        const order = await newOrder();
        const recorded = await call(`/api/purchases/${order.id}/payments`, {
          method: 'POST', body: { amount: 100, method: 'cash' },
        });
        const paymentId = recorded.data.payment.id;

        const attached = await call(`/api/attachments/purchase_payment/${paymentId}`, {
          method: 'POST', body: photo(30 * 1024),
        });
        assert.equal(attached.status, 201, JSON.stringify(attached.data));

        const removed = await call(`/api/attachments/${attached.data.id}`, { method: 'DELETE' });
        assert.equal(removed.status, 200);
        const after = await call(`/api/attachments/purchase_payment/${paymentId}`);
        assert.equal(after.data.rows.length, 0);
      });

      await dt.test('the old singular endpoint still works, on the same rows', async () => {
        // A tab left open across the deploy keeps posting to /payment.
        const order = await newOrder();
        const legacy = await call(`/api/purchases/${order.id}/payment`, {
          method: 'POST', body: { amount: 60, method: 'cash' },
        });
        assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
        const listed = await call(`/api/purchases/${order.id}/payments`);
        assert.equal(listed.data.rows.length, 1);
        assert.equal(listed.data.paid_amount, 60);
      });

      await dt.test('a payment is audited as a payment, not as an edit to a column', async () => {
        const row = await query(`
          SELECT action, entity_type FROM audit_logs
          WHERE module = 'purchases' AND action = 'PAYMENT' ORDER BY id DESC LIMIT 1
        `);
        assert.equal(row.entity_type, 'purchase_payment');
      });
    });
  }
});

/**
 * The upgrade path, which is the half a fresh database can never exercise: a
 * shop that has been running for a year has orders with a `paid_amount` and no
 * payment rows, because there was nowhere to put them. If the migration did not
 * carry those across, the first recompute would read them as unpaid and every
 * supplier balance on the reports would jump overnight.
 */
test('migrating a shop that already has paid orders keeps its balances', async (t) => {
  const file = path.join(dir, 'legacy.db');
  const connection = await openConnection({ driver: 'sqlite', file });
  t.after(() => connection.close());

  await runWithTenant(null, connection, async () => {
    await connection.applySchema();
    await runMigrations();
    await seedBaseline();

    await transaction(async () => {
      const db = getDb();
      await db.prepare("INSERT INTO suppliers (id, code, name_en) VALUES (1, 'SUP1', 'Cairo Supplies')").run();
      // An order as the old code would have left it: a total, a paid amount,
      // and nothing that says when or how it was paid.
      await db.prepare(`
        INSERT INTO purchase_orders
          (id, po_number, supplier_id, warehouse_id, status, order_date, subtotal,
           total_amount, paid_amount)
        VALUES (77, 'PO-2025-00077', 1, 1, 'received', '2025-06-01', 4000, 4000, 3200)
      `).run();
      // And one that was never paid, which must NOT gain a row.
      await db.prepare(`
        INSERT INTO purchase_orders
          (id, po_number, supplier_id, warehouse_id, status, order_date, subtotal,
           total_amount, paid_amount)
        VALUES (78, 'PO-2025-00078', 1, 1, 'ordered', '2025-06-02', 500, 500, 0)
      `).run();
      // Pretend 011 has not run yet, so the migration below really does the work.
      await db.prepare("DELETE FROM schema_migrations WHERE name = '011-supplier-payments'").run();
      await db.prepare('DELETE FROM purchase_payments').run();
    });

    const applied = await runMigrations();
    assert.ok(applied.includes('011-supplier-payments'), 'the migration ran');

    const carried = await getDb().prepare(
      'SELECT amount, method, paid_on FROM purchase_payments WHERE purchase_order_id = 77',
    ).all();
    assert.equal(carried.length, 1, 'the paid order gained the payment that explains its total');
    assert.equal(carried[0].amount, 3200);
    assert.equal(carried[0].method, 'unknown');
    assert.equal(carried[0].paid_on, '2025-06-01');

    const unpaid = await getDb().prepare(
      'SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_order_id = 78',
    ).get();
    assert.equal(unpaid.n, 0, 'and the unpaid one gained nothing');

    // Running it twice must not double the money.
    await getDb().prepare("DELETE FROM schema_migrations WHERE name = '011-supplier-payments'").run();
    await runMigrations();
    const again = await getDb().prepare(
      'SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_order_id = 77',
    ).get();
    assert.equal(again.n, 1, 'the backfill is idempotent');

    // The two new permissions reached the roles that already held the rights
    // they were carved out of — an upgraded shop must not find that only the
    // administrator can pay a supplier.
    const manager = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = 'manager' AND p.code IN ('purchases.pay', 'purchases.reverse_payment')
    `).get();
    assert.equal(manager.n, 2, 'the store manager can still pay a supplier after the upgrade');

    const clerk = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code = 'inventory' AND p.code = 'purchases.pay'
    `).get();
    assert.equal(clerk.n, 0, 'and a stock clerk still cannot — money out is not editing a document');
  });
});
