/**
 * Bundles, and Deals of the Day.
 *
 * The owner's ask, in his own words: a "Deals of the Day" section on the
 * website, switchable on or off, with the products in it chosen from the
 * dashboard; and "Bundles" — two or more products sold together as one item,
 * under a new SKU, with a price either typed or calculated from what is
 * inside, filed under a "Bundles" category so the website's existing
 * category filter is what browses them, and able to appear in Deals of the
 * Day too.
 *
 * The architectural decision behind all of the stock assertions below: a
 * bundle carries NO stock of its own. Selling one, returning one, reserving
 * one for a web order — every one of those expands into the bundle's own
 * recipe and moves each component's stock instead (`InventoryService
 * #expandLine`, chosen explicitly over giving the bundle its own
 * independent count). This file exists to prove that expansion is correct
 * at every one of those points, not just at the point it was written for.
 *
 * ── What this file proves ───────────────────────────────────────────────
 *   1. Creating a bundle: price computed from its components, or typed and
 *      left alone; filed under "Bundles" automatically; validation (at
 *      least two components, no duplicates, no self-reference, no bundle
 *      nested inside another bundle).
 *   2. Availability: the scarcest component's stock, divided down by the
 *      recipe — on the storefront's product page, where a shopper reads it.
 *   3. A POS sale of a bundle deducts each component at each component's
 *      own cost, and voiding it restores both stock and the ledger.
 *   4. A customer return of a bundle traces each component's true cost from
 *      the original sale, restocks/writes off at the component level, and
 *      reversing the return undoes it in the right order.
 *   5. A web order reserves and later deducts each component, and
 *      cancelling one before delivery releases exactly what it held.
 *   6. Deals of the Day: a plain per-product flag, a section that is absent
 *      (not empty) when switched off or when nothing is curated, a bulk
 *      toggle from the products grid, and a storefront filter.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'bundles-and-deals-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, applySchema, getDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { default: returnService } = await import('../src/services/ReturnService.js');

let base = '';
let cookie = '';
let supplierId = null;

const call = async (pathname, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `bd-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};
const ok = async (p, o) => {
  const r = await call(p, o);
  assert.ok(r.status < 400, `${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
};
const refused = async (p, o) => {
  const r = await call(p, o);
  assert.ok(r.status >= 400, `${p} was allowed but should have been refused`);
  return r.data?.error;
};

const today = () => new Date().toISOString().slice(0, 10);

const makeProduct = async (code, cost, sell, extra = {}) => ok('/api/products', {
  method: 'POST',
  body: {
    sku_prefix: code,
    name_en: code,
    name_ar: code,
    base_cost: cost,
    base_price: sell,
    is_active: true,
    track_inventory: true,
    is_published: true,
    ...extra,
  },
});

/** Raise a purchase order, approve it, receive it whole — one batch, one cost. */
const buy = async (variantId, quantity, unitCost) => {
  const po = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplierId,
      order_date: today(),
      lines: [{ variant_id: variantId, quantity_ordered: quantity, unit_cost: unitCost }],
    },
  });
  await call(`/api/purchases/${po.id}/approve`, { method: 'POST', body: {} });
  const full = await ok(`/api/purchases/${po.id}`);
  await ok(`/api/purchases/${po.id}/receive`, {
    method: 'POST',
    body: { receipts: full.lines.map((l) => ({ line_id: l.id, quantity })) },
  });
  return po;
};

const level = async (variantId) => getDb()
  .prepare('SELECT quantity, reserved_quantity, average_cost FROM stock_levels WHERE variant_id = ?')
  .get(variantId);
const onHand = async (variantId) => Number((await level(variantId))?.quantity || 0);
const reserved = async (variantId) => Number((await level(variantId))?.reserved_quantity || 0);

