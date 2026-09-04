/**
 * CHANGING WHAT A REPLACEMENT COSTS, ON THE EXCHANGE SCREEN.
 *
 * The owner's case, in his words: «حد جه يرجع استرونجر بـسوفاج، واسترونجر كانت
 * بـ200 وسوفاج 500 — مش لازم السيستيم يجبرني انها تفضل 500، لا أقدر أغير فيها
 * أو أحط خصم».
 *
 * The money is proved in `returns-exchanges-bulk.test.js`. What only a browser
 * can prove is the half that decides whether the feature is usable at all:
 *
 *   · the price and % boxes are THERE and can be typed into;
 *   · **the number on screen is the number the server charges.** The screen
 *     does its own arithmetic so the total moves as the cashier types — which
 *     means there are now two implementations of one sum, and the day they
 *     disagree the cashier tells the customer one figure and the till takes
 *     another. That is found out at the counter, by an argument.
 *
 * It runs the whole thing TWICE, once per route to the same 400: typing a new
 * price (500 → 400), and typing a discount in MONEY (100 off 500). They are
 * different fields on the wire and different arithmetic on the screen, and
 * doing only one leaves the other unfenced — which is exactly what the first
 * version of this did.
 *
 *     MM_TEST_URL=http://127.0.0.1:4000 node tests/exchange-price-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);
const TAG = Date.now().toString(36).slice(-5).toUpperCase();

/* ── two sales to exchange against, built through the real API ───────────── */
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
if (!login.ok) { console.error(`sign-in failed: ${login.status}`); process.exit(1); }
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (path, body, method = 'POST') => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      cookie,
      'Idempotency-Key': `x-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};

// Stronger at 200 and Sauvage at 500 — his own two.
const make = async (prefix, name, price) => {
  const made = await call('/api/products', {
    sku_prefix: `${prefix}${TAG}`, name_en: name, name_ar: name, base_price: price,
    variants: [{ sku: `${prefix}-${TAG}`, variant_label: '', cost_price: price / 2, selling_price: price }],
  });
  if (made.status !== 201) { console.error(`${name}: ${made.status} ${JSON.stringify(made.data)}`); process.exit(1); }
  const variant = made.data.variants[0];
  await call('/api/inventory/quick-adjust', {
    variantId: variant.id, warehouseId: 1, newQuantity: 20, reason: 'correction', notes: 'fixture',
  });
  return { product: made.data, variant };
};
const stronger = await make('STRG', 'Stronger', 200);
await make('SAUV', 'Sauvage', 500);

const invoices = [];
for (let i = 0; i < 2; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const sale = await call('/api/sales', {
    payment_method: 'cash',
    lines: [{ variant_id: stronger.variant.id, quantity: 1 }],
  });
  if (sale.status >= 400) { console.error(`sale: ${sale.status} ${JSON.stringify(sale.data)}`); process.exit(1); }
  invoices.push(sale.data.invoice_no);
}
note(`fixture: ${invoices.join(' and ')} — Stronger 200 sold, Sauvage 500 on the shelf`);

/* ── now do it the way he would ──────────────────────────────────────────── */
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));

await page.goto(`${BASE}/`);
await page.waitForTimeout(700);
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('form button[type=submit]');
await page.waitForTimeout(2600);
await page.evaluate(() => localStorage.setItem('mm.lang', 'en'));

/** The forced password change sits in #modal-root and eats every click below it. */
async function dismissStrayDialogs() {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const closed = await page.evaluate(() => {
      const head = [...document.querySelectorAll('#modal-root .modal-head')]
        .find((h) => /password/i.test(h.textContent || ''));
      const button = head?.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!closed) return;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(350);
  }
}

/** How many exchanges exist, so a new one can be told from an old one. */
const exchangeCount = async () => Number(
  (await call('/api/exchanges?page=1&pageSize=1', undefined, 'GET')).data?.total ?? 0,
);

/**
 * One whole exchange, driven the way he would drive it.
 *
 * `mode` says which box is typed into: the PRICE (500 → 400) or the DISCOUNT
 * (100 off 500). Both land on the same 400 on purpose, so the screen and the
 * server are each compared against one known number rather than against each
 * other's arithmetic.
 */
async function runExchange(invoiceNo, mode) {
  const before = await exchangeCount();

  await page.goto(`${BASE}/#/exchanges/new`);
  await page.reload();
  await page.waitForTimeout(2500);
  await dismissStrayDialogs();

  /*
   * By PLACEHOLDER, not by position. `input` first matches the topbar's own
   * scan box on every screen in this ERP, which is what the first run of this
   * typed an invoice number into — the exchange screen never saw it, and the
   * check reported "the invoice may not have loaded" about an invoice it had
   * never asked for.
   */
  await page.locator('input[placeholder*="invoice" i]').first().fill(invoiceNo);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2200);

  const took = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '＋');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!took) { fail(`[${mode}] could not mark the returned piece — the invoice did not load`); return; }
  await page.waitForTimeout(800);

  /*
   * Searched and matched by THIS RUN'S OWN SKU, not by the name.
   *
   * Every run leaves a product called "Sauvage" behind, so a picker searched
   * for "Sauvage" hands back the oldest one — whose stock previous runs have
   * already spent. The check then failed with "insufficient stock" about a
   * product it had itself stocked a moment earlier, which took a toast to
   * explain. A fixture has to be identifiable, not just present.
   */
  await page.locator('input[placeholder*="code" i]').last().fill(`SAUV-${TAG}`);
  await page.waitForTimeout(1700);
  // `.pos-result` — the picker's rows are DIVs, not buttons. Guessing at
  // `button, li, .option` matched nothing and reported "could not pick
  // Sauvage" about a picker that was showing it.
  const picked = await page.evaluate((sku) => {
    const option = [...document.querySelectorAll('.pos-result')]
      .find((n) => (n.textContent || '').includes(sku));
    if (!option) return false;
    option.click();
    return true;
  }, `SAUV-${TAG}`);
  if (!picked) { fail(`[${mode}] could not pick Sauvage as the replacement`); return; }
  await page.waitForTimeout(1100);

  const typed = await page.evaluate((how) => {
    const numbers = [...document.querySelectorAll('input[type="number"]')];
    // The price box is the one holding the shelf price; the % box is the one
    // capped at 100 sitting beside it.
    const price = numbers.find((i) => Number(i.value) === 500);
    if (!price) return 'no price box holding the 500';
    const target = how === 'price' ? price : numbers[numbers.indexOf(price) + 1];
    if (!target) return 'no discount box beside the price';
    // 400 typed as a price, or 100 taken off — the same money either way.
    target.value = how === 'price' ? '400' : '100';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return 'typed';
  }, mode);
  if (typed !== 'typed') { fail(`[${mode}] ${typed} — the replacement cannot be re-priced`); return; }
  await page.waitForTimeout(700);

  /*
   * What the SCREEN says the replacement costs — read as a NUMBER off the
   * settlement strip, not by looking for "200" somewhere in the page.
   *
   * The looser version passed while the preview ignored the discount entirely:
   * the credit is also 200, so the digits were on the page whatever the
   * replacement said. An assertion that a wrong screen satisfies is not an
   * assertion. This reads the replacement line itself and requires 400.
   */
  const screen = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const shown = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.totals .line, .totals > div')];
    const read = (pattern) => {
      const row = rows.find((n) => pattern.test(n.textContent || ''));
      if (!row) return null;
      const match = (row.textContent || '').match(/([\d,]+(?:\.\d+)?)\s*$/);
      return match ? Number(match[1].replace(/,/g, '')) : null;
    };
    return { replacement: read(/replacement/i), difference: read(/pays|back|settle/i) };
  });
  if (shown.replacement !== 400) {
    fail(`[${mode}] the screen shows the replacement at ${shown.replacement}, expected 400 — `
      + 'the preview did not follow what was typed');
  }
  if (shown.difference !== 200) {
    fail(`[${mode}] the screen says the customer pays ${shown.difference}, expected 200`);
  }

  /*
   * AND THE ROW ITSELF. The settlement strip agreeing with the server is not
   * enough: the first cut redrew only the strip on a keystroke, so the strip
   * said 400 while the row beside it still said 500 — two numbers for one line
   * on screen at once, and the cashier reads the row. This check did not
   * notice, because it only ever looked at the strip; a screenshot did.
   */
  const rowTotal = await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((n) => /SAUV-/.test(n.textContent || ''));
    if (!row) return null;
    const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.trim());
    const monies = cells.map((c) => {
      const match = c.match(/([\d,]+\.\d{2})/);
      return match ? Number(match[1].replace(/,/g, '')) : null;
    }).filter((n) => n !== null);
    return monies.length ? monies[0] : null;
  });
  if (rowTotal !== 400) {
    fail(`[${mode}] the replacement's own row shows ${rowTotal}, while the settlement says `
      + `${shown.replacement} — one line, two numbers, and the cashier reads the row`);
  }

  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find((b) => /complete the exchange|إتمام|اتمام/i.test(b.textContent || '')
        && !b.closest('#modal-root'));
    button?.click();
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('#modal-root button')]
      .filter((b) => !/cancel|إلغاء/i.test(b.textContent || ''))
      .find((b) => /confirm|yes|ok|complete|تأكيد|تمام/i.test(b.textContent || ''));
    button?.click();
  });
  await page.waitForTimeout(2600);

  if (await exchangeCount() === before) {
    /*
     * Say WHY. "Nothing was recorded" is the symptom of a refused request, a
     * dialog that never opened, and a button that was never pressed — three
     * very different problems, and reading the toast is the difference between
     * fixing one and guessing at all three.
     */
    const complaint = await page.evaluate(() => {
      const toast = document.querySelector('.toast, .toast-error, #toast-root');
      const dialog = document.querySelector('#modal-root');
      return {
        toast: toast?.innerText?.trim().slice(0, 200) || null,
        dialogOpen: Boolean(dialog && dialog.children.length),
        dialog: dialog?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
      };
    });
    fail(`[${mode}] no exchange was recorded — toast: ${complaint.toast || 'none'} · dialog `
      + `${complaint.dialogOpen ? `still open: ${complaint.dialog}` : 'closed'}`);
    return;
  }
  const latest = (await call('/api/exchanges?page=1&pageSize=1', undefined, 'GET')).data.rows[0];
  const money = {
    credit: Number(latest.credit_amount),
    replacement: Number(latest.replacement_amount),
    difference: Number(latest.difference_amount),
  };
  note(`[${mode}] credit ${money.credit} · replacement ${money.replacement} · customer pays ${money.difference}`);

  if (money.replacement !== 400) {
    fail(`[${mode}] the screen was showing 400 and the server charged ${money.replacement}`);
  }
  if (money.credit !== 200) fail(`[${mode}] the credit should be 200, got ${money.credit}`);
  if (money.difference !== 200) fail(`[${mode}] the customer should pay 200, got ${money.difference}`);
}

await runExchange(invoices[0], 'price');
await runExchange(invoices[1], 'discount');

await browser.close();
for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ exchange: a replacement can be re-priced or discounted, and the screen and the till agree');
process.exit(0);
