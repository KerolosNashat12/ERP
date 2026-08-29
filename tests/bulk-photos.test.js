/**
 * BULK PHOTOS — a folder of pictures, filed against the products in them.
 *
 * The owner has 248 products and a photo card that takes one file at a time.
 * That is why most of a catalogue stays bare: nobody visits 248 editors.
 *
 * What is fenced here is the part that can silently do the WRONG thing. An
 * upload that fails is visible — a person sees a red row. A photograph filed
 * against the wrong product is not: it appears on the shop, on a card, in a
 * WhatsApp preview, and nothing about the ERP suggests anybody should go and
 * look. So the matching rule gets the tests, and it is tested for what it
 * REFUSES as much as for what it matches.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  stemOf, codeFromFilename, codeCandidates, sequenceOf,
} from '../public/shared/photoFilename.js';

/* ══════════════════════ 1. the filename rule, on its own ══════════════════ */

test('the same product, named four different ways by four different tools', () => {
  /*
   * Not invented: this is what comes off a phone, a camera, a Windows copy and
   * a person numbering shots by hand. All four are the product `VS-1042`.
   */
  const same = ['VS-1042.jpg', 'VS-1042 (2).jpg', 'vs-1042_3.JPG', 'VS-1042-2.jpeg'];
  const codes = same.map((name) => codeFromFilename(name).toLowerCase());
  assert.deepEqual([...new Set(codes)], ['vs-1042'],
    `four names for one product produced ${new Set(codes).size} codes`);
});

test('a folder path in front of the name is not part of the code', () => {
  // A dropped directory, and `webkitRelativePath`, both look like this.
  assert.equal(codeFromFilename('photos/summer/VS-1042.jpg'), 'VS-1042');
  assert.equal(codeFromFilename('C:\\Users\\shop\\Desktop\\VS-1042.jpg'), 'VS-1042');
});

test('the order of the shots is read, because the first one is the shop front', () => {
  /*
   * The first photograph of a product becomes its main one — on the card, in
   * the basket, in the link preview. Reading these backwards would put the
   * shot of the barcode on the front of 248 cards.
   */
  assert.equal(sequenceOf('VS-1042.jpg'), 1);
  assert.equal(sequenceOf('VS-1042-2.jpg'), 2);
  assert.equal(sequenceOf('VS-1042 (3).jpg'), 3);
  assert.equal(sequenceOf('VS-1042_10.jpg'), 10);
});

test('a code that ENDS in a number is not mangled — both readings are offered', () => {
  /*
   * The ambiguity this rule cannot resolve on its own, and the reason it does
   * not try: `BAG-2.jpg` is either the product `BAG-2`, or the second
   * photograph of `BAG`. Nothing in the filename says which. So both are
   * looked up, LITERAL FIRST — a filename that is exactly a product's code is
   * not a guess, and the stripped reading is.
   */
  assert.deepEqual(codeCandidates('BAG-2.jpg'), ['BAG-2', 'BAG']);
  // And a name with nothing to strip costs the lookup nothing extra.
  assert.deepEqual(codeCandidates('BAG.jpg'), ['BAG']);
});

test('an Arabic filename survives the trip', () => {
  // Shops here name files in Arabic. A rule that stripped non-Latin characters
  // would quietly match none of them.
  assert.equal(codeFromFilename('عطر-فيرى-سكسى.jpg'), 'عطر-فيرى-سكسى');
  assert.equal(codeFromFilename('عطر-فيرى-سكسى-2.jpg'), 'عطر-فيرى-سكسى');
});

test('a name that is nothing but a duplicate marker still has something to look up', () => {
  // `(2).jpg` strips to empty. An empty code must never be looked up: it would
  // match any product whose code is somehow blank, and file a photo there.
  assert.equal(codeFromFilename('(2).jpg'), stemOf('(2).jpg'));
  assert.notEqual(codeFromFilename('(2).jpg'), '');
});

/* ═══════════════ 2. against a real catalogue, over real HTTP ══════════════ */

