/**
 * The favourites page, and an honest best-sellers shelf.
 *
 * Favourites live in the customer's own browser as a list of product ids. That
 * is the only sensible place for them — there are no accounts on this shop —
 * but it means the list is a MEMORY, not a fact: the price it remembers may
 * have changed, the last one may have sold, and the shop may have taken the
 * product down entirely since the heart was tapped. So the page turns the ids
 * back into live cards on every visit, and this suite is about what that lookup
 * is allowed to answer:
 *
 *   - the customer's own order comes back, because it is theirs;
 *   - an unpublished product is ABSENT, not shown greyed out — the publish gate
 *     is the whole reason the lookup is not just a client-side filter;
 *   - an id that no longer resolves disappears quietly;
 *   - a list longer than the cap is cut, not refused;
 *   - junk left in localStorage by an older build is ignored, not a 400;
 *   - and an empty list means empty, never "here is the whole shop instead".
 *
 * The second half is the best-sellers shelf. It is topped up with new arrivals
 * so a quiet week does not leave a gap, which means a shop that has never sold
 * anything would get a shelf of its newest products with "الأكثر مبيعًا"
 * printed over it. `home()` has to say which it is, and it has to say `false`
 * for a void sale and for a sale older than the window — both of those are
 * "nobody bought this", and a flag that cannot tell them apart is not a flag.
 *
 * Everything runs twice, once per driver. `node:sqlite` is the shop counter and
 * libSQL is the hosted deployment; a `file:` libSQL URL is the same client and
 * the same code path a Turso URL takes, so the pair is a real comparison.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'shop-favorites-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// The process default is never read by these tests — every request runs inside
// an explicitly scoped connection — but `ensureDatabaseReady()` opens it on the
// first request regardless, so point it somewhere disposable.
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { StorefrontService } = await import('../src/services/StorefrontService.js');

/**
 * The same two drivers the product ships on. libSQL against a local file is not
 * a stand-in for Turso: it is the identical client, the identical statement
 * encoding and the identical row decoding, with a different URL scheme.
 */
const DRIVERS = [
  { name: 'sqlite', descriptor: (file) => ({ driver: 'sqlite', file }) },
  { name: 'libsql', descriptor: (file) => ({ driver: 'libsql', url: `file:${file}` }) },
];

/** How many published products the fixture holds, so the cap has something to cut. */
const CATALOGUE_SIZE = 64;
const SERVER_CAP = 60; // MAX_IDS in StorefrontService — asserted, not assumed

/**
 * One HTTP server for the whole file, pointed at whichever driver's database is
 * under test. Every request is run inside `runWithTenant(null, …)`, which is
 * how the platform scopes a request to one shop's database — with a null tenant
 * the storefront behaves exactly as the single-shop build does, so this
 * exercises the real router rather than a copy of it.
 */
let active = null;
let base = '';
let server = null;
const app = createApp();

const storefront = new StorefrontService();

/** Run anything against the driver currently under test. */
const scoped = (fn) => runWithTenant(null, active, fn);

