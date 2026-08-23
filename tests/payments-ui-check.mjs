/**
 * Walkthrough for round 5: record a supplier payment with a photograph of the
 * receipt, reload, look at it — in both languages — and try to delete a draft
 * and a received purchase order to see what each one says.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   MM_TEST_URL=http://127.0.0.1:4123 node tests/payments-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4123';
const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-payment-shots';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
/**
 * Two console errors are expected and are not this round's:
 *   · the pre-login `/auth/me` probe answers 401 by design;
 *   · saving a purchase order calls `navigate()` and then `location.reload()`,
 *     so the screen it just started loading is aborted a millisecond later.
 *     That is the existing save flow, unchanged here, and it shows up as
 *     "Failed to fetch" on every save — including before this round.
 */
const EXPECTED = [/\b401\b/, /Failed to fetch/];
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() !== 'error') return;
  if (EXPECTED.some((pattern) => pattern.test(text))) return;
  errors.push(`[console] ${text} @ ${page.url()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
};

/** Put the payments card in the middle of the viewport, wherever it has ended up. */
const showPayments = async () => {
  await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.card-head h3')];
    const card = heads[heads.length - 1]?.closest('.card');
    card?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(900);
};

/**
 * A photograph of a handwritten receipt, drawn in the browser and written to
 * disk as a real JPEG so the file picker gets a real file — landscape and
 * oversized, the way a phone hands one over.
 */
async function makeReceiptFile(target) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400; canvas.height = 1600;
    const c = canvas.getContext('2d');
    c.fillStyle = '#efe7d6'; c.fillRect(0, 0, 2400, 1600);
    c.fillStyle = '#fffdf6'; c.fillRect(240, 120, 1920, 1360);
    c.strokeStyle = '#c9bda0'; c.lineWidth = 6; c.strokeRect(240, 120, 1920, 1360);
    c.fillStyle = '#2b2b2b';
    c.font = 'bold 96px Georgia, serif';
    c.fillText('CAIRO SUPPLIES', 340, 300);
    c.font = '58px Georgia, serif';
    c.fillText('Receipt no. 4471', 340, 420);
    c.fillText('Bank transfer — NBE', 340, 520);
    c.font = 'italic 120px Georgia, serif';
    c.fillText('EGP 4,000.00', 340, 760);
    c.font = '54px Georgia, serif';
    c.fillText('Received with thanks', 340, 900);
    c.fillText('for purchase order PO-2026-00002', 340, 990);
    c.strokeStyle = '#2b2b2b'; c.lineWidth = 8;
    c.beginPath(); c.moveTo(340, 1240); c.lineTo(1180, 1180); c.lineTo(700, 1300);
    c.lineTo(1320, 1220); c.stroke();
    c.font = '44px Georgia, serif';
    c.fillText('signature', 340, 1380);
    return canvas.toDataURL('image/jpeg', 0.95);
  });
  fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  receipt fixture', target, `${Math.round(fs.statSync(target).size / 1024)} KB`);
}

async function setLanguage(lang) {
  await page.evaluate((value) => localStorage.setItem('mm.lang', value), lang);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(900);
}

// ------------------------------------------------------------------ sign in
await page.goto(BASE);
await page.waitForSelector('.login-card');
const NEW_PASSWORD = 'shopOwner!2026';

/** Re-runnable: the first run changes the seeded default, later ones use it. */
async function signIn() {
  for (const password of ['admin123', NEW_PASSWORD]) {
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
    try {
      await page.waitForSelector('.shell', { timeout: 8000 });
      return;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  throw new Error('could not sign in with either password');
}
await signIn();
await page.waitForTimeout(1400);

/**
 * The seeded administrator is forced to change the published default password,
 * and the dialog comes back on every reload until it is done — so it is done
 * once, here, rather than dismissed over and over.
 */
if (await page.locator('.modal input[name=currentPassword]').count()) {
  await page.fill('.modal input[name=currentPassword]', 'admin123');
  await page.fill('.modal input[name=newPassword]', NEW_PASSWORD);
  await page.fill('.modal input[name=confirmPassword]', NEW_PASSWORD);
  await page.locator('.modal-foot button.primary, .modal button.primary').last().click();
  await page.waitForTimeout(2500);
  console.log('  default password changed');
}
if (await page.locator('.modal-backdrop').count()) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

const receipt = `${OUT}/receipt-fixture.jpg`;
await makeReceiptFile(receipt);

// ------------------------------------------------- a purchase order to pay
await page.goto(`${BASE}/#/purchases/new`);
await page.waitForTimeout(1200);
await page.selectOption('select[name=supplier_id]', { index: 0 });
await page.fill('.pos-search input', 'tote');
await page.waitForTimeout(1000);
if (!(await page.locator('.pos-result').count())) {
  await page.fill('.pos-search input', 'MM');
  await page.waitForTimeout(1000);
}
await page.locator('.pos-result').first().click();
await page.waitForTimeout(500);
await page.locator('button:has-text("Save")').first().click();
await page.waitForTimeout(2500);
const poHash = await page.evaluate(() => location.hash);
const poId = Number(poHash.match(/purchases\/(\d+)/)?.[1]);
if (!poId) errors.push(`[flow] the new purchase order did not open: ${poHash}`);
console.log('  purchase order', poId);

// ----------------------------------------- record a payment with the receipt
await page.locator('button:has-text("Register payment")').first().click();
await page.waitForSelector('.modal');
await page.fill('.modal input[name=amount]', '400');
await page.fill('.modal input[name=reference]', 'TRF-4471');
await page.fill('.modal input[name=note]', 'Deposit paid at the branch');
await page.setInputFiles('.modal input[type=file]', receipt);
// The browser rotates, scales and re-encodes before anything is sent.
await page.waitForTimeout(2500);
await shot('01-payment-dialog-en');
await page.locator('.modal-foot button.primary').click();
await page.waitForTimeout(3500);

// ------------------------------------------- reload and look at it: English
await page.goto(`${BASE}/#/purchases/${poId}`);
await page.reload();
await page.waitForSelector('.shell');
await page.waitForTimeout(2200);
await showPayments();
if (!(await page.locator('.proof-thumb').count())) errors.push('[proof] no thumbnail rendered after reload');
await shot('02-payments-list-en');

await page.locator('.proof-thumb').first().click();
await page.waitForSelector('.proof-full');
await page.waitForTimeout(1200);
const shown = await page.locator('.proof-full').evaluate((img) => ({
  w: img.naturalWidth, h: img.naturalHeight, complete: img.complete,
}));
console.log('  opened photograph', JSON.stringify(shown));
if (!shown.w) errors.push('[proof] the full photograph did not load');
await shot('03-proof-opened-en');
await page.locator('.modal-head button').click();
await page.waitForTimeout(500);

// ------------------------------------------------------------ the list screen
/**
 * A second, untouched draft, so the list shows both answers side by side: a
 * draft that CAN be deleted, and the one above that cannot because money has
 * been recorded against it.
 */
async function newDraft() {
  await page.goto(`${BASE}/#/purchases/new`);
  await page.waitForTimeout(1400);
  await page.selectOption('select[name=supplier_id]', { index: 0 });
  await page.fill('.pos-search input', 'tote');
  await page.waitForTimeout(1000);
  if (!(await page.locator('.pos-result').count())) {
    await page.fill('.pos-search input', 'MM');
    await page.waitForTimeout(1000);
  }
  await page.locator('.pos-result').first().click();
  await page.waitForTimeout(400);
  await page.locator('button:has-text("Save")').first().click();
  await page.waitForTimeout(3000);
}
await newDraft();

await page.goto(`${BASE}/#/purchases`);
await page.waitForTimeout(1800);
await shot('04-purchases-list-en');

/**
 * Pick rows by what the button says about itself rather than by the status
 * text, which differs per language: a Delete the list is willing to perform
 * carries no `data-refused`, one that will only explain itself does.
 *
 * `dispatchEvent('click')` rather than `click()`: the refusal button is greyed,
 * and Playwright's actionability check would rather wait for it to look lively.
 */
const refusedDeletes = () => page.locator('table.data tbody tr button[data-refused]');

// A draft with nothing against it: allowed, so it asks for confirmation.
await page.locator('table.data tbody tr').first()
  .locator('button:not([data-refused])').last().dispatchEvent('click');
await page.waitForTimeout(1000);
await shot('05-delete-draft-allowed-en');
await page.locator('.modal-foot button').first().click();
await page.waitForTimeout(800);

// The draft that took a deposit: refused, and it says which way out there is.
await refusedDeletes().first().dispatchEvent('click');
await page.waitForTimeout(1000);
await shot('06-delete-draft-with-payment-refused-en');
await page.waitForTimeout(4200);

// A received order: refused for a different reason, and it says that one too.
await refusedDeletes().last().dispatchEvent('click');
await page.waitForTimeout(1000);
await shot('07-delete-received-refused-en');
await page.waitForTimeout(4200);

// --------------------------------------------------------------- Arabic / RTL
await setLanguage('ar');
const dir = await page.evaluate(() => document.documentElement.dir);
if (dir !== 'rtl') errors.push(`[rtl] expected dir=rtl, got ${dir}`);

await page.goto(`${BASE}/#/purchases/${poId}`);
await page.waitForTimeout(2200);
await showPayments();
await shot('08-payments-list-ar');

await page.locator('.proof-thumb').first().click();
await page.waitForSelector('.proof-full');
await page.waitForTimeout(1200);
await shot('09-proof-opened-ar');
await page.locator('.modal-head button').click();
await page.waitForTimeout(500);

await page.goto(`${BASE}/#/purchases`);
await page.waitForTimeout(1600);
await shot('10-purchases-list-ar');

await page.locator('table.data tbody tr').first()
  .locator('button:not([data-refused])').last().dispatchEvent('click');
await page.waitForTimeout(1000);
await shot('11-delete-draft-allowed-ar');
await page.locator('.modal-foot button').first().click();
await page.waitForTimeout(800);

await refusedDeletes().last().dispatchEvent('click');
await page.waitForTimeout(1000);
await shot('12-delete-received-refused-ar');
await page.waitForTimeout(4200);

// Reversing a payment, in Arabic — the row stays, struck through.
await page.goto(`${BASE}/#/purchases/${poId}`);
await page.waitForTimeout(2000);
await showPayments();
await shot('13-payment-actions-ar');

// And the answer to "I typed the wrong amount": the payment is reversed, the
// row stays struck through with the reason on it, and the total gives it back.
await page.locator('.payment-reversed, table.data tbody tr button:has-text("↺")').last().click();
await page.waitForSelector('.modal');
await page.fill('.modal input', 'المبلغ اتكتب غلط');
await page.waitForTimeout(500);
await shot('14-reverse-payment-ar');
await page.locator('.modal-foot button.danger').click();
await page.waitForTimeout(3000);
await showPayments();
await shot('15-payment-reversed-ar');
if (!(await page.locator('.payment-reversed').count())) {
  errors.push('[reversal] the reversed payment row did not survive');
}

await page.evaluate(() => localStorage.setItem('mm.lang', 'en'));
await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const line of errors) console.error('  ' + line);
  process.exit(1);
}
console.log(`\nAll good — screenshots in ${OUT}`);