test('filenames are matched to products, and unknown ones stay unknown', async (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, '..', 'data', 'bulk-photos-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.MM_DB_FILE = path.join(dir, 'shop.db');

  const { createApp } = await import('../src/server.js');
  const { initDb, closeDb, applySchema } = await import('../src/infrastructure/database/connection.js');
  const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
  const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

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

  const call = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
        'Idempotency-Key': `bp-${Math.random().toString(36).slice(2)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  // A product whose code is a clean one, and one whose code ENDS IN A NUMBER —
  // the ambiguous case, present so the assertions below are not all easy.
  const made = await call('/api/products', {
    sku_prefix: 'BULK', name_en: 'Bulk One', name_ar: 'واحد',
    base_price: 100,
    variants: [{ sku: 'BULK-9', variant_label: 'nine', cost_price: 10, selling_price: 100, barcode: '6221000000015' }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const product = made.data;

  const ends = await call('/api/products', {
    sku_prefix: 'BULK-2', name_en: 'Bulk Two', name_ar: 'اتنين',
    base_price: 100,
    variants: [{ sku: 'BULK-2-A', variant_label: 'a', cost_price: 10, selling_price: 100 }],
  });
  assert.equal(ends.status, 201, JSON.stringify(ends.data));

  const match = async (filenames) => (await call('/api/products/photo-match', { filenames })).data;

  await t.test('a product code, in any case, with or without a shot number', async () => {
    const result = await match(['BULK.jpg', 'bulk (2).JPG', 'folder/BULK-3.png']);
    for (const row of result.rows) {
      assert.equal(row.product_id, product.id,
        `"${row.filename}" landed on ${row.product_id} instead of ${product.id}`);
      assert.equal(row.matched_on, 'product_code');
    }
    assert.deepEqual(result.rows.map((row) => row.sequence), [1, 2, 3],
      'the shot order was lost, so the wrong picture would become the main one');
    assert.equal(result.matched, 3);
    assert.equal(result.unmatched, 0);
  });

  await t.test('a variant SKU and a barcode both find the product they belong to', async () => {
    const result = await match(['BULK-9.jpg', '6221000000015.jpg']);
    assert.equal(result.rows[0].product_id, product.id);
    assert.equal(result.rows[0].matched_on, 'variant_sku');
    assert.equal(result.rows[1].product_id, product.id);
    assert.equal(result.rows[1].matched_on, 'barcode');
  });

  await t.test('a code that ends in a number beats the stripped reading', async () => {
    /*
     * `BULK-2.jpg` could be the product `BULK-2` or the second shot of `BULK`,
     * and BOTH exist in this catalogue. The literal filename wins — which is
     * the only reading that is not a guess, and the one that lets a shop whose
     * codes end in numbers use this screen at all.
     */
    const result = await match(['BULK-2.jpg']);
    assert.equal(result.rows[0].product_id, ends.data.id,
      'a photograph of BULK-2 was filed against BULK');
    assert.equal(result.rows[0].code, 'BULK-2');
  });

  await t.test('a filename that matches nothing matches NOTHING — no near miss', async () => {
    /*
     * The assertion this whole feature rests on. A fuzzy match would file a
     * photograph of one product against another, and the shop would never know
     * to go and look — strictly worse than an unmatched row it can see.
     */
    for (const name of ['BUL.jpg', 'BULKY.jpg', 'BULK X.jpg', 'NOTHING-AT-ALL.jpg', '622100000001.jpg']) {
      const result = await match([name]);
      assert.equal(result.rows[0].product_id, null,
        `"${name}" was matched to product ${result.rows[0].product_id} — a photo would be filed there`);
      assert.equal(result.unmatched, 1);
    }
  });

  await t.test('it says how many photographs a product already has', async () => {
    /*
     * Uploading is additive, so a person who runs the same folder twice has to
     * be told before they commit rather than discovering four copies on the
     * shop afterwards.
     */
    const before = await match(['BULK.jpg']);
    assert.equal(before.rows[0].photo_count, 0);

    // A 1×1 PNG. GIF is refused by the upload route, correctly — the point
    // here is only that a photograph EXISTS, so the smallest legal one wins.
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const added = await call(`/api/products/${product.id}/images`, { dataUrl: pixel });
    assert.ok(added.status < 400, JSON.stringify(added.data));

    const after = await match(['BULK.jpg']);
    assert.equal(after.rows[0].photo_count, 1,
      'the screen would tell a shop a product is bare when it is not');
  });

  await t.test('the answer keeps one row per file, in the order they were sent', async () => {
    // The screen draws a row per FILE. Collapsing duplicates server-side would
    // silently drop the second and third shot of a product from the list.
    const result = await match(['BULK.jpg', 'zzz-unknown.jpg', 'BULK-2.jpg', 'BULK.jpg']);
    assert.equal(result.rows.length, 4);
    assert.deepEqual(result.rows.map((row) => row.filename),
      ['BULK.jpg', 'zzz-unknown.jpg', 'BULK-2.jpg', 'BULK.jpg']);
  });

  await t.test('an empty or junk request is answered, not crashed', async () => {
    for (const payload of [[], null, undefined, ['', '   '], 'not-an-array', [{ nested: 1 }]]) {
      const res = await call('/api/products/photo-match', { filenames: payload });
      assert.ok(res.status < 500, `${JSON.stringify(payload)} → ${res.status}`);
    }
  });

  await t.test('a stranger cannot read the shop\'s product codes through this route', async () => {
    /*
     * The response names products, so it sits behind `products.view` — the same
     * right as opening the catalogue. The case that can never be allowed is the
     * one with no session at all: this endpoint would otherwise be a way to ask
     * "does this shop stock code X?" from the open internet, one POST at a time.
     */
    const stranger = await fetch(`${base}/api/products/photo-match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames: ['BULK.jpg'] }),
    });
    assert.equal(stranger.status, 401,
      'the shop\'s product codes are readable without signing in');

    // The control: the same request WITH a session answers, so the assertion
    // above is about the session and not about the route being broken.
    const signedIn = await call('/api/products/photo-match', { filenames: ['BULK.jpg'] });
    assert.equal(signedIn.status, 200);
  });
});
