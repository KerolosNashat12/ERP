/**
 * The bulk photo screen, driven by a real browser with real files.
 *
 * WHY THIS EXISTS AND NOT JUST A UNIT TEST. The last feature I shipped without
 * opening it — the swap on a purchase return — had correct money, correct
 * stock and three screens on which a person could not see that anything had
 * happened. The owner found that, not the tests. So the question this file
 * asks is the one those tests could not: put files in, does a person see the
 * right thing, and do the photographs actually arrive on the products?
 *
 * Files are synthesised here rather than shipped, so the check carries no
 * binaries and cannot rot against a fixture nobody looks at.
 *
 * Run the server on 4000 first, then:  node tests/bulk-photos-ui-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
const note = (message) => notes.push(message);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => fail(`[pageerror] ${error.message}`));
/*
 * Console errors are failures — but only once we are signed in. The shell
 * probes `/api/auth/me` before it knows whether a session exists, and that
 * 401 is the mechanism working, not a defect. Gating on the flag rather than
 * filtering on the text keeps a real 401 later in the run a failure.
 */
let signedIn = false;
page.on('console', (message) => {
  if (message.type() === 'error' && signedIn) fail(`[console] ${message.text()}`);
});
page.on('response', (response) => {
  if (signedIn && response.status() >= 400 && response.url().includes('/api/')) {
    fail(`[http ${response.status()}] ${response.url()}`);
  }
});

/* ── sign in ─────────────────────────────────────────────────────────────── */
await page.goto(`${BASE}/`);
await page.waitForTimeout(600);
await page.fill('input[name="username"]', 'admin');
await page.fill('input[name="password"], input[type="password"]', 'admin123');
await page.click('form button[type="submit"], form .btn.primary');
await page.waitForTimeout(2500);
if (/Sign in to continue|تسجيل الدخول/.test(await page.innerText('body'))) {
  fail('sign-in did not go through — everything below would be meaningless');
  await page.screenshot({ path: '/tmp/bulk-photos-login.png' });
  console.log('  - sign-in failed, see /tmp/bulk-photos-login.png');
  await browser.close();
  process.exit(1);
}
signedIn = true;

/* ── which product codes this shop actually has ──────────────────────────── */
/*
 * Products that have NO photograph yet, preferred over the first two in the
 * list. The order check below — first file becomes the main photo — can only
 * be made on a product whose main photo is not already something else, and on
 * a database this check has run against before, the first two products are
 * exactly the ones that are no longer bare.
 */
const codes = await page.evaluate(async () => {
  const res = await fetch('/api/products?page=1&pageSize=60', { credentials: 'include' });
  const rows = (await res.json()).rows;
  const withCounts = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const images = await fetch(`/api/products/${row.id}/images`, { credentials: 'include' });
    withCounts.push({
      id: row.id, code: row.sku_prefix, name: row.name_en,
      photos: (await images.json()).rows.length,
    });
  }
  withCounts.sort((a, b) => a.photos - b.photos);
  return withCounts.slice(0, 3);
});
if (codes.length < 2) fail('the shop has fewer than two products — this check proves nothing');
note(`products used: ${codes.map((c) => c.code).join(', ')}`);

const before = await page.evaluate(async (ids) => {
  const out = {};
  for (const id of ids) {
    const res = await fetch(`/api/products/${id}/images`, { credentials: 'include' });
    out[id] = (await res.json()).rows.length;
  }
  return out;
}, codes.map((c) => c.id));

/* ── open the screen ─────────────────────────────────────────────────────── */
await page.goto(`${BASE}/#/products`);
await page.reload();
await page.waitForTimeout(1200);

/*
 * Whatever the shell decided to open on arrival — this database asks the admin
 * to change their password — is dismissed first, BY ITS OWN CLOSE BUTTON. A
 * backdrop left on the page swallows every click below it and the failure that
 * follows is a timeout that names the wrong element. This cost three rounds
 * once already; addressing dialogs by title rather than by "the last one in
 * modal-root" is the lesson.
 */
for (const title of ['Change password', 'تغيير كلمة المرور']) {
  const stray = page.locator('#modal-root .modal').filter({ hasText: title });
  if (await stray.count()) {
    await stray.first().locator('.modal-head button').click();
    await page.waitForTimeout(300);
  }
}

const button = page.locator('.page-head button', { hasText: /Bulk photos|صور بالجملة/ });
if (!(await button.count())) fail('the Bulk photos button is not on the products page');
else {
  await button.first().click();
  await page.waitForTimeout(400);
}

