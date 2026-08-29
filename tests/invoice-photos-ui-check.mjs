/**
 * ADDING INVOICE PHOTOGRAPHS FROM THE GALLERY — driven in a real browser.
 *
 * The bug this exists for, reported from an iPhone: «إضافة صورة» opened the
 * camera and offered nothing else, so a photograph taken earlier — or sent on
 * WhatsApp — could not be attached at all. One attribute, `capture`, which on
 * iOS means "the camera is the only source" rather than "offer the camera
 * first".
 *
 * A headless browser has neither a camera nor a gallery, so what it CAN prove
 * is the half that matters here: the input is willing to take files the person
 * already has, it takes SEVERAL of them at once (a paper invoice is several
 * pages, all sitting in the gallery together), each one is resized on the phone
 * before it is sent, and all of them arrive as separate attachments on the
 * invoice. The `capture` attribute itself is fenced in tests/photo-input.test.js.
 *
 * Run the server on 4000 first, then: node tests/invoice-photos-ui-check.mjs
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
// A phone, because that is where this is used and where the bug was.
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
for (const title of ['Change password', 'تغيير كلمة المرور']) {
  const stray = page.locator('#modal-root .modal').filter({ hasText: title });
  if (await stray.count()) {
    await stray.first().locator('.modal-head button').click();
    await page.waitForTimeout(300);
  }
}
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

/* A supplier to file the invoice against. */
const supplierId = await page.evaluate(async () => {
  const list = await (await fetch('/api/suppliers?page=1&pageSize=1', { credentials: 'include' })).json();
  if (list.rows?.length) return list.rows[0].id;
  const made = await (await fetch('/api/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `sup-${Math.random()}` },
    credentials: 'include',
    body: JSON.stringify({ name_en: 'Photo Supplier', name_ar: 'مورد الصور' }),
  })).json();
  return made.id;
});

await page.goto(`${BASE}/#/legacy-invoices`);
await page.reload();
await page.waitForTimeout(1800);

/*
 * AFTER the reload, not before it. A reload re-opens whatever the shell decides
 * to show on arrival — this database asks the admin to change their password —
 * and a backdrop left on the page swallows every click below it, with a timeout
 * that names the wrong element. Documented lesson; still easy to get wrong.
 */
for (const title of ['Change password', 'تغيير كلمة المرور']) {
  const stray = page.locator('#modal-root .modal').filter({ hasText: title });
  if (await stray.count()) {
    await stray.first().locator('.modal-head button').click();
    await page.waitForTimeout(300);
  }
}

const addButton = page.locator('button', { hasText: /إضافة فاتورة|Add invoice|File an invoice/ }).first();
if (!(await addButton.count())) {
  fail('the "add invoice" button is not on the screen');
} else {
  await addButton.click();
  await page.waitForTimeout(700);
}

const dialog = page.locator('#modal-root .modal').last();
if (!(await dialog.count())) fail('the add-invoice dialog did not open');

/* ── the input must not be camera-only, and must take several files ──────── */
const inputState = await dialog.evaluate((node) => {
  const input = node.querySelector('input[type="file"]');
  if (!input) return null;
  return {
    // `capture` present at all is the bug: on iOS it removes Photo Library.
    capture: input.hasAttribute('capture'),
    accept: input.getAttribute('accept'),
    multiple: input.hasAttribute('multiple'),
  };
});
if (!inputState) {
  fail('there is no file input on the add-invoice dialog');
} else {
  if (inputState.capture) fail('the file input still forces the camera — no gallery on iOS');
  if (!/image/.test(inputState.accept || '')) fail(`the input does not ask for pictures (accept="${inputState.accept}")`);
  if (!inputState.multiple) fail('only one page can be picked at a time');
  note(`input: capture=${inputState.capture} accept="${inputState.accept}" multiple=${inputState.multiple}`);
}

