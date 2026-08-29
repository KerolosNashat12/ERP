/**
 * THE BANNER AND ITS FIGURES, IN A REAL BROWSER.
 *
 * The unit tests prove the numbers are counted and the wording is honest. What
 * only a browser can answer: does the three-line heading actually SHOW three
 * lines, does the middle one lean, are both buttons there and readable over a
 * photograph, and does the band read in Arabic — where the script has no
 * italic and its marks sit above the letters, so a Latin display setting
 * silently slices the tops off words.
 *
 * Run the server on 4000 first, then: node tests/hero-stats-ui-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
const put = (values) => fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify(values),
});

const HEADING_EN = 'Accessories\nThat Define\nYour Essence';
const HEADING_AR = 'إكسسوارات\nتُعرّف\nأسلوبك';

await put({
  'web.banner_heading_en': HEADING_EN,
  'web.banner_heading_ar': HEADING_AR,
  'web.banner_cta_label_en': 'Explore Collection',
  'web.banner_cta_label_ar': 'اتفرّج على التشكيلة',
  'web.banner_cta_link': 'products',
  'web.banner_cta2_label_en': 'Our Story',
  'web.banner_cta2_label_ar': 'قصتنا',
  'web.banner_cta2_link': 'contact',
  'web.stats_enabled': '1',
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

for (const template of ['classic', 'luxe']) {
  await put({ 'web.template': template });
  for (const lang of ['en', 'ar']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // Google Fonts is outside this container's egress allowlist; a blocked
      // webfont is the sandbox, not the page.
      if (m.type() === 'error' && !/TUNNEL|fonts\.g/.test(m.text())) errs.push(`console: ${m.text()}`);
    });
    await page.goto(`${BASE}/shop/`);
    await page.waitForTimeout(400);
    await page.evaluate((l) => localStorage.setItem('mm.shop.lang', l), lang);
    await page.reload();
    await page.waitForTimeout(2200);
    const tag = `${template}/${lang}`;

    /* ── the heading ─────────────────────────────────────────────────────── */
    const lines = await page.locator('.hero-title .hero-line').count();
    if (lines !== 3) fail(`[${tag}] the heading shows ${lines} lines, not 3`);

    const emphasis = await page.locator('.hero-title em.hero-line').evaluate((node) => {
      const cs = getComputedStyle(node);
      return { style: cs.fontStyle, colour: cs.color, index: [...node.parentNode.children].indexOf(node) };
    }).catch(() => null);
    if (!emphasis) fail(`[${tag}] no line is emphasised`);
    else {
      if (emphasis.index !== 1) fail(`[${tag}] the emphasised line is #${emphasis.index + 1}, not the second`);
      if (lang === 'ar' && emphasis.style === 'italic') {
        /*
         * Arabic has no italic, so `font-style: italic` makes the browser
         * SHEAR the glyphs — which breaks the joins that carry the word. The
         * emphasis has to land some other way, and colour is how Arabic does it.
         */
        fail(`[${tag}] the Arabic line is faux-italicised`);
      }
      if (lang === 'en' && emphasis.style !== 'italic') fail(`[${tag}] the middle line does not lean`);
      note(`[${tag}] middle line: font-style ${emphasis.style}, colour ${emphasis.colour}`);
    }

    /*
     * NOT CLIPPED. The title is inside a fixed-height box with `overflow:
     * hidden` and a line clamp, and the whole bug this replaced was a third
     * line silently disappearing. Measured rather than eyeballed: the text
     * must fit the box it is drawn in.
     */
    const clipped = await page.locator('.hero-title').evaluate((node) => (
      node.scrollHeight - node.clientHeight > 2
    ));
    if (clipped) fail(`[${tag}] the heading is cut off inside its box`);

    /* ── the buttons ─────────────────────────────────────────────────────── */
    const buttons = await page.locator('.hero-actions a').allInnerTexts();
    if (buttons.length !== 2) fail(`[${tag}] ${buttons.length} button(s) in the banner, expected 2`);
    else note(`[${tag}] buttons: ${buttons.join(' | ')}`);

    /* ── the figures ─────────────────────────────────────────────────────── */
    const strip = page.locator('.stats-strip');
    if (!(await strip.count())) {
      fail(`[${tag}] the figures band is missing`);
    } else {
      const cells = await page.locator('.stat-cell').count();
      if (cells !== 3) fail(`[${tag}] the band has ${cells} cells, expected 3`);

      const text = (await strip.innerText()).replace(/\n/g, ' · ');
      /*
       * The numbers on screen must be the numbers the API counted. A band that
       * rendered a hard-coded "387+" would look perfect and be a lie, and no
       * amount of looking at it would show that.
       */
      const live = await page.evaluate(async () => (await (await fetch('/api/shop/home')).json()).stats);
      /*
       * Rounding down is allowed; rounding down HARD is not. A shop with 248
       * products showing "200+" is telling the truth and giving away
       * forty-eight products of it, which is the opposite of what a confidence
       * band is for. Within 10% of the real figure, or exact.
       */
      const suffixed = Number((text.match(/(\d[\d,]*)\s*\+/) || [])[1]?.replace(/,/g, '') || 0);
      if (suffixed && suffixed < live.products * 0.9) {
        fail(`[${tag}] the band rounds ${live.products} products down to ${suffixed}`);
      }
      if (!text.includes(String(live.products)) && live.products >= 50) {
        // Above 50 the figure is rounded down and suffixed, so an exact match
        // is not expected — only that it is not larger than the truth.
        const shown = Number((text.match(/(\d[\d,]*)\s*\+/) || [])[1]?.replace(/,/g, '') || 0);
        if (shown > live.products) fail(`[${tag}] the band claims ${shown} products, the shop has ${live.products}`);
      } else if (live.products < 50 && !text.includes(String(live.products))) {
        fail(`[${tag}] the band does not show the real count (${live.products}): ${text}`);
      }

      /* Readable on the paper it is printed on, in both skins. */
      const contrast = await page.locator('.stat-label').first().evaluate((node) => {
        const lum = (c) => {
          const [r, g, b] = (c.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number).map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        let bg = 'rgb(255,255,255)';
        for (let el = node; el; el = el.parentElement) {
          const c = getComputedStyle(el).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break; }
        }
        const a = lum(bg); const b = lum(getComputedStyle(node).color);
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      });
      // The label is small tracked type, so it is held to the 4.5:1 body floor
      // rather than the 3:1 large-text one.
      if (contrast < 4.5) fail(`[${tag}] the band's labels are unreadable (${contrast}:1)`);
      note(`[${tag}] band: ${text} (labels ${contrast}:1)`);
    }

    if (errs.length) fail(`[${tag}] ${errs.join(' / ')}`);
    await page.screenshot({ path: `/tmp/hero-${template}-${lang}.png`, clip: { x: 0, y: 0, width: 1440, height: 820 } });
    await page.close();
  }
}

/* ── and it disappears cleanly when switched off ─────────────────────────── */
await put({ 'web.stats_enabled': '0', 'web.template': 'classic' });
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(`${BASE}/shop/`);
  await page.waitForTimeout(2200);
  if (await page.locator('.stats-strip').count()) {
    fail('the figures band is still on the page after being switched off');
  }
  // …and the page is still a page: nothing else went with it.
  if (!(await page.locator('.hero').count())) fail('turning the band off took the banner with it');
  note('switched off: band gone, banner intact');
  await page.close();
}

await browser.close();
console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ banner: three lines, second emphasised, two buttons, real figures — both skins, both languages');
