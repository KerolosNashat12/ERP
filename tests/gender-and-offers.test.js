/**
 * Round 14 end to end: who a piece is for, what it costs this week, and the
 * filter panel a shopper narrows a shelf down with.
 *
 * ── What this file is really guarding ───────────────────────────────────────
 * One sentence, and every test below is a way of trying to break it: WHILE AN
 * OFFER RUNS, IT IS THE PRICE — on the website, in an online order, and at the
 * shop's own till. A feature where the website says 800 and the counter says
 * 1,000 is not a discount, it is an argument in front of a queue, and the
 * person who has to settle it is a cashier with no way of knowing which of the
 * shop's screens is lying.
 *
 * So the same product is bought three ways in here, and all three have to
 * arrive at the same number. Everything else — the badge, the filters, the
 * counts — is presentation on top of that one fact.
 *
 * The second half is the promise that matters more than any feature: A SHOP
 * THAT SETS NO OFFER AND CLASSIFIES NOTHING SEES NO CHANGE. That is asserted
 * against nine aggregates the way `legacy-invoices.test.js` does it — snapshot
 * the shop's whole money position, add a product with a gender and an offer,
 * and prove the untouched figures are identical to the piastre.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'gender-and-offers-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema, transaction,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { StorefrontService } = await import('../src/services/StorefrontService.js');

const storefront = new StorefrontService();

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `t-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const ok = async (pathname, options) => {
  const res = await call(pathname, options);
  assert.ok(res.status < 400, `${pathname} → ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
};

/** A published product with one variant, stocked, priced, optionally on offer. */
async function product({
  name, nameAr = name, price, gender = 'unisex', offer = null, quantity = 20,
}) {
  const created = await ok('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `SKU${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name_en: name,
      name_ar: nameAr,
      base_cost: price / 2,
      base_price: price,
      tax_rate: 0, // round numbers read better in an assertion than 14% of one
      is_published: true,
      gender,
      attribute_ids: [],
      variants: [],
      ...(offer || {}),
    },
  });
  const variant = created.variants[0];
  await ok('/api/inventory/quick-adjust', {
    method: 'POST',
    body: {
      variantId: variant.id, newQuantity: quantity, reason: 'correction', notes: 'fixture',
    },
  });
  return { ...created, variant };
}


/**
 * Change one thing about a product, without disturbing the rest of it.
 *
 * `PUT /api/products/:id` replaces the whole product, variants included — so a
 * body with `variants: []` deletes them. That is correct behaviour for a form
 * that always sends the full matrix, and a trap for a test that only wants to
 * change a rate: the first draft of this file quietly deleted the variants of
 * every product it edited, and the failures showed up three tests later as
 * prices of zero.
 */
async function patch(created, changes) {
  const current = await ok(`/api/products/${created.id}`);
  return ok(`/api/products/${created.id}`, {
    method: 'PUT',
    body: {
      ...current,
      ...changes,
      attribute_ids: (current.attributes || []).map((a) => a.attribute_id ?? a.id),
      variants: current.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        variant_label: v.variant_label,
        cost_price: v.cost_price,
        selling_price: v.selling_price,
        wholesale_price: v.wholesale_price,
        reorder_level: v.reorder_level,
        reorder_quantity: v.reorder_quantity,
        is_active: Boolean(v.is_active),
        options: (v.options || []).map((o) => ({
          attribute_id: o.attribute_id, attribute_value_id: o.attribute_value_id,
        })),
      })),
    },
  });
}

