/**
 * ADDING TO THE BASKET FROM THE SHELF, INCLUDING A PRODUCT WITH SIZES.
 *
 * The owner, on a card whose button read «اختار المقاس»: *"ينفع تظبط اختر
 * المقاس دي ل اضف للسله عادي"*. The button now says «أضف للسلة» on every
 * card, and a product with more than one size answers the tap with its sizes,
 * on the card, instead of navigating away.
 *
 * Four things, and every one of them is a way this could be quietly wrong:
 *
 *   · **Every card says «أضف للسلة».** If any still says "choose options" the
 *     change did not reach the shelf it was asked for.
 *   · **A multi-size product opens its sizes, and the basket is still empty
 *     until one is chosen.** Adding on the first tap would be the guess this
 *     deliberately does not make — the wrong bottle in the bag, found at the
 *     door.
 *   · **Choosing a size adds THAT size**, at that size's price. The panel is
 *     pointless if it adds the first one whatever was tapped.
 *   · **A product with one size adds on the first tap**, with no panel at all.
 *
 * It builds its own fixture: a product with three sizes at three prices and a
 * product with one, published, with stock. A check that leans on whatever
 * happens to be in the shop stops checking the day the shop changes.
 *
 *     MM_TEST_URL=http://127.0.0.1:4000 node tests/quick-add-sizes-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

/* ── the fixture, through the real ERP API ───────────────────────────────── */
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
if (!login.ok) {
  console.error(`could not sign in to build the fixture: ${login.status}`);
  process.exit(1);
}
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (path, body, method = 'POST') => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      cookie,
      'Idempotency-Key': `q-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};

/*
 * A run-unique tag on every code. The check is meant to be re-runnable against
 * a server somebody left running — without this the second run is refused with
 * "SKU prefix already used" and reports nothing about the shelf at all.
 */
const TAG = Date.now().toString(36).slice(-5).toUpperCase();

const SIZES = [
  { sku: `QA-${TAG}-30`, variant_label: '30ml', cost_price: 100, selling_price: 300 },
  { sku: `QA-${TAG}-50`, variant_label: '50ml', cost_price: 150, selling_price: 450 },
  { sku: `QA-${TAG}-100`, variant_label: '100ml', cost_price: 250, selling_price: 750 },
];

const many = await call('/api/products', {
  sku_prefix: `QASIZES${TAG}`, name_en: 'Three Sizes', name_ar: 'تلات مقاسات',
  base_price: 300, is_published: 1, variants: SIZES,
});
const one = await call('/api/products', {
  sku_prefix: `QAONE${TAG}`, name_en: 'One Size', name_ar: 'مقاس واحد',
  base_price: 200, is_published: 1,
  variants: [{ sku: `QA-${TAG}-ONLY`, variant_label: '', cost_price: 80, selling_price: 200 }],
});
if (many.status !== 201 || one.status !== 201) {
  console.error(`fixture products refused: ${many.status} / ${one.status}`);
  console.error(JSON.stringify(many.data || one.data));
  process.exit(1);
}

// Stock, or every card is "out" and draws no button at all.
for (const product of [many.data, one.data]) {
  for (const variant of product.variants) {
    // eslint-disable-next-line no-await-in-loop
    const moved = await call('/api/inventory/quick-adjust', {
      variantId: variant.id, warehouseId: 1, newQuantity: 20,
      reason: 'correction', notes: 'quick-add fixture',
    });
    if (moved.status >= 400) fail(`could not stock ${variant.sku}: ${moved.status} ${JSON.stringify(moved.data)}`);
  }
  // eslint-disable-next-line no-await-in-loop
  await call(`/api/products/${product.id}`, { ...product, is_published: 1 }, 'PUT');
}
note(`fixture: product ${many.data.id} with ${many.data.variants.length} sizes, product ${one.data.id} with 1`);

/* ── now look at the shelf the way a shopper does ────────────────────────── */
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// The quick-add overlay only exists where there IS a pointer to hover with.
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, hasTouch: false });
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));

// It is also a luxe-skin feature; set the template before looking for it.
await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ 'web.template': 'luxe' }),
});

const shelf = `${BASE}/shop/#/products`;
await page.goto(shelf);
await page.waitForTimeout(2600);