async function api(pathname) {
  const res = await fetch(`${base}${pathname}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const error = new Error(data?.error?.message || `HTTP ${res.status} on ${pathname}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// ----------------------------------------------------------------- the shop

/**
 * A catalogue built to be awkward in exactly the ways the lookup has to survive:
 * a published product whose BRAND is unpublished (the gate a naive
 * `WHERE is_published = 1` misses), an unpublished product, and enough ordinary
 * products that the cap has more to cut than it keeps.
 */
async function seed(connection) {
  return runWithTenant(null, connection, () => transaction(async () => {
    const db = getDb();
    const run = (sql, ...params) => db.prepare(sql).run(...params);

    await run(`INSERT INTO warehouses (id, code, name_en, is_default)
               VALUES (1, 'MAIN', 'Main', 1)`);
    await run(`INSERT INTO brands (id, code, name_en, name_ar, is_published)
               VALUES (1, 'SHOWN', 'Shown brand', 'ماركة ظاهرة', 1)`);
    await run(`INSERT INTO brands (id, code, name_en, name_ar, is_published)
               VALUES (2, 'HIDDEN', 'Hidden brand', 'ماركة مخفية', 0)`);
    await run(`INSERT INTO categories (id, code, name_en, name_ar, is_published)
               VALUES (1, 'CAT', 'Everything', 'كل حاجة', 1)`);

    /** A product plus its single active variant plus, optionally, some stock. */
    let nextId = 1;
    const product = async ({
      name, published = 1, brandId = 1, stock = 5,
    }) => {
      const id = nextId;
      nextId += 1;
      await run(`INSERT INTO products
                   (id, sku_prefix, name_en, name_ar, brand_id, category_id,
                    base_price, is_active, is_published, published_at, created_at)
                 VALUES (?, ?, ?, ?, ?, 1, 100, 1, ?, ?, ?)`,
      id, name, name, name, brandId, published,
      `2025-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      `2025-01-${String((id % 28) + 1).padStart(2, '0')}T00:00:00.000Z`);
      await run(`INSERT INTO product_variants
                   (id, product_id, sku, variant_label, selling_price, is_active)
                 VALUES (?, ?, ?, '', 100, 1)`, id, id, `${name}-V`);
      if (stock > 0) {
        await run(`INSERT INTO stock_levels (variant_id, warehouse_id, quantity)
                   VALUES (?, 1, ?)`, id, stock);
      }
      return id;
    };

    const ids = {};
    ids.alpha = await product({ name: 'ALPHA' });
    ids.beta = await product({ name: 'BETA' });
    ids.gamma = await product({ name: 'GAMMA' });
    ids.unpublished = await product({ name: 'UNPUBLISHED', published: 0 });
    ids.hiddenBrand = await product({ name: 'HIDDENBRAND', brandId: 2 });

    ids.filler = [];
    for (let n = 0; n < CATALOGUE_SIZE; n += 1) {
      ids.filler.push(await product({ name: `FILL${n}` }));
    }
    return ids;
  }));
}

/** A sale, written straight in. `status` is what the featured query filters on. */
async function sell(variantId, { status = 'completed', daysAgo = 1, invoice }) {
  return scoped(() => transaction(async () => {
    const db = getDb();
    const sale = await db.prepare(`
      INSERT INTO sales (invoice_no, warehouse_id, status, sale_date, total_amount)
      VALUES (?, 1, ?, date('now', ?), 100)
    `).run(invoice, status, `-${daysAgo} days`);
    await db.prepare(`
      INSERT INTO sale_lines (sale_id, variant_id, sku, description, quantity, unit_price)
      VALUES (?, ?, 'X', 'X', 3, 100)
    `).run(sale.lastInsertRowid, variantId);
  }));
}

const idsOf = (rows) => rows.map((row) => row.id);

test('storefront favourites and the best-sellers flag', async (t) => {
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
      const file = path.join(dir, `${driver.name}.db`);
      const connection = await openConnection(driver.descriptor(file));
      await connection.applySchema();
      active = connection;
      const shop = await seed(connection);
      dt.after(() => connection.close());

      // --------------------------------------------------------------- order

      await dt.test('returns the caller\'s ids in the caller\'s own order', async () => {
        const wanted = [shop.gamma, shop.alpha, shop.beta];
        const listed = await scoped(() => storefront.products({ ids: wanted.join(',') }));
        assert.deepEqual(idsOf(listed.rows), wanted);

        // The reverse of the same list, to prove the order is the caller's and
        // not an id sort, a newest sort, or whatever the database felt like.
        const reversed = [...wanted].reverse();
        const back = await scoped(() => storefront.products({ ids: reversed.join(',') }));
        assert.deepEqual(idsOf(back.rows), reversed);
      });

      await dt.test('hands back the same card shape the grid already renders', async () => {
        const { rows } = await scoped(() => storefront.products({ ids: String(shop.alpha) }));
        const card = rows[0];
        assert.deepEqual(Object.keys(card).sort(), [
          'availability', 'brand_id', 'brand_name_ar', 'brand_name_en', 'category_id',
          'id', 'image_id', 'name_ar', 'name_en', 'price_from', 'price_to',
        ]);
        assert.equal(card.availability, 'in_stock');
        // The security rule this whole service exists for: no stock number, and
        // nothing about what the shop paid, on a listing.
        for (const leak of ['available', 'quantity', 'base_cost', 'cost_price', 'wholesale_price']) {
          assert.ok(!(leak in card), `${leak} must not reach a card`);
        }
      });

      // -------------------------------------------------------- the gate

      await dt.test('an unpublished product is absent, not hidden client-side', async () => {
        const { rows } = await scoped(() => storefront.products({
          ids: [shop.alpha, shop.unpublished, shop.beta].join(','),
        }));
        assert.deepEqual(idsOf(rows), [shop.alpha, shop.beta]);
      });

      await dt.test('a published product on an unpublished brand is absent too', async () => {
        const { rows } = await scoped(() => storefront.products({
          ids: [shop.hiddenBrand, shop.alpha].join(','),
        }));
        assert.deepEqual(idsOf(rows), [shop.alpha]);
      });

      await dt.test('ids that no longer resolve are dropped silently', async () => {
        const { rows, total } = await scoped(() => storefront.products({
          ids: [999001, shop.beta, 999002].join(','),
        }));
        assert.deepEqual(idsOf(rows), [shop.beta]);
        assert.equal(total, 1);
      });

      // ------------------------------------------------------------- the cap

      await dt.test('a list longer than the cap is cut, not refused', async () => {
        const wanted = shop.filler.slice(0, CATALOGUE_SIZE);
        assert.ok(wanted.length > SERVER_CAP, 'the fixture must out-run the cap');

        const { rows } = await scoped(() => storefront.products({ ids: wanted.join(',') }));
        assert.equal(rows.length, SERVER_CAP);
        // The kept ones are the FIRST in the list — most recently favourited,
        // the ones the customer was just looking at.
        assert.deepEqual(idsOf(rows), wanted.slice(0, SERVER_CAP));
      });

      await dt.test('duplicates do not spend the cap or come back twice', async () => {
        const wanted = [shop.alpha, shop.alpha, shop.beta, shop.alpha];
        const { rows } = await scoped(() => storefront.products({ ids: wanted.join(',') }));
        assert.deepEqual(idsOf(rows), [shop.alpha, shop.beta]);
      });

      // ------------------------------------------------------------- junk

      await dt.test('junk from an old localStorage is ignored, not an error', async () => {
        const { rows } = await scoped(() => storefront.products({
          ids: `abc, ,12x,-3,0,1e2,null,undefined,${shop.gamma}, ${shop.alpha} `,
        }));
        assert.deepEqual(idsOf(rows), [shop.gamma, shop.alpha]);
      });

      await dt.test('an all-junk list is empty, never the whole shop', async () => {
        const { rows, total } = await scoped(() => storefront.products({ ids: 'nonsense' }));
        assert.deepEqual(rows, []);
        assert.equal(total, 0);
      });

      // ------------------------------------------------------------ empty

      await dt.test('an empty ids list means empty', async () => {
        for (const empty of ['', [], ',,,', ' ']) {
          const { rows, total, pages } = await scoped(() => storefront.products({ ids: empty }));
          assert.deepEqual(rows, [], `ids=${JSON.stringify(empty)} must answer empty`);
          assert.equal(total, 0);
          assert.equal(pages, 1);
        }
      });

      await dt.test('no ids at all is still the ordinary catalogue listing', async () => {
        const listed = await scoped(() => storefront.products({ pageSize: 5 }));
        assert.equal(listed.rows.length, 5);
        assert.equal(listed.total, CATALOGUE_SIZE + 3); // the three named ones
      });

      // -------------------------------------------------------- precedence

      await dt.test('ids outrank every other filter, sort and page', async () => {
        const wanted = [shop.beta, shop.gamma, shop.alpha];
        const { rows, page, pages } = await scoped(() => storefront.products({
          ids: wanted.join(','),
          category: 999,        // a category none of them is in
          brand: 999,           // a brand none of them is on
          q: 'nothing matches this',
          sort: 'price_asc',
          page: 7,
          pageSize: 1,
        }));
        assert.deepEqual(idsOf(rows), wanted);
        assert.equal(page, 1);
        assert.equal(pages, 1);
      });

      // ------------------------------------------------------------- HTTP

      await dt.test('GET /api/shop/products?ids= is the same contract over the wire', async () => {
        const wanted = [shop.gamma, shop.alpha, shop.beta];
        const listed = await api(`/api/shop/products?ids=${wanted.join(',')}`);
        assert.deepEqual(idsOf(listed.rows), wanted);

        const filtered = await api(`/api/shop/products?ids=${shop.beta},${shop.alpha}&category=999&sort=name&page=4`);
        assert.deepEqual(idsOf(filtered.rows), [shop.beta, shop.alpha]);

        const withHidden = await api(`/api/shop/products?ids=${shop.unpublished},${shop.alpha}`);
        assert.deepEqual(idsOf(withHidden.rows), [shop.alpha]);

        const blank = await api('/api/shop/products?ids=');
        assert.deepEqual(blank.rows, []);

        const junk = await api('/api/shop/products?ids=abc,12x,-4');
        assert.deepEqual(junk.rows, []);

        // Repeated parameters arrive as an array from Express; same meaning.
        const repeated = await api(`/api/shop/products?ids=${shop.beta}&ids=${shop.gamma}`);
        assert.deepEqual(idsOf(repeated.rows), [shop.beta, shop.gamma]);
      });

      // --------------------------------------------- the best-sellers flag

      await dt.test('a shop with no sales says its featured shelf is not from sales', async () => {
        const home = await scoped(() => storefront.home());
        assert.equal(home.featuredFromSales, false);
        // The shelf itself is still full — the flag is about honesty, not about
        // taking the owner's section away.
        assert.ok(home.featured.length > 0);
        assert.deepEqual(idsOf(home.featured), idsOf(home.newest));
      });

      await dt.test('a void sale is not a sale', async () => {
        await sell(shop.alpha, { status: 'void', invoice: 'VOID-1' });
        const home = await scoped(() => storefront.home());
        assert.equal(home.featuredFromSales, false);
      });

      await dt.test('a sale older than the window is not a sale either', async () => {
        await sell(shop.beta, { daysAgo: 200, invoice: 'OLD-1' });
        const home = await scoped(() => storefront.home());
        assert.equal(home.featuredFromSales, false);
      });

      await dt.test('one completed sale in the window makes the shelf real', async () => {
        await sell(shop.alpha, { invoice: 'SOLD-1' });
        const home = await scoped(() => storefront.home());
        assert.equal(home.featuredFromSales, true);
        // And the thing that sold leads the shelf.
        assert.equal(home.featured[0].id, shop.alpha);
        assert.notDeepEqual(idsOf(home.featured), idsOf(home.newest));
      });

      await dt.test('the flag survives the round trip to the browser', async () => {
        const home = await api('/api/shop/home');
        assert.equal(home.featuredFromSales, true);
        assert.ok(Array.isArray(home.featured));
        assert.ok(Array.isArray(home.newest));
      });

      await dt.test('a best seller the shop has since unpublished cannot vouch for the shelf', async () => {
        // ALPHA is the only thing that has sold inside the window. Take it
        // down and the shelf is once again nothing but new arrivals wearing a
        // best-seller label — the flag has to notice, which it only does
        // because it is measured against the cards that came back rather than
        // against the sales query that fed them.
        await scoped(() => getDb()
          .prepare('UPDATE products SET is_published = 0 WHERE id = ?')
          .run(shop.alpha));
        const home = await scoped(() => storefront.home());
        assert.equal(home.featuredFromSales, false);
        assert.ok(!idsOf(home.featured).includes(shop.alpha));

        await scoped(() => getDb()
          .prepare('UPDATE products SET is_published = 1 WHERE id = ?')
          .run(shop.alpha));
      });
    });
  }
});