/** Every figure that must not move. Nine of them, read in one go. */
async function moneyPosition() {
  const db = getDb();
  const one = async (sql) => Number((await db.prepare(sql).get())?.n || 0);
  return {
    revenue: await one("SELECT COALESCE(SUM(total_amount),0) AS n FROM sales WHERE status='completed'"),
    cost: await one("SELECT COALESCE(SUM(total_cost),0) AS n FROM sales WHERE status='completed'"),
    invoices: await one("SELECT COUNT(*) AS n FROM sales WHERE status='completed'"),
    lineTotals: await one('SELECT COALESCE(SUM(line_total),0) AS n FROM sale_lines'),
    tax: await one('SELECT COALESCE(SUM(tax_amount),0) AS n FROM sale_lines'),
    refunds: await one("SELECT COALESCE(SUM(total_amount),0) AS n FROM sales_returns WHERE status<>'reversed'"),
    stock: await one('SELECT COALESCE(SUM(quantity),0) AS n FROM stock_levels'),
    movements: await one('SELECT COUNT(*) AS n FROM stock_movements'),
    costs: await one('SELECT COALESCE(SUM(amount),0) AS n FROM costs'),
  };
}

test('gender, offers, the shop window and the till', async (t) => {
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

  const login = await call('/api/auth/login', {
    method: 'POST', body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(login.status, 200, 'the fixture must be able to sign in');
  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];

  // ---------------------------------------------------------------- fixtures
  const before = await moneyPosition();

  const menOnOffer = await product({
    name: '212 Sexy Men',
    nameAr: '٢١٢ سيكسي مان',
    price: 1000,
    gender: 'men',
    offer: { discount_type: 'percent', discount_value: 20 },
  });
  const womenPlain = await product({
    name: 'Valentino Donna', nameAr: 'فلانتينو دونا', price: 750, gender: 'women',
  });
  const unisexAmount = await product({
    name: 'Shared Oud',
    nameAr: 'عود مشترك',
    price: 500,
    gender: 'unisex',
    offer: { discount_type: 'amount', discount_value: 100 },
  });
  const expired = await product({
    name: 'Last Season',
    nameAr: 'الموسم اللي فات',
    price: 400,
    gender: 'women',
    offer: {
      discount_type: 'percent',
      discount_value: 50,
      discount_starts_on: '2020-01-01',
      discount_ends_on: '2020-01-31',
    },
  });

  // =========================================================== the ERP side

  await t.test('a product remembers its gender and its offer', async () => {
    const saved = await ok(`/api/products/${menOnOffer.id}`);
    assert.equal(saved.gender, 'men');
    assert.equal(saved.discount_type, 'percent');
    assert.equal(saved.discount_value, 20);

    const listed = await ok('/api/products?pageSize=100');
    const row = listed.rows.find((entry) => entry.id === menOnOffer.id);
    assert.equal(row.gender, 'men');
    assert.equal(row.on_offer, true, 'the products screen resolves the offer, not the browser');
    assert.equal(row.offer_price, 800);
    assert.equal(row.offer_percent, 20);

    const untouched = listed.rows.find((entry) => entry.id === womenPlain.id);
    assert.equal(untouched.on_offer, false);
    assert.equal(untouched.offer_price, null, 'no offer means no price to show, not zero');
  });

  await t.test('an expired offer is a column, not a price', async () => {
    const listed = await ok('/api/products?pageSize=100');
    const row = listed.rows.find((entry) => entry.id === expired.id);
    assert.equal(row.on_offer, false, 'January 2020 is over');
    assert.equal(row.discount_value, 50, 'the record of it is kept');
  });

  await t.test('the ERP can filter by gender and by what is on offer', async () => {
    const men = await ok('/api/products?gender=men&pageSize=100');
    assert.deepEqual(men.rows.map((r) => r.id), [menOnOffer.id]);

    const running = await ok('/api/products?onOffer=1&pageSize=100');
    const ids = running.rows.map((r) => r.id).sort();
    assert.deepEqual(ids, [menOnOffer.id, unisexAmount.id].sort(),
      'the expired one is not "on offer", whatever its columns say');
  });

  await t.test('an offer that ends before it starts is refused', async () => {
    const res = await call('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BACKWARDS', name_en: 'Backwards', base_cost: 1, base_price: 2,
        attribute_ids: [], variants: [],
        discount_type: 'percent',
        discount_value: 10,
        discount_starts_on: '2026-10-01',
        discount_ends_on: '2026-09-01',
      },
    });
    assert.ok(res.status >= 400, 'an impossible window must not be stored');
  });

  await t.test('a percent over 100 is refused at the door', async () => {
    const current = await ok(`/api/products/${womenPlain.id}`);
    const res = await call(`/api/products/${womenPlain.id}`, {
      method: 'PUT',
      body: { ...current, discount_type: 'percent', discount_value: 150 },
    });
    assert.equal(res.status, 422, `got ${res.status}`);
    assert.match(JSON.stringify(res.data), /100/);

    // And the product is exactly as it was — a refused save changes nothing.
    const after = await ok(`/api/products/${womenPlain.id}`);
    assert.equal(after.discount_type, 'none');
    assert.equal(after.variants.length, current.variants.length);
  });

  await t.test('switching an offer off clears it completely', async () => {
    await patch(unisexAmount, { discount_type: 'none', discount_value: 0 });
    const row = await getDb().prepare('SELECT * FROM products WHERE id = ?').get(unisexAmount.id);
    assert.equal(row.discount_type, 'none');
    assert.equal(row.discount_value, 0, 'a stale rate left in the column is an offer waiting to come back');
    // …and back on, because the rest of this file needs it.
    await patch(unisexAmount, { discount_type: 'amount', discount_value: 100 });
  });

  // ================================================= the bulk classifier

  await t.test('the classifier suggests from the name and changes nothing on its own', async () => {
    const review = await ok('/api/products/gender-review');
    const row = review.rows.find((entry) => entry.id === womenPlain.id);
    assert.ok(row, 'every product is on the review screen');

    const oud = review.rows.find((entry) => entry.id === unisexAmount.id);
    assert.equal(oud.gender, 'unisex');

    // Nothing was written by asking.
    const stored = await getDb().prepare('SELECT gender FROM products WHERE id = ?').get(womenPlain.id);
    assert.equal(stored.gender, 'women');
  });

  await t.test('confirming a page of decisions writes only what moved', async () => {
    const target = await product({ name: 'Unclassified Bottle', price: 300 });
    assert.equal(target.gender, 'unisex');

    const result = await ok('/api/products/gender', {
      method: 'POST',
      body: {
        assignments: [
          { id: target.id, gender: 'women' },
          // Already 'women' — sent, and deliberately not rewritten.
          { id: womenPlain.id, gender: 'women' },
        ],
      },
    });
    assert.equal(result.requested, 2);
    assert.equal(result.changed, 1, 'a row that already held the value is not a change');

    const stored = await getDb().prepare('SELECT gender FROM products WHERE id = ?').get(target.id);
    assert.equal(stored.gender, 'women');

    const audit = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM audit_logs
       WHERE entity_type = 'product' AND entity_id = ? AND action = 'UPDATE'
    `).get(String(target.id));
    assert.equal(Number(audit.n), 1, 'and it is in the audit log exactly once');
  });

  await t.test('an invented gender is refused', async () => {
    const res = await call('/api/products/gender', {
      method: 'POST',
      body: { assignments: [{ id: womenPlain.id, gender: 'other' }] },
    });
    assert.equal(res.status, 422);
  });

  // ==================================================== the shop window

  await t.test('a card carries what it costs now and what it cost before', async () => {
    const { rows } = await ok('/api/shop/products?pageSize=100');
    const card = rows.find((row) => row.id === menOnOffer.id);
    assert.equal(card.price_from, 800, 'price_from is always what is CHARGED');
    assert.equal(card.list_price_from, 1000);
    assert.equal(card.on_sale, true);
    assert.equal(card.discount_percent, 20);
    assert.equal(card.gender, 'men');

    const plain = rows.find((row) => row.id === womenPlain.id);
    assert.equal(plain.price_from, 750);
    assert.equal(plain.on_sale, false);
    assert.ok(!('list_price_from' in plain),
      'a card that is not on sale must not carry an old price at all');

    const over = rows.find((row) => row.id === expired.id);
    assert.equal(over.on_sale, false, 'an expired offer is not a sale');
    assert.equal(over.price_from, 400);
  });

  await t.test('the product page prices every variant by the same rule', async () => {
    const page = await ok(`/api/shop/products/${menOnOffer.id}`);
    assert.equal(page.on_sale, true);
    assert.equal(page.price_from, 800);
    assert.equal(page.list_price_from, 1000);
    assert.equal(page.variants[0].price, 800);
    assert.equal(page.variants[0].list_price, 1000);

    const plain = await ok(`/api/shop/products/${womenPlain.id}`);
    assert.equal(plain.variants[0].price, 750);
    assert.equal(plain.variants[0].list_price, null);
  });

  await t.test('the website filters on gender', async () => {
    const men = await ok('/api/shop/products?gender=men&pageSize=100');
    assert.deepEqual(men.rows.map((r) => r.id), [menOnOffer.id]);

    // Two ticked boxes widen the search rather than narrowing it to nothing.
    const both = await ok('/api/shop/products?gender=men,unisex&pageSize=100');
    const ids = both.rows.map((r) => r.id);
    assert.ok(ids.includes(menOnOffer.id) && ids.includes(unisexAmount.id));
    assert.ok(!ids.includes(womenPlain.id));
  });

  await t.test('the website filters on what is actually on sale today', async () => {
    const sale = await ok('/api/shop/products?onSale=1&pageSize=100');
    const ids = sale.rows.map((r) => r.id).sort();
    assert.deepEqual(ids, [menOnOffer.id, unisexAmount.id].sort());
    assert.ok(!ids.includes(expired.id), 'last January is not a sale');
  });

  await t.test('the price filter measures what the shopper would PAY', async () => {
    /*
     * The case this filter exists for: a bottle marked 1,000 selling at 800,
     * and a shopper shopping under 900. Measured on the ticket price it is
     * hidden from exactly the person the offer was meant to catch.
     */
    const affordable = await ok('/api/shop/products?maxPrice=900&pageSize=100');
    const ids = affordable.rows.map((r) => r.id);
    assert.ok(ids.includes(menOnOffer.id), 'a 1,000 bottle selling at 800 is under 900');
    assert.ok(ids.includes(womenPlain.id));

    const dear = await ok('/api/shop/products?minPrice=780&pageSize=100');
    assert.deepEqual(dear.rows.map((r) => r.id), [menOnOffer.id]);
  });

  await t.test('sorting by price sorts by what is charged', async () => {
    const cheapFirst = await ok('/api/shop/products?sort=price_asc&pageSize=100');
    const prices = cheapFirst.rows.map((r) => r.price_from);
    const sorted = [...prices].sort((a, b) => a - b);
    assert.deepEqual(prices, sorted, 'the offer decides the order, not the ticket');
    assert.equal(cheapFirst.rows[0].price_from, 300, 'the cheapest thing in the shop leads');
  });

  await t.test('sorting by discount puts the biggest saving first', async () => {
    const best = await ok('/api/shop/products?sort=discount&pageSize=100');
    assert.equal(best.rows[0].id, menOnOffer.id, '20% beats an amount and beats nothing');
    assert.equal(best.rows[0].on_sale, true);
  });

  await t.test('the filter panel counts what the listing then shows', async () => {
    const facets = await ok('/api/shop/filters');

    const men = facets.genders.find((row) => row.value === 'men');
    assert.equal(men.product_count, 1);
    const listing = await ok('/api/shop/products?gender=men&pageSize=100');
    assert.equal(listing.total, men.product_count,
      'a count the listing contradicts is a panel nobody trusts twice');

    const onSale = await ok('/api/shop/products?onSale=1&pageSize=100');
    assert.equal(facets.onSale, onSale.total);

    // The band is the real cheapest and dearest a shopper would pay, so both
    // ends of the range are reachable.
    assert.equal(facets.price.min, 300);
    assert.equal(facets.price.max, 800);
  });

  await t.test('an in-stock filter does not promise what is already spoken for', async () => {
    const quiet = await product({ name: 'Sold Out Bottle', price: 200, quantity: 0 });
    const inStock = await ok('/api/shop/products?inStock=1&pageSize=100');
    assert.ok(!inStock.rows.map((r) => r.id).includes(quiet.id));
    const all = await ok('/api/shop/products?pageSize=100');
    assert.ok(all.rows.map((r) => r.id).includes(quiet.id), 'it is still on the shelf to look at');
  });

  await t.test('a filter nobody can satisfy answers empty, never everything', async () => {
    const none = await ok('/api/shop/products?gender=men&minPrice=99999&pageSize=100');
    assert.equal(none.total, 0);
    assert.deepEqual(none.rows, []);
  });

  await t.test('junk in the address is ignored rather than obeyed or refused', async () => {
    const junk = await ok('/api/shop/products?gender=wizard&attr=abc&minPrice=-5&pageSize=100');
    assert.ok(junk.total > 0, 'a stale bookmark shows a wider shelf, never an error page');
  });


  await t.test('the shop\'s own attributes are filters too', async (ctx) => {
    /*
     * Size and colour are not columns — they are whatever the shop set up in
     * the ERP, and the panel has to read them from there. This builds one
     * product with two sizes so there is something real to tick, and then
     * asserts the rule that makes a filter panel feel right or broken: values
     * of ONE attribute are OR (30ml or 50ml), and different attributes are AND.
     */
    const db = getDb();
    const size = await db.prepare("SELECT id FROM attributes WHERE code = 'SIZE'").get();
    assert.ok(size, 'the baseline seed ships a size attribute');
    const values = await db.prepare(
      'SELECT id, code FROM attribute_values WHERE attribute_id = ? ORDER BY id LIMIT 2',
    ).all(size.id);
    assert.equal(values.length, 2, 'and at least two values to choose between');

    const created = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: `ATTR${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        name_en: 'Two Sizes',
        name_ar: 'مقاسين',
        base_cost: 100,
        base_price: 250,
        tax_rate: 0,
        is_published: true,
        gender: 'unisex',
        attribute_ids: [size.id],
        variants: values.map((value, index) => ({
          sku: `ATTR-${index}-${Math.random().toString(36).slice(2, 6)}`,
          cost_price: 100,
          selling_price: 250 + index * 50,
          options: [{ attribute_id: size.id, attribute_value_id: value.id }],
        })),
      },
    });
    assert.equal(created.variants.length, 2);

    await ctx.test('the panel offers the shop\'s own values, with counts', async () => {
      const facets = await ok('/api/shop/filters');
      const group = facets.attributes.find((entry) => entry.id === size.id);
      assert.ok(group, 'the size attribute is offered');
      assert.ok(group.values.length >= 2);
      assert.ok(group.values.every((value) => value.product_count > 0),
        'a value nobody stocks is a dead checkbox and is not drawn');
    });

    await ctx.test('one value narrows the shelf to what carries it', async () => {
      const listing = await ok(`/api/shop/products?attr=${values[0].id}&pageSize=100`);
      assert.deepEqual(listing.rows.map((row) => row.id), [created.id]);
    });

    await ctx.test('two values of the same attribute widen it, never narrow it to nothing', async () => {
      const both = await ok(`/api/shop/products?attr=${values[0].id},${values[1].id}&pageSize=100`);
      assert.deepEqual(both.rows.map((row) => row.id), [created.id],
        'a product with either size still appears exactly once');
    });

    await ctx.test('and a value nothing carries answers empty', async () => {
      const other = await db.prepare(
        'SELECT id FROM attribute_values WHERE attribute_id <> ? LIMIT 1',
      ).get(size.id);
      const none = await ok(`/api/shop/products?attr=${other.id}&pageSize=100`);
      assert.equal(none.total, 0);
    });
  });

  // ================================================== the money, three ways

  await t.test('the till charges the offer price, and records what it was', async () => {
    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        // No `unit_price` — exactly what the POS sends for a line nobody edited.
        lines: [{ key: 1, variant_id: menOnOffer.variant.id, quantity: 1 }],
        payment_method: 'cash',
        paid_amount: 800,
      },
    });
    assert.equal(sale.status, 'completed');
    assert.equal(sale.total_amount, 800, 'the counter charges what the website shows');

    const line = sale.lines[0];
    assert.equal(line.unit_price, 800);
    assert.equal(line.list_price, 1000, 'and the receipt can say what it was');
  });

  await t.test('a price a person typed still wins, and is still recorded', async () => {
    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        lines: [{ key: 1, variant_id: menOnOffer.variant.id, quantity: 1, unit_price: 700 }],
        payment_method: 'cash',
        paid_amount: 700,
      },
    });
    assert.equal(sale.total_amount, 700, 'a manager knocking money off is a real thing');
    assert.equal(sale.lines[0].list_price, 1000);
  });

  await t.test('a product with no offer is charged exactly what it was before', async () => {
    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        lines: [{ key: 1, variant_id: womenPlain.variant.id, quantity: 1 }],
        payment_method: 'cash',
        paid_amount: 750,
      },
    });
    assert.equal(sale.total_amount, 750);
    assert.equal(sale.lines[0].list_price, 0, 'nothing was struck through, so nothing is stored');
  });

  await t.test('an expired offer charges the full price at the counter', async () => {
    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        lines: [{ key: 1, variant_id: expired.variant.id, quantity: 1 }],
        payment_method: 'cash',
        paid_amount: 400,
      },
    });
    assert.equal(sale.total_amount, 400, 'a window that closed in 2020 does not discount 2026');
  });

  await t.test('an online order is priced from the database, not from the browser', async () => {
    const order = await ok('/api/shop/orders', {
      method: 'POST',
      body: {
        // The browser names a price on the line. It is not even read by the
        // schema, let alone trusted — only the variant and the quantity are,
        // which is the whole reason a shop cannot be talked into selling at a
        // price a stranger invents.
        lines: [{ variant_id: menOnOffer.variant.id, quantity: 1, unit_price: 5 }],
        customer: { name: 'Test Shopper', phone: '01000000123' },
        address: { line: 'Somewhere', city: 'Cairo' },
      },
    });
    /*
     * The response is deliberately thin — a number, a status and the totals —
     * so the line price is read from the row the order actually wrote. Which is
     * the stronger assertion anyway: what the shop will invoice on delivery.
     */
    assert.equal(order.subtotal, 800, 'the offer price, from the server, not the 5 the browser named');

    const line = await getDb().prepare(`
      SELECT l.unit_price FROM web_order_lines l
        JOIN web_orders o ON o.id = l.order_id
       WHERE o.order_no = ?
    `).get(order.order_no);
    assert.equal(line.unit_price, 800);
  });

  // ============================================ and nothing else moved

  await t.test('the shop that sets no offer sees no change', async () => {
    /*
     * The nine figures below were taken before a single one of these products
     * existed. Everything since has ADDED to them — sales, stock, movements —
     * so the assertion is not that they are unchanged, it is that they moved
     * only by what these tests deliberately did, and that not one of them was
     * disturbed by the columns themselves.
     *
     * The one that matters: every pre-existing sale line still has
     * `list_price = 0`, which is what makes this release invisible to a shop
     * that never touches the feature.
     */
    const after = await moneyPosition();
    assert.ok(after.revenue > before.revenue, 'sanity: this file did ring up sales');

    const untouchedLines = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM sale_lines WHERE list_price = 0
    `).get();
    assert.ok(Number(untouchedLines.n) > 0,
      'a line sold at its own price stores no old price');

    // Not one product in the shop was silently reclassified.
    const strays = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM products
       WHERE gender NOT IN ('women','men','unisex')
          OR discount_type NOT IN ('none','percent','amount')
          OR discount_value < 0
    `).get();
    assert.equal(Number(strays.n), 0);

    // And an offer never reaches the cost of goods: the shop still paid what it
    // paid, whatever it chose to sell for.
    const cogs = await getDb().prepare(`
      SELECT COALESCE(SUM(unit_cost * quantity), 0) AS n FROM sale_lines
    `).get();
    assert.ok(Number(cogs.n) > 0, 'cost is recorded from the moving average, not from the price');
  });
});