/* ── three "gallery" pictures, chosen in one go ──────────────────────────── */
const chosen = await dialog.evaluate(async (node) => {
  const input = node.querySelector('input[type="file"]');
  const transfer = new DataTransfer();
  for (let i = 0; i < 3; i += 1) {
    const canvas = document.createElement('canvas');
    // Deliberately large, so the phone-side resize has something to do and the
    // "what it now weighs" line is a real measurement.
    canvas.width = 2400; canvas.height = 1800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${i * 100} 60% 55%)`;
    ctx.fillRect(0, 0, 2400, 1800);
    ctx.fillStyle = '#000';
    ctx.font = '400px sans-serif';
    ctx.fillText(String(i + 1), 100, 900);
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    transfer.items.add(new File([blob], `page-${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  input.files = transfer.files;
  /*
   * Counted BEFORE the event. Both other readings give 0: assigning to
   * `input.files` empties the DataTransfer, and the change handler itself does
   * `target.value = ''` to release the file, which clears `input.files` too.
   * A note that says "picked 0 pictures" beside three previews is a check
   * lying about its own inputs.
   */
  const count = input.files.length;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return count;
});
note(`picked ${chosen} pictures in one selection`);

await page.waitForTimeout(3500);

const pageCount = await dialog.locator('.proof-picker img').count();
if (pageCount !== 3) fail(`three pictures were chosen, ${pageCount} preview(s) appeared`);
else note(`${pageCount} pages previewed`);

/* ── fill the form and save ──────────────────────────────────────────────── */
await dialog.evaluate((node, sid) => {
  const inputs = [...node.querySelectorAll('input, select, textarea')];
  const set = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const text = inputs.find((i) => i.tagName === 'INPUT' && i.type === 'text');
  if (text) set(text, 'UI check invoice');
  const select = inputs.find((i) => i.tagName === 'SELECT');
  if (select) set(select, String(sid));
  const number = inputs.find((i) => i.tagName === 'INPUT' && i.type === 'number');
  if (number) set(number, '250');
}, supplierId);
await page.waitForTimeout(400);

const before = await page.evaluate(async () => (
  (await (await fetch('/api/legacy-invoices?page=1&pageSize=1', { credentials: 'include' })).json()).total
));

await dialog.locator('.modal-foot .btn.primary, .modal-foot button').last().click();
await page.waitForTimeout(5000);

const saved = await page.evaluate(async (was) => {
  const list = await (await fetch('/api/legacy-invoices?page=1&pageSize=5', { credentials: 'include' })).json();
  if (list.total <= was) return { created: false };
  const invoice = list.rows[0];
  const full = await (await fetch(`/api/legacy-invoices/${invoice.id}`, { credentials: 'include' })).json();
  // `title`, not `name` — reading a field that does not exist reported
  // "undefined" and would have hidden a form that saved empty.
  return { created: true, title: full.title, total: full.total_amount, photos: (full.attachments || []).length, id: full.id };
}, before);

if (!saved.created) {
  fail('the invoice did not save');
} else if (saved.photos !== 3) {
  fail(`all three pages should be attached, the invoice has ${saved.photos}`);
} else {
  // The typed fields too: an invoice that saved with no name and no amount
  // would still have three photographs on it, and the check would pass while
  // the form was broken.
  if (saved.title !== 'UI check invoice') fail(`the name did not save (got ${JSON.stringify(saved.title)})`);
  if (Number(saved.total) !== 250) fail(`the amount did not save (got ${JSON.stringify(saved.total)})`);
  note(`saved "${saved.title}" · ${saved.total} · ${saved.photos} pages attached`);
}

/* ── and the pages are RESIZED, not the originals ────────────────────────── */
if (saved.created && saved.photos) {
  const bytes = await page.evaluate(async (id) => {
    const full = await (await fetch(`/api/legacy-invoices/${id}`, { credentials: 'include' })).json();
    const first = full.attachments[0];
    const res = await fetch(`/api/attachments/${first.id}/raw`, { credentials: 'include' });
    return (await res.blob()).size;
  }, saved.id);
  // A 2400×1800 JPEG is well over a megabyte; preparePhoto scales to 1600px.
  if (bytes > 900 * 1024) fail(`the original was uploaded unresized (${Math.round(bytes / 1024)} KB)`);
  else note(`first page stored at ${Math.round(bytes / 1024)} KB (resized on the phone)`);
}

if (errs.length) fail(errs.join(' / '));
await page.screenshot({ path: '/tmp/invoice-photos.png' });
await browser.close();

console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ invoice photos: gallery allowed, several pages at once, resized, all attached');