/**
 * The card for one product, hovered.
 *
 * `.card` is a DIV with the link INSIDE it, not an anchor itself — the first
 * version of this looked for `a.card[href*=id]`, matched nothing, and reported
 * "the shelf has no card for product 3" about a shelf that was showing it.
 * And the id has to be matched as a whole path segment: `href*="3"` also finds
 * product 13 and product 30.
 */
async function hoverCard(productId) {
  const target = page.locator('.card').filter({
    has: page.locator(`a[href*="/product/${productId}/"]`),
  }).first();
  if (!(await target.count())) return null;
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  await page.waitForTimeout(400);
  return target;
}

const labels = await page.evaluate(() => [...document.querySelectorAll('.card-add-btn')]
  .map((n) => n.textContent.trim()).filter(Boolean));
if (!labels.length) fail('no quick-add button on any card — the check cannot see what it is judging');
else {
  const wrong = labels.filter((l) => /اختار المقاس|choose options/i.test(l));
  if (wrong.length) fail(`${wrong.length} card(s) still say "${wrong[0]}"`);
  else note(`${labels.length} cards, all labelled "${labels[0]}"`);
}

const clearCart = () => page.evaluate(() => {
  Object.keys(localStorage).filter((k) => /cart/i.test(k)).forEach((k) => localStorage.removeItem(k));
});
const cartLines = () => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => /cart/i.test(k));
  try { return key ? (JSON.parse(localStorage.getItem(key))?.lines || JSON.parse(localStorage.getItem(key)) || []) : []; }
  catch { return []; }
});

/* ── the product with three sizes ────────────────────────────────────────── */
await clearCart();
const multi = await hoverCard(many.data.id);
if (!multi) fail(`the shelf has no card for product ${many.data.id}`);
else {
  /*
   * `.card-add-btn`, not `.card-add`. The outer box is a RULER the size of the
   * photo and is `pointer-events: none` so the rest of the card stays
   * clickable — clicking its centre lands on the card's own link and navigates
   * to the product page, which is how the first run of this check reported
   * "no size panel" about a panel that works. Click what a person clicks.
   */
  await multi.locator('.card-add-btn').click();
  await page.waitForTimeout(900);

  const offered = await page.evaluate(() => [...document.querySelectorAll('.card-size')]
    .map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
  if (offered.length !== 3) fail(`the size panel offered ${offered.length} sizes, expected 3: ${offered.join(' | ')}`);
  else note(`sizes offered: ${offered.join(' · ')}`);

  const beforeChoosing = await cartLines();
  if (beforeChoosing.length) {
    fail('opening the sizes already put something in the basket — that is the guess this must not make');
  } else {
    note('nothing in the basket until a size is chosen');
  }

  // Choose the LAST one — the 100ml at 750 — so "it added the first one
  // whatever was tapped" cannot pass.
  //
  // Guarded rather than a bare click: when the panel does not appear at all —
  // which is exactly what a regression here looks like — a bare
  // `.card-size.click()` throws a 30-second Playwright timeout and the script
  // dies before printing a single one of its findings. A check that cannot
  // report its own failures is not much of a check.
  const chosen = await page.locator('.card-size').last()
    .click({ timeout: 4000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(900);
  const after = await cartLines();
  if (!chosen) {
    fail('there was no size to choose — the panel never appeared');
  } else if (after.length !== 1) {
    fail(`choosing a size put ${after.length} line(s) in the basket, expected 1`);
  } else {
    const line = after[0];
    if (Number(line.price) !== 750 || String(line.label) !== '100ml') {
      fail(`chose 100ml at 750 and the basket holds "${line.label}" at ${line.price}`);
    } else {
      note(`chose 100ml → basket holds ${line.label} at ${line.price}`);
    }
  }
}

/* ── the product with one size ───────────────────────────────────────────── */
await clearCart();
await page.reload();
await page.waitForTimeout(2400);
const single = await hoverCard(one.data.id);
if (!single) fail(`the shelf has no card for product ${one.data.id}`);
else {
  await single.locator('.card-add-btn').click();
  await page.waitForTimeout(900);
  const panels = await page.locator('.card-sizes').count();
  if (panels) fail('a one-size product opened a size panel — there is nothing to choose');
  const after = await cartLines();
  if (after.length !== 1) fail(`one tap on a one-size product left ${after.length} line(s) in the basket`);
  else note(`a one-size product added on the first tap (${after[0].price})`);
}

await browser.close();
for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ quick add: every card says «أضف للسلة», sizes are chosen on the card, and the chosen one is what lands');
process.exit(0);
