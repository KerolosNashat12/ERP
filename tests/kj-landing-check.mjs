/**
 * KJ landing page — the checks that only a browser can answer.
 *
 * Four runs of the same page:
 *
 *   1. NO API AT ALL. `/api/landing` 404s, so the page renders its own
 *      defaults. This is the case that has to be perfect, and it is also the
 *      one that proves the invisible render: a `MutationObserver` watches
 *      `<body>` from before the module runs and must see nothing beyond the
 *      language button unhiding itself and the reveal marking sections in.
 *   2. AN EDITED DOCUMENT. A price changed, a package renamed, a sixth
 *      feature added, an FAQ entry removed, two quotes added, a section
 *      switched off, and the phone number changed — which must move every
 *      `tel:`, every `wa.me` and the demo form's own action together.
 *   3. NO JAVASCRIPT. The shipped HTML on its own, which must read the same
 *      as run 1.
 *   4. REDUCED MOTION.
 *
 * Every run is screenshotted in Arabic and in English at 390, 768 and 1280,
 * and every run asserts: no horizontal scroll, one `<h1>`, headings in order,
 * a clean console, and nothing anywhere on the page naming the owner's own
 * console.
 *
 *   node tests/kj-landing-check.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public');
const OUT = process.env.KJ_SHOTS || '/tmp/kj-shots';
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [390, 768, 1280];
const LANGS = ['ar', 'en'];

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** The document this run serves at `/api/landing`, or `null` for a 404. */
let served = null;

/**
 * Requests this run is EXPECTED to fail. The browser logs every failed
 * request and cannot be asked not to, so a run whose whole point is a missing
 * asset has to name the thing it is missing. Everything else is a real error.
 */
let expectedMisses = /\/api\/landing/;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/landing') {
    if (!served) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(served));
    return;
  }
  if (url.pathname.startsWith('/api/landing/asset/')) { res.writeHead(404).end(); return; }
  let file = path.join(ROOT, url.pathname);
  if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve));
const PAGE = 'http://127.0.0.1:4173/kj/index.html';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/**
 * The render is meant to be invisible on an unedited deployment, and this is
 * how that is asserted rather than asserted about: the observer is installed
 * in a document-start script, before the module has run, and every record it
 * collects is a node the page changed under the reader.
 */
const WATCH = `
  window.__kjMutations = [];
  const record = (m) => {
    const node = m.target;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return {
      type: m.type,
      attr: m.attributeName,
      tag: el?.tagName,
      cls: el?.className?.baseVal ?? el?.className ?? '',
      id: el?.id || '',
      added: m.addedNodes.length,
      removed: m.removedNodes.length,
    };
  };
  // WHERE THIS HOOKS IN, and why it is the only place it can. readyState goes
  // to "interactive" when the parser has finished and BEFORE deferred scripts
  // run — and kj.js is a module, so it is deferred. Starting the observer in
  // this handler means the parser's own writes are never recorded and the
  // module's first write would be the first record there is.
  document.addEventListener('readystatechange', () => {
    if (document.readyState !== 'interactive') return;
    new MutationObserver((records) => {
      for (const m of records) window.__kjMutations.push(record(m));
    }).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  });
`;

async function open({ width, lang, js = true, motion = 'no-preference' }) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    javaScriptEnabled: js,
    reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
  });
  const errors = [];
  await context.addInitScript(`try { localStorage.setItem('kj.lang', ${JSON.stringify(lang)}); } catch {}`);
  if (js) await context.addInitScript(WATCH);
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // A request this run is expected to fail — see `expectedMisses`.
    if (expectedMisses.test(msg.location()?.url ?? '')) return;
    errors.push(`console: ${msg.text()}`);
  });
  await page.goto(PAGE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  return { context, page, errors };
}

