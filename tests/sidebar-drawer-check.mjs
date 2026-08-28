/**
 * The phone's side drawer: opened by one button, closed by anything.
 *
 * The owner opened the menu on his phone, decided against it, and had no way
 * out - the till was underneath, visible and untappable, and the only way back
 * was finding the ☰ again behind the panel. A drawer on a phone is modal:
 * everything outside it dismisses it.
 *
 * The other half of this check is the failure mode, because it has bitten this
 * project once already on the storefront: a dimming layer that outlives its
 * drawer leaves a dark sheet over a page nobody can touch. So every assertion
 * about "it closed" is paired with one about the scrim being gone AND not
 * catching clicks.
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/sidebar-drawer-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch({
  executablePath: process.env.MM_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => fail(`[pageerror] ${e.message}`));

await page.goto(`${BASE}/app.html`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[name="username"], #username', 'admin');
await page.fill('input[type="password"]', 'admin123');
await page.press('input[type="password"]', 'Enter');
await page.waitForSelector('h2');
await page.waitForTimeout(1500);
await page.evaluate(() => { document.querySelectorAll('#modal-root > *').forEach((n) => n.remove()); });

const state = () => page.evaluate(() => {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.querySelector('.sidebar-scrim');
  const scrimStyle = scrim ? getComputedStyle(scrim) : null;
  return {
    open: sidebar.classList.contains('open'),
    bodyFlag: document.body.classList.contains('sidebar-open'),
    // Where the panel actually IS, not what it says about itself.
    left: Math.round(sidebar.getBoundingClientRect().left),
    scrimVisible: scrimStyle ? Number(scrimStyle.opacity) > 0.05 : false,
    scrimCatchesClicks: scrimStyle ? scrimStyle.pointerEvents !== 'none' : false,
  };
});

const openDrawer = async () => {
  await page.click('.menu-toggle');
  await page.waitForTimeout(400);
};

// --- it opens
await openDrawer();
let now = await state();
if (!now.open) fail('the ☰ did not open the drawer');
if (now.left < 0) fail(`the drawer is still off-screen at ${now.left}px`);
if (!now.scrimVisible) fail('an open drawer must dim the page behind it');
if (!now.scrimCatchesClicks) fail('the dimmed area must be tappable, or it cannot close anything');

// --- a tap on the page closes it
await page.mouse.click(340, 700);
await page.waitForTimeout(400);
now = await state();
if (now.open) fail('tapping the page did not close the drawer');
if (now.bodyFlag) fail('the body kept the open flag — the scrim will be stuck');
if (now.scrimVisible) fail('the dimming stayed behind after the drawer closed');
if (now.scrimCatchesClicks) fail('an invisible scrim is still swallowing taps — the page is dead');

// --- and the page underneath really is usable again
const clickable = await page.evaluate(() => {
  const target = document.elementFromPoint(200, 700);
  return target ? `${target.tagName}.${target.className}`.slice(0, 60) : null;
});
if (/sidebar-scrim/.test(clickable || '')) fail(`the scrim is on top of the page: ${clickable}`);

// --- Escape closes it too
await openDrawer();
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
now = await state();
if (now.open || now.scrimVisible) fail('Escape did not close the drawer');

// --- tapping the drawer itself does NOT close it
await openDrawer();
await page.click('#sidebar .nav-group', { timeout: 5000 }).catch(() => page.click('#sidebar'));
await page.waitForTimeout(300);
now = await state();
if (!now.open) fail('tapping inside the drawer closed it — a menu you cannot read is not a menu');

// --- following a link closes it
await page.evaluate(() => { document.querySelector('#sidebar .nav a')?.click(); });
await page.waitForTimeout(600);
now = await state();
if (now.open || now.scrimVisible || now.scrimCatchesClicks) fail('following a link left the drawer or its scrim behind');

// --- a wide screen must never keep the state
await openDrawer();
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(500);
now = await state();
if (now.bodyFlag) fail('rotating to a wide layout kept the drawer flag, and with it an invisible scrim');
const wideClickable = await page.evaluate(() => {
  const target = document.elementFromPoint(900, 500);
  return target ? `${target.tagName}.${target.className}`.slice(0, 60) : null;
});
if (/sidebar-scrim/.test(wideClickable || '')) fail(`on a desktop the scrim is over the page: ${wideClickable}`);

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('side drawer: all checks passed');
