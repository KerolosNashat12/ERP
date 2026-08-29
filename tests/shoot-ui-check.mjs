/**
 * SHOOT MODE, on a phone, with real files.
 *
 * The owner asked four times for somebody to fetch product photographs off the
 * internet. They cannot be fetched — the pictures of a named product belong to
 * whoever shot them, and a generic stock bottle on a product page is worse than
 * an empty frame, because a customer orders the thing in the picture. So this
 * screen exists to make HIS photographs cheap instead: one product, a button,
 * the next one, in shelf order.
 *
 * What only a browser can answer: does the queue actually advance, does the
 * photograph reach the right product, does the counter tell the truth, and is
 * the file input still willing to take a picture from the gallery — which is
 * the bug that started all of this.
 *
 * Run the server on 4000 first, then: node tests/shoot-ui-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/`);
await page.waitForTimeout(600);
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('form button[type=submit]');
await page.waitForTimeout(2500);

await page.goto(`${BASE}/#/shoot`);
await page.reload();
await page.waitForTimeout(2200);
for (const title of ['Change password', 'تغيير كلمة المرور']) {
  const stray = page.locator('#modal-root .modal').filter({ hasText: title });
  if (await stray.count()) {
    await stray.first().locator('.modal-head button').click();
    await page.waitForTimeout(300);
  }
}
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

const card = page.locator('.shoot-card');
if (!(await card.count())) { fail('shoot mode did not open'); }

/* ── the input must still allow the gallery ──────────────────────────────── */
const input = await page.evaluate(() => {
  const el = document.querySelector('.shoot input[type="file"]');
  return el ? { capture: el.hasAttribute('capture'), accept: el.getAttribute('accept') } : null;
});
if (!input) fail('there is no file input on the shoot screen');
else {
  if (input.capture) fail('the shoot screen forces the camera — no gallery on iOS');
  if (!/image/.test(input.accept || '')) fail(`the input does not ask for pictures (accept="${input.accept}")`);
  note(`input: capture=${input.capture} accept="${input.accept}"`);
}

/* ── the queue is in shelf order ─────────────────────────────────────────── */
const queue = await page.evaluate(async () => (
  (await (await fetch('/api/products/without-photos?limit=40', { credentials: 'include' })).json())
));
if (!queue.rows.length) { fail('nothing to photograph — this check proves nothing'); }
const brands = queue.rows.map((r) => r.brand_en || '~');
const grouped = brands.every((b, i) => i === 0 || brands.indexOf(b) >= brands.lastIndexOf(brands[i - 1]) - 0
  || b === brands[i - 1] || !brands.slice(0, i - 1).includes(b));
if (!grouped) fail(`the queue is not grouped by brand: ${brands.slice(0, 10).join(', ')}`);
note(`${queue.remaining} products without a photo; first brands: ${[...new Set(brands)].slice(0, 3).join(', ')}`);

const firstName = await page.locator('.shoot-name').innerText();
const firstCode = await page.locator('.shoot-code').innerText();
const firstId = queue.rows[0].id;
if (firstCode.trim() !== queue.rows[0].code) {
  fail(`the screen shows ${firstCode} but the queue starts at ${queue.rows[0].code}`);
}
note(`first up: ${firstName} (${firstCode})`);

/* ── photograph it ───────────────────────────────────────────────────────── */
const shoot = async (hue) => page.evaluate(async (h) => {
  const el = document.querySelector('.shoot input[type="file"]');
  const canvas = document.createElement('canvas');
  canvas.width = 2000; canvas.height = 1500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${h} 65% 55%)`;
  ctx.fillRect(0, 0, 2000, 1500);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'shot.jpg', { type: 'image/jpeg' }));
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, hue);

await shoot(10);
await page.waitForTimeout(4000);

/* It reached the RIGHT product. */
const attached = await page.evaluate(async (id) => (
  (await (await fetch(`/api/products/${id}/images`, { credentials: 'include' })).json()).rows.length
), firstId);
if (attached !== 1) fail(`the photograph did not reach product ${firstId} (${attached} images)`);

/* And the screen moved on. */
const secondCode = await page.locator('.shoot-code').innerText();
if (secondCode.trim() === firstCode.trim()) fail('the queue did not advance after a photograph');
else note(`advanced to: ${secondCode.trim()}`);

const progress = await page.locator('.shoot-progress p').innerText();
if (!/\b1\b/.test(progress)) fail(`the counter does not say one is done: "${progress}"`);
note(`counter: ${progress}`);

/* ── skipping moves on WITHOUT marking anything done ─────────────────────── */
const beforeSkip = (await page.locator('.shoot-code').innerText()).trim();
await page.locator('.shoot-skip').click();
await page.waitForTimeout(600);
const afterSkip = (await page.locator('.shoot-code').innerText()).trim();
if (afterSkip === beforeSkip) fail('skip did not move to the next product');
const progressAfterSkip = await page.locator('.shoot-progress p').innerText();
if (progressAfterSkip !== progress) {
  fail(`skipping changed the "done" counter: "${progress}" -> "${progressAfterSkip}"`);
}
/*
 * And the skipped product is STILL in the shop's list of bare products — a
 * skip that quietly hid it would leave it invisible to the only screen that
 * knows it has no picture.
 */
const stillListed = await page.evaluate(async (code) => {
  const d = await (await fetch('/api/products/without-photos?limit=500', { credentials: 'include' })).json();
  return d.rows.some((r) => r.code === code);
}, beforeSkip);
if (!stillListed) fail(`the skipped product ${beforeSkip} vanished from the shoot list`);
note(`skipped ${beforeSkip}: still listed, counter unchanged`);

/* ── a second shot lands on the product now showing ──────────────────────── */
const thirdCode = (await page.locator('.shoot-code').innerText()).trim();
const thirdId = queue.rows.find((r) => r.code === thirdCode)?.id;
await shoot(200);
await page.waitForTimeout(4000);
if (thirdId) {
  const n = await page.evaluate(async (id) => (
    (await (await fetch(`/api/products/${id}/images`, { credentials: 'include' })).json()).rows.length
  ), thirdId);
  if (n !== 1) fail(`the second photograph did not reach ${thirdCode} (${n} images)`);
  else note(`second shot reached ${thirdCode}`);
}

if (errs.length) fail(errs.join(' / '));
await page.screenshot({ path: '/tmp/shoot.png' });
await browser.close();

console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ shoot mode: shelf order, gallery allowed, photo reaches the right product, queue advances');