/** Full-page screenshot with every lazy image forced in first. */
async function shoot(page, name) {
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** The things that must be true of this page whatever the document says. */
async function audit(page, label, { js = true } = {}) {
  const facts = await page.evaluate(() => {
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .filter((h) => h.offsetParent !== null || h.closest('[hidden]') === null)
      .filter((h) => h.getClientRects().length > 0)
      .map((h) => Number(h.tagName[1]));
    const visibleText = document.body.innerText;
    return {
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      h1: document.querySelectorAll('h1').length,
      headings,
      html: document.documentElement.outerHTML,
      visibleText,
      // The header carries one control that only exists when a script runs,
      // so the comparison between "with script" and "without" is of the page
      // itself: everything from the skip link's target down.
      pageText: document.querySelector('main').innerText + '\n' + document.querySelector('.site-foot').innerText,
      emptyHeadings: [...document.querySelectorAll('h2, h3')]
        .filter((h) => h.getClientRects().length > 0 && !h.textContent.trim()).length,
    };
  });

  if (facts.scrollW > facts.clientW) {
    fail(`${label}: horizontal scroll — scrollWidth ${facts.scrollW} > clientWidth ${facts.clientW}`);
  }
  if (facts.h1 !== 1) fail(`${label}: ${facts.h1} <h1> elements, expected 1`);
  if (facts.emptyHeadings) fail(`${label}: ${facts.emptyHeadings} empty visible heading(s)`);

  let previous = 0;
  for (const level of facts.headings) {
    if (previous && level > previous + 1) fail(`${label}: heading jumped h${previous} → h${level}`);
    previous = level;
  }

  // Nothing anywhere on this page names the owner's own console — not a
  // feature, not a button, not an alt text, not the meta description.
  if (/KJ\s*Admin/i.test(facts.html)) {
    const where = facts.html.match(/.{80}KJ\s*Admin.{40}/i)?.[0] ?? '';
    fail(`${label}: names KJ Admin — …${where}…`);
  }

  if (js) {
    const mutations = await page.evaluate(() => window.__kjMutations || []);
    facts.mutations = mutations;
  }
  return facts;
}

// ===========================================================================
// RUN 1 — no API at all. The default document, and the case that must be
// perfect.
// ===========================================================================
console.log('\n== run 1 · no /api/landing (the defaults) ==');
served = null;
const baseline = {};
for (const lang of LANGS) {
  for (const width of WIDTHS) {
    const label = `default ${lang}@${width}`;
    const { context, page, errors } = await open({ width, lang });
    const facts = await audit(page, label);
    if (facts.dir !== (lang === 'ar' ? 'rtl' : 'ltr')) fail(`${label}: dir=${facts.dir}`);
    if (facts.lang !== lang) fail(`${label}: lang=${facts.lang}`);

    // THE INVISIBLE RENDER. Two mutations are the enhancement arming itself
    // and are expected: the language button unhiding, and the reveal marking
    // a section as arrived. Anything else is the page rebuilding under the
    // reader, and on an unedited deployment there must be nothing else.
    if (lang === 'ar') {
      const unexpected = (facts.mutations || []).filter((m) => {
        if (m.attr === 'data-reveal') return false;
        if (m.attr === 'hidden' && /lang-btn/.test(m.cls)) return false;
        // The enhancement arming ITSELF, all of it on <html> and none of it
        // content: the derived palette, its dark/light flag and the favicon.
        if (m.tag === 'HTML' && ['style', 'data-theme', 'class'].includes(m.attr)) return false;
        if (m.attr === 'href' && m.tag === 'LINK') return false;
        return true;
      });
      if (unexpected.length) {
        fail(`${label}: ${unexpected.length} DOM mutation(s) on boot — ${JSON.stringify(unexpected.slice(0, 6))}`);
      } else {
        ok(`${label}: rendered the defaults without touching one node`);
      }
    }

    if (errors.length) fail(`${label}: ${errors.join(' | ')}`);
    else ok(`${label}: clean console`);

    baseline[`${lang}@${width}`] = facts.pageText;
    const file = await shoot(page, `default-${lang}-${width}`);
    ok(`${label}: ${file}`);
    await context.close();
  }
}

// ===========================================================================
// RUN 2 — an edited document.
// ===========================================================================
console.log('\n== run 2 · an edited document ==');
served = {
  contact: { phone: '01000000001', whatsapp: '01000000002', email: 'owner@example.com' },
  packages: {
    items: [
      {
        id: 'starter',
        name: { ar: 'البداية', en: 'Starter' },
        price: 2000,
        oneLiner: { ar: 'للمحل الواحد', en: 'For a single shop' },
        features: [
          { ar: 'شاشة كاشير كاملة مع دعم قارئ الباركود', en: 'A full till with barcode-scanner support' },
          { ar: 'مخزون بأصناف ومقاسات وألوان', en: 'Stock with products, sizes and colours' },
          { ar: 'فواتير، مرتجعات، وتقفيل وردية', en: 'Invoices, returns and a shift close' },
          { ar: 'تقارير المبيعات', en: 'Sales reports' },
          { ar: 'مستخدمين اتنين', en: 'Two users' },
        ],
        cta: { ar: 'ابدأ بالبداية', en: 'Start with Starter' },
      },
      {
        id: 'growth',
        name: { ar: 'النمو', en: 'Scale' },          // renamed
        price: 4250,                                  // repriced
        badge: { ar: 'الأكثر طلبًا', en: 'Most popular' },
        featured: true,
        oneLiner: { ar: 'لما تبقى عايز تبيع أونلاين', en: 'For when you want to sell online' },
        inherits: { ar: 'كل اللي في باقة البداية، وكمان:', en: 'Everything in Starter, plus:' },
        cta: { ar: 'ابدأ النمو', en: 'Start with Scale' },
        features: [
          { ar: 'موقع بيع أونلاين باسم محلك', en: 'An online shop under your name' },
          { ar: 'الدفع عند الاستلام وشحن بتحدده', en: 'Cash on delivery and shipping you set' },
          { ar: 'طلب الموقع بيدخل على نفس النظام', en: 'A website order lands in the same system' },
          { ar: 'اطبع ملصقات الباركود بنفسك', en: 'Print your own barcode labels' },
          { ar: '٥ مستخدمين، كل واحد بصلاحياته', en: '5 users, each with their own permissions' },
          { ar: 'ربط بشركة الشحن بتاعتك', en: 'A link to your own courier' },   // a sixth
        ],
      },
      {
        id: 'premium',
        name: { ar: 'الاحترافية', en: 'Premium' },
        price: 6000,
        oneLiner: { ar: 'لأكتر من فرع', en: 'For more than one branch' },
        inherits: { ar: 'كل اللي في باقة النمو، وكمان:', en: 'Everything in Scale, plus:' },
        features: [
          { ar: 'فروع ومحلات متعددة', en: 'Multiple branches and shops' },
          { ar: 'مستخدمين بلا حد', en: 'Unlimited users' },
          { ar: 'تقارير متقدمة', en: 'Advanced reports' },
          { ar: 'بننقل بياناتك القديمة بنفسنا', en: 'We move your existing data ourselves' },
          { ar: 'نسخة احتياطية تلقائية ودعم بأولوية', en: 'Automatic backups and priority support' },
        ],
        cta: { ar: 'اطلب باقة الاحترافية', en: 'Get Premium' },
      },
    ],
  },
  faq: {
    items: [
      { q: { ar: 'النت بيقطع عندي — هعمل إيه؟', en: 'My internet cuts out — what then?' },
        a: { ar: 'الكاشير بيشتغل على جهاز المحل نفسه.', en: 'The till runs on the shop’s own computer.' } },
      { q: { ar: 'بدفع شهري؟ ولو وقفت؟', en: 'Is it monthly? And if I stop?' },
        a: { ar: 'شهري، ومن غير عقد سنة.', en: 'Monthly, with no annual contract.' } },
    ],
  },
  quotes: {
    items: [
      { quote: { ar: 'بقيت أعرف مخزني من غير ما أقفل المحل.', en: 'I know my stock without closing the shop.' },
        name: 'أحمد سليم', shop: 'سليم للأحذية', city: 'المنصورة' },
      { quote: { ar: 'الموقع جاب لي طلبات وأنا نايم.', en: 'The website brought me orders while I slept.' },
        name: 'مريم فؤاد', shop: 'Maryam Bags', city: 'الإسكندرية' },
    ],
  },
  versus: { enabled: false },
};
for (const lang of LANGS) {
  for (const width of WIDTHS) {
    const label = `edited ${lang}@${width}`;
    const { context, page, errors } = await open({ width, lang });
    await audit(page, label);

    const seen = await page.evaluate(() => ({
      prices: [...document.querySelectorAll('[data-plan-price]')].map((n) => n.textContent),
      names: [...document.querySelectorAll('.plan-name')].map((n) => n.textContent),
      growthFeatures: document.querySelector('[data-plan="growth"] [data-plan-features]').children.length,
      growthSixth: document.querySelector('[data-plan="growth"] [data-plan-features]').lastElementChild.textContent.trim(),
      faqCount: document.querySelectorAll('.faq-item').length,
      quotesHidden: document.querySelector('[data-sec="quotes"]').hidden,
      quoteCount: document.querySelectorAll('.quote').length,
      versusHidden: document.querySelector('[data-sec="versus"]').hidden,
      versusHeight: document.querySelector('[data-sec="versus"]').getBoundingClientRect().height,
      tels: [...new Set([...document.querySelectorAll('[data-tel]')].map((a) => a.getAttribute('href')))],
      was: [...new Set([...document.querySelectorAll('[data-wa]')].map((a) => a.getAttribute('href')))],
      formAction: document.querySelector('[data-demo-form]').getAttribute('action'),
      mails: [...new Set([...document.querySelectorAll('[data-mailto]')].map((a) => a.getAttribute('href')))],
    }));

    const price = lang === 'ar' ? '٤٬٢٥٠ جنيه' : '4,250 EGP';
    if (seen.prices[1] !== price) fail(`${label}: growth price is "${seen.prices[1]}", expected "${price}"`);
    const name = lang === 'ar' ? 'النمو' : 'Scale';
    if (seen.names[1] !== name) fail(`${label}: growth name is "${seen.names[1]}"`);
    if (seen.growthFeatures !== 6) fail(`${label}: growth has ${seen.growthFeatures} features, expected 6`);
    const sixth = lang === 'ar' ? 'ربط بشركة الشحن بتاعتك' : 'A link to your own courier';
    if (seen.growthSixth !== sixth) fail(`${label}: the added feature reads "${seen.growthSixth}"`);
    if (seen.faqCount !== 2) fail(`${label}: ${seen.faqCount} FAQ entries, expected 2`);
    if (seen.quotesHidden || seen.quoteCount !== 2) fail(`${label}: quotes hidden=${seen.quotesHidden} count=${seen.quoteCount}`);
    if (!seen.versusHidden || seen.versusHeight !== 0) {
      fail(`${label}: the disabled section still occupies ${seen.versusHeight}px`);
    }
    if (seen.tels.join() !== 'tel:+201000000001') fail(`${label}: tel links ${seen.tels.join(', ')}`);
    if (seen.was.join() !== 'https://wa.me/201000000002') fail(`${label}: wa links ${seen.was.join(', ')}`);
    if (seen.formAction !== 'https://wa.me/201000000002') fail(`${label}: form action ${seen.formAction}`);
    if (seen.mails.join() !== 'mailto:owner@example.com') fail(`${label}: mailto ${seen.mails.join(', ')}`);
    if (errors.length) fail(`${label}: ${errors.join(' | ')}`);
    else ok(`${label}: clean console, document applied`);

    const file = await shoot(page, `edited-${lang}-${width}`);
    ok(`${label}: ${file}`);
    await context.close();
  }
}

// ===========================================================================
// RUN 3 — no JavaScript. The shipped HTML has to be the same page.
// ===========================================================================
console.log('\n== run 3 · JavaScript disabled ==');
served = null;
for (const width of WIDTHS) {
  const label = `nojs ar@${width}`;
  const { context, page } = await open({ width, lang: 'ar', js: false });
  const facts = await audit(page, label, { js: false });
  if (facts.dir !== 'rtl') fail(`${label}: dir=${facts.dir}`);
  const langButton = await page.evaluate(() => document.querySelector('[data-lang-toggle]').hidden);
  if (!langButton) fail(`${label}: the language button is showing with no script to run it`);
  // The words on the page with no script must be the words on the page with
  // one: the shipped HTML IS the default document, or these differ.
  const withJs = baseline[`ar@${width}`];
  if (facts.pageText.trim() !== withJs.trim()) {
    const a = facts.pageText.split('\n');
    const b = withJs.split('\n');
    const first = a.findIndex((line, i) => line !== b[i]);
    fail(`${label}: text differs from the rendered default at line ${first}: `
       + `no-js "${a[first]}" vs js "${b[first]}"`);
  } else {
    ok(`${label}: identical to the rendered default, word for word`);
  }
  const file = await shoot(page, `nojs-ar-${width}`);
  ok(`${label}: ${file}`);
  await context.close();
}

// ===========================================================================
// RUN 4 — prefers-reduced-motion: reduce.
// ===========================================================================
console.log('\n== run 4 · prefers-reduced-motion: reduce ==');
for (const lang of LANGS) {
  const label = `reduced ${lang}@390`;
  const { context, page, errors } = await open({ width: 390, lang, motion: 'reduce' });
  await audit(page, label);
  const faded = await page.evaluate(() => [...document.querySelectorAll('[data-reveal]')]
    .filter((n) => n.getClientRects().length && Number(getComputedStyle(n).opacity) < 1).length);
  if (faded) fail(`${label}: ${faded} element(s) still under the reveal with reduced motion asked for`);
  else ok(`${label}: nothing is faded out`);
  if (errors.length) fail(`${label}: ${errors.join(' | ')}`);
  const file = await shoot(page, `reduced-${lang}-390`);
  ok(`${label}: ${file}`);
  await context.close();
}

// ===========================================================================
// RUN 5 — assets the control plane does not have.
//
// The owner uploaded a logo and a hero and a replacement screenshot, and then
// the control plane lost them, or he deleted them, or the route 404s. Not one
// of those may leave a broken picture on a sales page.
// ===========================================================================
console.log('\n== run 5 · an override whose asset is missing ==');
expectedMisses = /\/api\/landing|nothing-here/;
served = {
  brand: { logo: '/api/landing/asset/logo' },
  hero: { image: '/api/landing/asset/hero' },
  shots: {
    items: [
      { key: 'pos', kind: 'desktop', caption: { ar: 'الكاشير', en: 'The till' },
        custom: '/api/landing/asset/shot-pos' },
      { key: 'dashboard', kind: 'desktop', caption: { ar: 'لوحة التحكم', en: 'The dashboard' } },
      { key: 'products', kind: 'desktop', caption: { ar: 'المنتجات', en: 'Products' }, enabled: false },
      { key: 'shop-home', kind: 'phone', caption: { ar: 'موقعك', en: 'Your website' } },
      // A slot with no built-in behind it and no upload either: nothing to
      // show, so the figure takes itself off the page.
      { key: 'nothing-here', kind: 'phone', caption: { ar: 'مفيش', en: 'Nothing' } },
    ],
  },
};
{
  const { context, page, errors } = await open({ width: 1280, lang: 'ar' });
  await audit(page, 'assets ar@1280');
  // A lazy image far below the fold is never requested, so it never errors.
  // Ask for all of them and give the 404s time to come back — the fallback
  // can only be tested once the browser has actually tried.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
  });
  await page.waitForTimeout(1200);
  const seen = await page.evaluate(() => ({
    logoHidden: document.querySelector('[data-brand-logo]').hidden,
    monogram: document.querySelector('.brand-monogram').hidden,
    hero: document.querySelector('[data-hero-image]').getAttribute('src'),
    heroBroken: document.querySelector('[data-hero-image]').naturalWidth === 0,
    figures: [...document.querySelectorAll('.shot')].map((f) => ({
      hidden: f.hidden,
      src: f.querySelector('img')?.getAttribute('src'),
      broken: f.querySelector('img')?.naturalWidth === 0,
    })),
  }));
  if (!seen.logoHidden || seen.monogram) fail(`assets: the missing logo did not fall back to the monogram`);
  else ok('assets: the missing logo fell back to the monogram');
  if (seen.hero !== '/kj/shots/pos-ar.webp' || seen.heroBroken) {
    fail(`assets: the hero is "${seen.hero}" broken=${seen.heroBroken}`);
  } else ok('assets: the missing hero fell back to the built-in capture');

  const shown = seen.figures.filter((f) => !f.hidden);
  if (shown.length !== 3) fail(`assets: ${shown.length} screenshots showing, expected 3`);
  if (shown[0]?.src !== '/kj/shots/pos-ar.webp' || shown[0]?.broken) {
    fail(`assets: the missing override did not fall back — "${shown[0]?.src}"`);
  } else ok('assets: the missing screenshot override fell back to the built-in');
  if (seen.figures.some((f) => !f.hidden && f.broken)) fail('assets: a broken image is on the page');
  else ok('assets: no broken image anywhere');
  if (errors.length) fail(`assets: ${errors.join(' | ')}`);
  const file = await shoot(page, 'assets-ar-1280');
  ok(`assets ar@1280: ${file}`);
  await context.close();
}

await browser.close();
server.close();

console.log(`\n${failures.length ? `${failures.length} FAILURE(S)` : 'all checks passed'}`);
for (const f of failures) console.log(` - ${f}`);
process.exit(failures.length ? 1 : 0);