const dialog = page.locator('.modal').filter({ hasText: /Bulk photos|صور بالجملة/ });
if (!(await dialog.count())) fail('the bulk photos dialog did not open');

/*
 * Four files: two that name real products (one of them a second shot, to prove
 * the ` (2)` suffix is understood), and two that name nothing.
 */
const files = [
  { name: `${codes[0].code}.jpg`, hue: 10 },
  { name: `${codes[0].code} (2).jpg`, hue: 120 },
  { name: `${codes[1].code}.jpg`, hue: 220 },
  { name: 'NOT-A-REAL-CODE-XYZ.jpg', hue: 300 },
];

/*
 * The files are drawn in the page and handed to the input through a
 * DataTransfer, which is what a real drop or pick produces. `setInputFiles`
 * with a path would work too, but this keeps the check self-contained and
 * exercises the same File objects the browser would build.
 */
await page.evaluate(async (specs) => {
  const transfer = new DataTransfer();
  for (const spec of specs) {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${spec.hue} 60% 55%)`;
    ctx.fillRect(0, 0, 400, 400);
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    transfer.items.add(new File([blob], spec.name, { type: 'image/jpeg' }));
  }
  const input = [...document.querySelectorAll('.modal input[type="file"]')].pop();
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, files);

await page.waitForTimeout(1500);

/* ── what a person now sees ──────────────────────────────────────────────── */
const text = await dialog.innerText();
for (const spec of files) {
  if (!text.includes(spec.name)) fail(`the file "${spec.name}" is not listed on screen`);
}
if (!text.includes(codes[0].name)) {
  fail(`"${files[0].name}" did not show the product it matched (${codes[0].name})`);
}
if (!/No product with this code|مفيش منتج بالكود ده/.test(text)) {
  fail('the unmatched file was not called out — a person would not know it was skipped');
}

const uploadLabel = await dialog.locator('.modal-foot .btn.primary').innerText();
if (!/\(3\)/.test(uploadLabel)) {
  fail(`the upload button should offer 3 files, it says: "${uploadLabel}"`);
}
note(`upload button: "${uploadLabel}"`);

/* ── upload, and check the photographs actually arrived ──────────────────── */
await dialog.locator('.modal-foot .btn.primary').click();
await page.waitForTimeout(6000);

const after = await page.evaluate(async (ids) => {
  const out = {};
  for (const id of ids) {
    const res = await fetch(`/api/products/${id}/images`, { credentials: 'include' });
    out[id] = (await res.json()).rows.length;
  }
  return out;
}, codes.map((c) => c.id));

const gainedFirst = after[codes[0].id] - before[codes[0].id];
const gainedSecond = after[codes[1].id] - before[codes[1].id];
if (gainedFirst !== 2) fail(`${codes[0].code} should have gained 2 photographs, gained ${gainedFirst}`);
if (gainedSecond !== 1) fail(`${codes[1].code} should have gained 1 photograph, gained ${gainedSecond}`);
note(`${codes[0].code}: +${gainedFirst}   ${codes[1].code}: +${gainedSecond}`);

/*
 * ORDER. The first file of a product has to become its main photograph, or a
 * shop of 248 products ends up showing whichever shot the picker happened to
 * hand over first — and fixing that by hand is the work this screen exists to
 * remove. The two uploads were solid colours, so the main one is checked by
 * its actual pixels.
 */
const mainHue = await page.evaluate(async (id) => {
  const res = await fetch(`/api/products/${id}/images`, { credentials: 'include' });
  const rows = (await res.json()).rows;
  const main = rows.find((row) => row.is_primary) || rows[0];
  const image = new Image();
  image.src = `/api/products/${id}/images/${main.id}/raw`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, 8, 8);
  const [r, g, b] = ctx.getImageData(4, 4, 1, 1).data;
  // Hue only — JPEG shifts the exact values, it does not move red to green.
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max === min) return -1;
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : (max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  hue = Math.round(hue * 60);
  return hue < 0 ? hue + 360 : hue;
}, codes[0].id);

if (before[codes[0].id] === 0) {
  // Only meaningful when this product had no photograph before: otherwise its
  // main one is whatever it already had, correctly.
  if (Math.abs(mainHue - 10) > 25) {
    fail(`the main photo should be the FIRST file (hue ~10), it is hue ${mainHue}`);
  }
  note(`main photo hue ${mainHue} (expected ~10, the first file)`);
} else {
  note(`main photo not checked — ${codes[0].code} already had ${before[codes[0].id]}`);
}

await page.screenshot({ path: '/tmp/bulk-photos.png', fullPage: false });
await browser.close();

console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ bulk photos: files matched, listed, uploaded, ordered');