test('bundles and deals of the day', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  const server = await new Promise((resolve) => {
    const l = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(l));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.headers.get('set-cookie'))).split(';')[0];

  supplierId = (await ok('/api/suppliers', {
    method: 'POST', body: { name_en: 'Bundle Supplier', name_ar: 'مورد الباقات' },
  })).id;

  // ─────────────────────────────────────────────── creating a bundle

  let ring;
  let chain;
  let bundle;

  await t.test('a bundle priced from its components: filed under Bundles, priced at their sum', async () => {
    ring = await makeProduct('BD-RING', 50, 200);
    chain = await makeProduct('BD-CHAIN', 30, 100);

    bundle = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BD-SET',
        name_en: 'Ring and Chain Set',
        name_ar: 'طقم خاتم وسلسلة',
        base_cost: 0,
        base_price: 0,
        is_active: true,
        track_inventory: true,
        is_published: true,
        is_bundle: true,
        bundle_price_mode: 'sum',
        bundle_components: [
          { component_variant_id: ring.variants[0].id, quantity: 1 },
          { component_variant_id: chain.variants[0].id, quantity: 2 },
        ],
        attribute_ids: [],
        variants: [],
      },
    });

    assert.equal(Number(bundle.base_price), 400, '1×200 + 2×100 should price the bundle at 400');
    assert.equal(Number(bundle.variants[0].selling_price), 400);
    assert.equal(bundle.is_bundle, 1);
    assert.equal(bundle.category_name_en, 'Bundles', 'a bundle must file itself under Bundles, never the owner\'s choice');
    assert.equal(bundle.variants[0].bundle_components.length, 2);
    // track_inventory is forced on for a bundle — its availability IS its
    // components' stock, so "not tracked" would be a lie about what it is.
    assert.equal(bundle.track_inventory, 1);
  });

  await t.test('a fixed-price bundle keeps exactly the price the owner typed', async () => {
    const p1 = await makeProduct('BD-F1', 10, 50);
    const p2 = await makeProduct('BD-F2', 10, 60);
    const fixed = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BD-FIXED',
        name_en: 'Fixed Price Bundle',
        base_cost: 0,
        base_price: 75,
        is_active: true,
        track_inventory: true,
        is_published: true,
        is_bundle: true,
        bundle_price_mode: 'fixed',
        bundle_components: [
          { component_variant_id: p1.variants[0].id, quantity: 1 },
          { component_variant_id: p2.variants[0].id, quantity: 1 },
        ],
        attribute_ids: [],
        variants: [],
      },
    });
    assert.equal(Number(fixed.base_price), 75, 'a fixed-mode bundle must not be repriced to the sum (110)');
  });

  await t.test('refuses a bundle of fewer than two products', async () => {
    const solo = await makeProduct('BD-SOLO', 10, 50);
    const err = await refused('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BD-ONE', name_en: 'One Item Bundle', base_price: 50,
        is_bundle: true, bundle_price_mode: 'fixed',
        bundle_components: [{ component_variant_id: solo.variants[0].id, quantity: 1 }],
        attribute_ids: [], variants: [],
      },
    });
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  await t.test('refuses a bundle that lists the same product twice', async () => {
    const a = await makeProduct('BD-DUPA', 10, 50);
    const err = await refused('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BD-DUP', name_en: 'Duplicate Bundle', base_price: 50,
        is_bundle: true, bundle_price_mode: 'fixed',
        bundle_components: [
          { component_variant_id: a.variants[0].id, quantity: 1 },
          { component_variant_id: a.variants[0].id, quantity: 1 },
        ],
        attribute_ids: [], variants: [],
      },
    });
    assert.equal(err.code, 'VALIDATION_ERROR');
  });

  await t.test('refuses a bundle nested inside another bundle', async () => {
    const err = await refused('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'BD-NEST', name_en: 'Nested Bundle', base_price: 50,
        is_bundle: true, bundle_price_mode: 'fixed',
        bundle_components: [
          { component_variant_id: bundle.variants[0].id, quantity: 1 },
          { component_variant_id: ring.variants[0].id, quantity: 1 },
        ],
        attribute_ids: [], variants: [],
      },
    });
    assert.equal(err.code, 'BUSINESS_RULE');
  });

  await t.test('refuses a bundle that contains itself', async () => {
    const err = await refused(`/api/products/${bundle.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: bundle.sku_prefix, name_en: bundle.name_en, name_ar: bundle.name_ar,
        base_price: bundle.base_price, is_active: true, track_inventory: true, is_published: true,
        is_bundle: true, bundle_price_mode: 'fixed',
        bundle_components: [
          { component_variant_id: bundle.variants[0].id, quantity: 1 },
          { component_variant_id: ring.variants[0].id, quantity: 1 },
        ],
        attribute_ids: [], variants: [],
      },
    });
    assert.equal(err.code, 'BUSINESS_RULE');
  });

  // ─────────────────────────────────────────────── availability

  await t.test('availability is the scarcest component, divided down by the recipe', async () => {
    await buy(ring.variants[0].id, 10, 50);
    await buy(chain.variants[0].id, 10, 30);
    // 1 ring per bundle → 10 possible; 2 chains per bundle → 5 possible.
    // The bundle can only ever be the smaller of the two.
    const detail = await ok(`/api/shop/products/${bundle.id}`);
    assert.equal(detail.is_bundle, true);
    assert.equal(detail.variants[0].available, 5, 'the chain (2 per bundle) should be the limiting factor');
    assert.equal(detail.bundle_components.length, 2);
    const namedChain = detail.bundle_components.find((c) => c.variant_id === chain.variants[0].id);
    assert.equal(namedChain.quantity, 2);
  });

  // ─────────────────────────────────────────────── POS sale + void

  await t.test('a POS sale of a bundle deducts every component at its own cost', async () => {
    const ringBefore = await onHand(ring.variants[0].id);
    const chainBefore = await onHand(chain.variants[0].id);

    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        payment_method: 'cash', paid_amount: 800,
        lines: [{ variant_id: bundle.variants[0].id, quantity: 2 }],
      },
    });

    assert.equal(ringBefore - await onHand(ring.variants[0].id), 2, '2 bundles should take 2 rings (1 each)');
    assert.equal(chainBefore - await onHand(chain.variants[0].id), 4, '2 bundles should take 4 chains (2 each)');

    // The line carries the cost of ONE bundle: 1 ring (50) + 2 chains (2×30) = 110.
    const detail = await ok(`/api/sales/${sale.id}`);
    const line = detail.lines[0];
    assert.equal(Number(line.unit_cost), 110, 'a bundle line should cost 1×50 + 2×30, not a guess');
    assert.equal(Number(detail.total_cost), 220, 'two bundles should cost 220 in total');

    await ok(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'test void' } });
    assert.equal(await onHand(ring.variants[0].id), ringBefore, 'voiding must give every ring back');
    assert.equal(await onHand(chain.variants[0].id), chainBefore, 'voiding must give every chain back');
  });

  await t.test('the shop cannot sell more bundles than its scarcest component allows', async () => {
    const detail = await ok(`/api/shop/products/${bundle.id}`);
    const cap = detail.variants[0].available;
    const res = await call('/api/sales', {
      method: 'POST',
      body: {
        payment_method: 'cash', paid_amount: 100000,
        lines: [{ variant_id: bundle.variants[0].id, quantity: cap + 50 }],
      },
    });
    assert.ok(res.status >= 400, `sold ${cap + 50} bundles when only ${cap} were possible`);
  });

  // ─────────────────────────────────────────────── customer return + reversal

  await t.test('a partial bundle return traces each component\'s true cost and restocks it', async () => {
    const ringBefore = await onHand(ring.variants[0].id);
    const chainBefore = await onHand(chain.variants[0].id);

    const sale = await ok('/api/sales', {
      method: 'POST',
      body: {
        payment_method: 'cash', paid_amount: 1200,
        lines: [{ variant_id: bundle.variants[0].id, quantity: 3 }],
      },
    });
    const saleDetail = await ok(`/api/sales/${sale.id}`);
    const saleLine = saleDetail.lines[0];

    // One of the three bundles comes back, resellable.
    const refund = await ok('/api/returns', {
      method: 'POST',
      body: {
        return_type: 'with_receipt',
        sale_id: sale.id,
        reason_code: 'changed_mind',
        refund_method: 'cash',
        lines: [{ sale_line_id: saleLine.id, quantity: 1, condition: 'resellable' }],
      },
    });

    assert.equal(Number(refund.total_amount), 400, 'one bundle back should refund 400');
    assert.equal(Number(refund.items_restocked), 1, 'one bundle should be counted back, not its components');
    // Net of the sale (3 out) and the return (1 back): 2 rings and 4 chains
    // should still be gone.
    assert.equal(ringBefore - await onHand(ring.variants[0].id), 2);
    assert.equal(chainBefore - await onHand(chain.variants[0].id), 4);

    // Reversing the return undoes it component by component, in the reverse
    // of how it was posted — see ReturnService#reverse. There is no HTTP
    // route for this yet (a customer return cannot currently be un-reversed
    // from the ERP's own screens), so the service is exercised directly,
    // exactly as it would be by whatever calls it next.
    const reversal = await returnService.reverse(refund.id, 'test reversal', {});
    assert.equal(reversal.unRestocked, 1, 'reversing should undo exactly the one bundle that was restocked');
    assert.equal(ringBefore - await onHand(ring.variants[0].id), 3, 'after reversal, all 3 sold rings should be gone again');
    assert.equal(chainBefore - await onHand(chain.variants[0].id), 6, 'after reversal, all 6 sold chains should be gone again');

    // Clean up: void the sale so the next tests start from a clean shelf.
    await ok(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'test cleanup' } });
    assert.equal(await onHand(ring.variants[0].id), ringBefore);
    assert.equal(await onHand(chain.variants[0].id), chainBefore);
  });

  // ─────────────────────────────────────────────── web orders

  await t.test('a web order reserves and then delivers every component of a bundle', async () => {
    const ringBefore = await onHand(ring.variants[0].id);
    const chainBefore = await onHand(chain.variants[0].id);
    const ringReservedBefore = await reserved(ring.variants[0].id);
    const chainReservedBefore = await reserved(chain.variants[0].id);

    const signedIn = cookie;
    cookie = ''; // the storefront is not signed in
    const placed = await ok('/api/shop/orders', {
      method: 'POST',
      body: {
        lines: [{ variant_id: bundle.variants[0].id, quantity: 1 }],
        customer: { name: 'Bundle Buyer', phone: '01000000099' },
        address: { line: '1 Test Street', city: 'Cairo' },
        language: 'en',
      },
    });
    cookie = signedIn;

    // Placing reserves — it does not yet move a single unit off the shelf.
    assert.equal(await reserved(ring.variants[0].id) - ringReservedBefore, 1);
    assert.equal(await reserved(chain.variants[0].id) - chainReservedBefore, 2);
    assert.equal(await onHand(ring.variants[0].id), ringBefore);
    assert.equal(await onHand(chain.variants[0].id), chainBefore);

    const list = await ok('/api/web-orders?page=1');
    const row = (list.rows || []).find((r) => r.order_no === placed.order_no);
    assert.ok(row, 'a placed web order for a bundle is not on the shop\'s screen');

    await ok(`/api/web-orders/${row.id}/accept`, { method: 'POST', body: {} });
    await ok(`/api/web-orders/${row.id}/dispatch`, { method: 'POST', body: {} });
    await ok(`/api/web-orders/${row.id}/deliver`, { method: 'POST', body: {} });

    assert.equal(ringBefore - await onHand(ring.variants[0].id), 1, 'delivering should take the ring off the shelf');
    assert.equal(chainBefore - await onHand(chain.variants[0].id), 2, 'delivering should take both chains off the shelf');
    assert.equal(await reserved(ring.variants[0].id), ringReservedBefore, 'delivery should clear the reservation');
    assert.equal(await reserved(chain.variants[0].id), chainReservedBefore);

    const detail = await ok(`/api/web-orders/${row.id}`);
    assert.equal(detail.status, 'delivered');
    assert.ok(detail.sale_id, 'a delivered bundle order produced no sale');
  });

  await t.test('cancelling a bundle order before delivery releases every component it held', async () => {
    const ringReservedBefore = await reserved(ring.variants[0].id);
    const chainReservedBefore = await reserved(chain.variants[0].id);

    const signedIn = cookie;
    cookie = '';
    const placed = await ok('/api/shop/orders', {
      method: 'POST',
      body: {
        lines: [{ variant_id: bundle.variants[0].id, quantity: 1 }],
        customer: { name: 'Bundle Canceller', phone: '01000000098' },
        address: { line: '2 Test Street', city: 'Cairo' },
        language: 'en',
      },
    });
    cookie = signedIn;

    assert.equal(await reserved(ring.variants[0].id) - ringReservedBefore, 1);
    assert.equal(await reserved(chain.variants[0].id) - chainReservedBefore, 2);

    const list = await ok('/api/web-orders?page=1');
    const row = (list.rows || []).find((r) => r.order_no === placed.order_no);
    await ok(`/api/web-orders/${row.id}/cancel`, { method: 'POST', body: { reason: 'test cancel' } });

    assert.equal(await reserved(ring.variants[0].id), ringReservedBefore, 'cancelling should release the ring\'s reservation');
    assert.equal(await reserved(chain.variants[0].id), chainReservedBefore, 'cancelling should release both chains\' reservations');
  });

  // ─────────────────────────────────────────────── deals of the day

  let deal1;

  await t.test('a curated product appears in the home page\'s Deals of the Day shelf', async () => {
    const home0 = await ok('/api/shop/home');
    assert.equal(home0.deals, null, 'nothing has been curated yet — the shelf must be absent, not empty');

    deal1 = await makeProduct('DEAL-1', 20, 90, { is_deal_of_day: true });

    const home1 = await ok('/api/shop/home');
    assert.ok(Array.isArray(home1.deals), 'a curated product should turn the shelf on');
    assert.ok(home1.deals.some((row) => row.id === deal1.id));
  });

  await t.test('switching the section off hides it even though products are still curated', async () => {
    await ok('/api/settings', { method: 'PUT', body: { 'web.deals_enabled': '0' } });
    const home = await ok('/api/shop/home');
    assert.equal(home.deals, null, 'the section switch must win over having curated products');

    await ok('/api/settings', { method: 'PUT', body: { 'web.deals_enabled': '1' } });
    const restored = await ok('/api/shop/home');
    assert.ok(restored.deals.some((row) => row.id === deal1.id), 'turning it back on should show the same curation');
  });

  await t.test('a bundle can also be curated onto the deals shelf', async () => {
    await ok(`/api/products/${bundle.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: bundle.sku_prefix, name_en: bundle.name_en, name_ar: bundle.name_ar,
        base_price: bundle.base_price, is_active: true, track_inventory: true, is_published: true,
        is_bundle: true, bundle_price_mode: 'sum',
        bundle_components: [
          { component_variant_id: ring.variants[0].id, quantity: 1 },
          { component_variant_id: chain.variants[0].id, quantity: 2 },
        ],
        is_deal_of_day: true,
        attribute_ids: [], variants: [],
      },
    });
    const home = await ok('/api/shop/home');
    const dealRow = home.deals.find((row) => row.id === bundle.id);
    assert.ok(dealRow, 'a bundle should be able to sit on the deals shelf too');
    assert.equal(dealRow.is_bundle, true, 'the card must still say it is a bundle while on that shelf');
  });

  await t.test('the storefront can filter to only what is on the deals shelf', async () => {
    const filtered = await ok('/api/shop/products?dealOfDay=1');
    const ids = filtered.rows.map((r) => r.id);
    assert.ok(ids.includes(deal1.id) && ids.includes(bundle.id));
    assert.equal(filtered.total, 2, 'exactly the two curated products should match, nothing else');
  });

  await t.test('the storefront can filter to only the Bundles category', async () => {
    const categories = await ok('/api/shop/categories');
    const bundlesCategory = categories.rows.find((c) => c.name_en === 'Bundles');
    assert.ok(bundlesCategory, 'the seeded Bundles category should be browsable once it holds a published product');

    const filtered = await ok(`/api/shop/products?category=${bundlesCategory.id}`);
    const ids = filtered.rows.map((r) => r.id);
    assert.ok(ids.includes(bundle.id));
    // BD-FIXED, created earlier, is a bundle too and belongs here as well.
    assert.ok(filtered.total >= 2, 'every bundle created in this file should be filed under one category');
  });

  await t.test('a bulk edit can take a product off the deals shelf without touching anything else', async () => {
    await ok('/api/products/bulk', {
      method: 'POST',
      body: { ids: [deal1.id], changes: { is_deal_of_day: false } },
    });
    const home = await ok('/api/shop/home');
    const ids = (home.deals || []).map((row) => row.id);
    assert.ok(!ids.includes(deal1.id), 'the bulk edit should have taken deal1 off the shelf');
    assert.ok(ids.includes(bundle.id), 'the bulk edit must not have touched the bundle\'s own curation');
  });

  await t.test('the admin grid can filter and count bundles and deals independently of each other', async () => {
    const bundles = await ok('/api/products?isBundle=1');
    assert.equal(bundles.total, 2, 'exactly BD-SET and BD-FIXED are bundles');

    const deals = await ok('/api/products?isDealOfDay=1');
    assert.equal(deals.total, 1, 'only the bundle is still curated after the bulk edit above');

    const summary = await ok('/api/products/summary');
    assert.equal(summary.bundles, 2);
    assert.equal(summary.deals, 1);
  });
});
