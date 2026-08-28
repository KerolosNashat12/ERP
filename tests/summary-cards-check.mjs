/**
 * The counters above the lists, driven the way the owner drives them.
 *
 * Two things are being defended. First that the cards AGREE with the list under
 * them - a header describing the whole shop while the table shows one brand is
 * worse than no header at all. Second that a card is a way IN: tapping «حريمي»
 * has to narrow the list, light the card and move the dropdown, or the screen
 * ends up narrowed with nothing on it saying why.
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/summary-cards-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch({
  executablePath: process.env.MM_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('pageerror', (e) => fail(`[pageerror] ${e.message}`));

await page.goto(`${BASE}/app.html`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[name="username"], #username', 'admin');
await page.fill('input[type="password"]', 'admin123');
await page.press('input[type="password"]', 'Enter');
await page.waitForSelector('h2');
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelectorAll('#modal-root > *').forEach((n) => n.remove()); });

const cards = () => page.$$eval('.summary-cards .kpi', (nodes) => nodes.map((n) => ({
  label: n.querySelector('.label')?.textContent?.trim(),
  value: n.querySelector('.value')?.textContent?.trim(),
  on: n.classList.contains('is-on'),
})));

// ----------------------------------------------------------------- products
await page.goto(`${BASE}/app.html#/products`);
await page.waitForSelector('.summary-cards .kpi', { timeout: 15000 });
await page.waitForTimeout(800);

const before = await cards();
if (before.length < 5) fail(`the products screen drew ${before.length} cards`);
const women = before.find((c) => /Women|حريمي/i.test(c.label || ''));
if (!women) fail('no "for women" card on the products screen');

/*
 * The three genders must account for every product. If they do not, one of them
 * is being counted twice or a product is falling through the gaps - and the
 * owner classifies 163 products against these three numbers.
 */
const num = (card) => Number(String(card?.value || '0').replace(/[^\d]/g, ''));
const total = num(before[0]);
const genders = ['Women|حريمي', 'Men|رجالي', 'Unisex|للجنسين']
  .map((pattern) => num(before.find((c) => new RegExp(`^(${pattern})$`, 'i').test(c.label || ''))));
const summed = genders.reduce((a, b) => a + b, 0);
if (summed !== total) fail(`the three gender cards add up to ${summed}, not ${total}`);
console.log(`products: ${total} total = ${genders.join(' + ')} by gender`);

// --- tapping one narrows the list, lights the card and moves the dropdown
const rowsBefore = await page.$$eval('tbody tr', (n) => n.length);
/*
 * The card is found by what it SAYS, not by where it sits. This check used to
 * click the second card, which was the women card until a piece count was added
 * in front of it - and then the check failed for a reason that had nothing to
 * do with the behaviour it exists to defend.
 */
const clickCardNamed = async (pattern) => page.evaluate((source) => {
  const card = [...document.querySelectorAll('.summary-cards .kpi.is-clickable')]
    .find((n) => new RegExp(source, 'i').test(n.querySelector('.label')?.textContent || ''));
  if (!card) return false;
  card.click();
  return true;
}, pattern);
if (!await clickCardNamed('^(Women|حريمي)$')) fail('no clickable "for women" card to tap');
await page.waitForTimeout(1200);
const rowsAfter = await page.$$eval('tbody tr', (n) => n.length);
const after = await cards();
const lit = after.filter((c) => c.on);
const dropdown = await page.evaluate(() => [...document.querySelectorAll('.filters select')]
  .map((s) => s.value).filter(Boolean));

console.log(`products: tapped a gender card — ${rowsBefore} rows → ${rowsAfter}, lit ${lit.length}, selects ${JSON.stringify(dropdown)}`);
if (!lit.length) fail('tapping a card did not light it');
if (rowsAfter >= rowsBefore) fail(`the card did not narrow the list (${rowsBefore} → ${rowsAfter})`);
if (!dropdown.includes('women')) fail(`the matching dropdown was not moved: ${JSON.stringify(dropdown)}`);

// Tapping it again puts everything back — a filter with no way off is a trap.
await clickCardNamed('^(Women|حريمي)$');
await page.waitForTimeout(1200);
const restored = await page.$$eval('tbody tr', (n) => n.length);
if (restored !== rowsBefore) fail(`tapping the card again did not restore the list (${restored} vs ${rowsBefore})`);

// ---------------------------------------------------------------- inventory
await page.goto(`${BASE}/app.html#/inventory`);
await page.waitForSelector('.summary-cards .kpi', { timeout: 15000 });
await page.waitForTimeout(900);
const stock = await cards();
console.log('inventory:', stock.map((c) => `${c.label}=${c.value}`).join(' · '));
if (stock.length < 4) fail(`the stock screen drew ${stock.length} cards`);

// ---------------------------------------------------------------- suppliers
await page.goto(`${BASE}/app.html#/suppliers`);
await page.waitForSelector('.summary-cards .kpi', { timeout: 15000 });
await page.waitForTimeout(900);
const suppliers = await cards();
console.log('suppliers:', suppliers.map((c) => `${c.label}=${c.value}`).join(' · '));
if (suppliers.length < 3) fail(`the suppliers screen drew ${suppliers.length} cards`);

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('summary cards: all checks passed');
