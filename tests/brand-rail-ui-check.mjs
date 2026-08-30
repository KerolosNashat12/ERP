/**
 * EVERY BRAND THE SAME SHAPE AND THE SAME SIZE.
 *
 * The bug, reported with a screenshot: «ماركاتنا» came back as two overlapping
 * rows with one black rectangle hanging out of it. A brand WITH a logo got a
 * 150×100 frame; a brand without one collapsed to the size of the little drawn
 * ring, because the night skin set its face to `inline-size: auto`. Two face
 * sizes make two card heights, and a flex row of mismatched cards wraps.
 *
 * ── Why this is a browser check and not a CSS review ────────────────────────
 * Every failure in this area was a COMPUTED size, not a written one. The rule
 * that broke the row said `auto`, which reads as harmless. The next attempt
 * used `100%` and `max-block-size: 100%`, which read as correct and resolved to
 * nothing at all, because the face is a grid whose row is content-sized and a
 * percentage against an indefinite height is ignored — so the drawn mark
 * rendered at 132×132 inside an 88px frame and was sliced off. Two plausible
 * rules, both wrong, and neither visible by reading. Only measuring found them.
 *
 * The fixture is the point too: three logos of deliberately hostile aspect
 * ratios — a 900×200 wordmark, a 200×900 monogram and a 500×500 emblem —
 * alongside brands with no logo at all. A rail that survives those survives a
 * real shop's uploads.
 *
 * Run the server on 4000 first, then: node tests/brand-rail-ui-check.mjs
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
const setTemplate = (value) => fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ 'web.template': value }),
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/* ── give some brands logos of hostile shapes, and leave others bare ─────── */
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(500);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin123');
  await page.click('form button[type=submit]');
  await page.waitForTimeout(2200);
  const made = await page.evaluate(async () => {
    const draw = (w, h, bg, text) => new Promise((res) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = bg; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fff';
      x.font = `bold ${Math.round(Math.min(w, h) * 0.3)}px serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(text, w / 2, h / 2);
      res(c.toDataURL('image/png'));
    });
    const brands = (await (await fetch('/api/brands?page=1&pageSize=6', { credentials: 'include' })).json()).rows;
    if (brands.length < 4) return { error: 'fewer than four brands — the rail cannot be judged' };
    const specs = [
      [brands[0].id, 900, 200, '#111', 'WIDE'],   // a wordmark
      [brands[1].id, 200, 900, '#222', 'TALL'],   // a monogram
      [brands[2].id, 500, 500, '#333', 'SQ'],     // an emblem
    ];
    const out = [];
    for (const [id, w, h, bg, txt] of specs) {
      // eslint-disable-next-line no-await-in-loop
      const dataUrl = await draw(w, h, bg, txt);
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`/api/brands/${id}/logo`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      out.push(`${w}x${h}:${r.status}`);
    }
    return { out };
  });
  if (made.error) fail(made.error);
  else note(`logos uploaded — ${made.out.join(' ')}`);
  await page.close();
}

for (const template of ['classic', 'luxe']) {
  await setTemplate(template);
  for (const [lang, width] of [['ar', 1440], ['en', 1440], ['ar', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/shop/`);
    await page.waitForTimeout(400);
    await page.evaluate((l) => localStorage.setItem('mm.shop.lang', l), lang);
    await page.reload();
    await page.waitForTimeout(2400);
    const tag = `${template}/${lang}@${width}`;

    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.rail-track > .brand-card')];
      if (!cards.length) return null;
      const round = (n) => Math.round(n);
      const faces = cards.map((c) => c.querySelector('.brand-card-face'));
      const marks = faces.map((f) => f?.querySelector('img')).filter(Boolean);
      return {
        cards: cards.length,
        withLogo: faces.filter((f) => f?.classList.contains('has-logo')).length,
        faceSizes: [...new Set(faces.filter(Boolean).map((f) => {
          const r = f.getBoundingClientRect();
          return `${round(r.width)}x${round(r.height)}`;
        }))],
        cardSizes: [...new Set(cards.map((c) => {
          const r = c.getBoundingClientRect();
          return `${round(r.width)}x${round(r.height)}`;
        }))],
        rows: [...new Set(cards.map((c) => round(c.getBoundingClientRect().top)))].length,
        // A mark taller or wider than the frame it sits in is being clipped by
        // `overflow: hidden` — which is exactly how the drawn ring lost its top.
        overflowing: marks.filter((img) => {
          const f = img.closest('.brand-card-face').getBoundingClientRect();
          const r = img.getBoundingClientRect();
          return r.width > f.width + 1 || r.height > f.height + 1;
        }).length,
      };
    });

    if (!m) { fail(`[${tag}] there is no brand rail on the page`); await page.close(); continue; }
    if (m.cards < 4) fail(`[${tag}] only ${m.cards} brands — not enough to judge a row`);
    if (!m.withLogo) fail(`[${tag}] no brand has a logo, so the mismatch cannot show`);

    if (m.faceSizes.length !== 1) {
      fail(`[${tag}] brand faces come in ${m.faceSizes.length} sizes: ${m.faceSizes.join(', ')}`);
    }
    if (m.cardSizes.length !== 1) {
      fail(`[${tag}] brand cards come in ${m.cardSizes.length} sizes: ${m.cardSizes.join(', ')}`);
    }
    if (m.rows !== 1) fail(`[${tag}] the rail has wrapped into ${m.rows} rows`);
    if (m.overflowing) fail(`[${tag}] ${m.overflowing} mark(s) are larger than their frame and being clipped`);

    note(`[${tag}] ${m.cards} cards (${m.withLogo} with a logo) · face ${m.faceSizes[0]} · card ${m.cardSizes[0]} · ${m.rows} row`);
    if (errs.length) fail(`[${tag}] ${errs.join(' / ')}`);
    await page.close();
  }
}

await setTemplate('classic');
await browser.close();
console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ brand rail: one frame, one card size, one row — every logo shape, both skins, both languages');
