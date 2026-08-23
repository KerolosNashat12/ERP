/**
 * Being findable — and, more importantly, being findable by the right people.
 *
 * The storefront could not be indexed at all: every page was `#/product/12`, a
 * fragment a crawler never sees, and the title, description and Open Graph card
 * were written by JavaScript that a WhatsApp preview does not run. This file
 * asserts the fix from the outside, over HTTP, on the bytes the server actually
 * sends — never on an internal function's return value, because "the head is
 * correct" is a claim about a document.
 *
 * Five of these existed before a line of it was written:
 *
 *   1. a product address renders THAT product's real title and description into
 *      the HTML, before any script runs;
 *   2. an unpublished product is in no sitemap, and its page is not indexable;
 *   3. a shop whose website is switched off has no sitemap, no robots.txt and
 *      no page at all — not even its photographs;
 *   4. two shops on one deployment never see each other's metadata. That bug
 *      has happened here before (a clothes shop called an accessories shop) and
 *      the shell is one file for every tenant, so it can happen again;
 *   5. `#/product/12`, which is in WhatsApp threads nobody can edit, still
 *      reaches the right page.
 *
 * Both drivers, because the sitemap and the head are built from queries and a
 * query that works on `node:sqlite` and not on libsql is a shop that is fine on
 * the counter PC and blank on the internet.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'shop-seo-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dir, 'tenants');
process.env.MM_DB_FILE = path.join(dir, 'root.db');
process.env.MM_DEFAULT_TENANT = 'mm';
process.env.MM_TENANT_CACHE_MS = '200';

const { createApp } = await import('../src/server.js');
const {
  initDb, applySchema, closeDb, openConnection, runWithTenant,
} = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const { slugify } = await import('../public/shared/shopUrls.js');
const { legacyHashRoute } = await import('../public/shared/shopUrls.js');

let base = '';
let server = null;

/** Two shops with nothing in common but a deployment. */
const SHOPS = {
  mm: {
    driver: 'sqlite',
    nameEn: 'M&M Accessories',
    nameAr: 'إم آند إم للإكسسوارات',
    metaEn: 'Silver, leather and watches from a family shop in Shubra, Cairo.',
    metaAr: 'فضة وجلد وساعات من محل عائلي في شبرا، القاهرة.',
    addressAr: '١٤ شارع شبرا، القاهرة',
    brand: ['Nadia Silver', 'نادية سيلفر'],
    category: ['Necklaces', 'عقود'],
    products: [
      {
        id: 1, en: 'Silver chain necklace', ar: 'سلسلة فضة إيطالي', published: 1, price: 850,
        dEn: 'A 45cm Italian silver chain, hallmarked 925, in a gift box.',
        dAr: 'سلسلة فضة إيطالي ٤٥ سم، عيار ٩٢٥، في علبة هدية.',
      },
      {
        id: 2, en: 'Unreleased winter piece', ar: 'قطعة شتوي لسه منزلتش', published: 0, price: 999,
        dEn: 'Not for sale yet.', dAr: 'لسه منزلتش.',
      },
    ],
  },
  zahra: {
    driver: 'libsql',
    nameEn: 'Zahra Clothing',
    nameAr: 'زهرة للملابس',
    metaEn: 'Modest womenswear made in Mansoura.',
    metaAr: 'ملابس حريمي محتشمة صناعة المنصورة.',
    addressAr: null,
    brand: ['Zahra', 'زهرة'],
    category: ['Dresses', 'فساتين'],
    products: [
      {
        id: 1, en: 'Linen summer dress', ar: 'فستان كتان صيفي', published: 1, price: 1200,
        dEn: 'Breathable linen, three colours.', dAr: 'كتان خفيف، تلات ألوان.',
      },
    ],
  },
};

async function withShop(slug, fn) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  const connection = await openConnection({
    driver: row.driver, file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  });
  try {
    return await runWithTenant({ slug }, connection, () => fn(connection.facade));
  } finally {
    await connection.close();
  }
}

/** A catalogue written straight into the shop's own database. */
async function fill(slug, spec) {
  await withShop(slug, async (db) => {
    const settings = {
      'company.name': spec.nameEn,
      'company.name_ar': spec.nameAr,
      'company.currency': 'EGP',
      'web.meta_description_en': spec.metaEn,
      'web.meta_description_ar': spec.metaAr,
      'shop.delivery_fee': '55',
      ...(spec.addressAr ? { 'web.contact_address_ar': spec.addressAr } : {}),
    };
    for (const [key, value] of Object.entries(settings)) {
      await db.prepare('INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)')
        .run(key, value, key === 'shop.delivery_fee' ? 'number' : 'string');
    }
    await db.prepare('INSERT INTO brands (id, code, name_en, name_ar) VALUES (1, ?, ?, ?)')
      .run(`B-${slug}`, spec.brand[0], spec.brand[1]);
    await db.prepare('INSERT INTO categories (id, code, name_en, name_ar) VALUES (1, ?, ?, ?)')
      .run(`C-${slug}`, spec.category[0], spec.category[1]);

    for (const p of spec.products) {
      await db.prepare(`
        INSERT INTO products (id, sku_prefix, name_en, name_ar, description_en, description_ar,
                              brand_id, category_id, base_price, is_active, is_published,
                              published_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 1, ?, '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z')
      `).run(p.id, `${slug}-${p.id}`, p.en, p.ar, p.dEn, p.dAr, p.price, p.published);
      await db.prepare(`
        INSERT INTO product_variants (product_id, sku, selling_price, is_active)
        VALUES (?, ?, ?, 1)
      `).run(p.id, `${slug}-${p.id}-A`, p.price);
      await db.prepare(`
        INSERT INTO product_images (id, product_id, data, content_type, byte_size, alt_en, alt_ar)
        VALUES (?, ?, ?, 'image/jpeg', 3, ?, ?)
      `).run(p.id, p.id, Buffer.from([0xFF, 0xD8, 0xFF]), p.en, p.ar);
    }
  });
}

before(async () => {
  await initDb();
  await applySchema();
  await initPlatformDb();

  for (const [slug, spec] of Object.entries(SHOPS)) {
    await tenantService.create({
      slug,
      nameEn: spec.nameEn,
      nameAr: spec.nameAr,
      modules: Object.keys(MODULES),
      websiteEnabled: true,
      database: spec.driver === 'libsql'
        ? { mode: 'libsql', url: `file:${path.join(dir, 'tenants', `${slug}.db`)}` }
        : { mode: 'file' },
    });
    await fill(slug, spec);
  }

  // A third shop, with its website switched off in the owner's console.
  await tenantService.create({
    slug: 'closed', nameEn: 'Closed Shop', nameAr: 'محل مقفول', modules: Object.keys(MODULES), websiteEnabled: false,
  });
  await fill('closed', { ...SHOPS.mm, nameEn: 'Closed Shop', nameAr: 'محل مقفول' });

  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(`${base}${p}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
};

/** The head, read out of the bytes the server sent — no browser, no script. */
function head(html) {
  // The head is markup, so what comes back out of it is entity-encoded. Tests
  // compare the shop's actual words, not their spelling in HTML.
  const text = (value) => (value === null || value === undefined ? null : String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  const one = (re) => text((html.match(re) || [])[1]) || null;
  return {
    html: one(/<html\s([^>]*)>/),
    title: one(/<title>([\s\S]*?)<\/title>/),
    description: one(/<meta name="description" content="([^"]*)"/),
    canonical: one(/<link rel="canonical" href="([^"]*)"/),
    robots: one(/<meta name="robots" content="([^"]*)"/),
    ogTitle: one(/<meta property="og:title" content="([^"]*)"/),
    ogImage: one(/<meta property="og:image" content="([^"]*)"/),
    ar: one(/<link rel="alternate" hreflang="ar" href="([^"]*)"/),
    en: one(/<link rel="alternate" hreflang="en" href="([^"]*)"/),
    xDefault: one(/<link rel="alternate" hreflang="x-default" href="([^"]*)"/),
    jsonLd: one(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/),
  };
}

const graphOf = (html) => JSON.parse(head(html).jsonLd)['@graph'];
const nodeOf = (html, type) => graphOf(html).find((n) => n['@type'] === type);

/* ══════════════════════════════════════ 1. the head, in the bytes that are sent */

test('a product address carries that product\'s own title and description, before any script runs', async () => {
  const page = await get('/t/mm/shop/product/1');
  assert.equal(page.status, 200);
  const h = head(page.body);

  assert.equal(h.title, 'سلسلة فضة إيطالي — إم آند إم للإكسسوارات');
  assert.equal(h.description, 'سلسلة فضة إيطالي ٤٥ سم، عيار ٩٢٥، في علبة هدية.');
  assert.equal(h.ogTitle, h.title, 'and the same in the card a WhatsApp preview builds');
  assert.equal(h.ogImage, `${base}/t/mm/api/shop/images/1`, 'pointing at this product\'s own photograph');
  assert.equal(h.robots, 'index, follow, max-image-preview:large, max-snippet:-1');

  // The placeholder that ships in the shell must be gone, not sitting beside it.
  assert.doesNotMatch(page.body, /<title>المتجر<\/title>/);
  assert.equal((page.body.match(/<title>/g) || []).length, 1, 'exactly one title');
  assert.equal((page.body.match(/<meta name="description"/g) || []).length, 1);
});

test('the address carries the product\'s own name, and a link without it still arrives', async () => {
  const slug = slugify('سلسلة فضة إيطالي');
  const canonical = `${base}/t/mm/shop/product/1/${encodeURIComponent(slug)}`;

  // Arrived without the slug…
  const bare = await get('/t/mm/shop/product/1');
  assert.equal(bare.status, 200);
  assert.equal(head(bare.body).canonical, canonical, 'and is told the readable address');

  // …arrived with a slug that is no longer right (the shop renamed the piece)…
  const stale = await get('/t/mm/shop/product/1/something-else-entirely');
  assert.equal(stale.status, 200);
  assert.equal(head(stale.body).title, 'سلسلة فضة إيطالي — إم آند إم للإكسسوارات');
  assert.equal(head(stale.body).canonical, canonical, 'same page, one canonical address');

  // …and arrived correctly.
  const exact = await get(`/t/mm/shop/product/1/${encodeURIComponent(slug)}`);
  assert.equal(head(exact.body).canonical, canonical);
});

test('the two languages are declared as alternates of each other, reciprocally', async () => {
  const arabic = head((await get('/t/mm/shop/product/1')).body);
  const english = head((await get('/t/mm/shop/product/1?lang=en')).body);

  assert.match(arabic.html, /lang="ar"/);
  assert.match(arabic.html, /dir="rtl"/);
  assert.match(english.html, /lang="en"/);
  assert.match(english.html, /dir="ltr"/);
  assert.equal(english.title, 'Silver chain necklace — M&M Accessories');

  // Each version is its own canonical address…
  assert.equal(arabic.canonical, arabic.ar);
  assert.equal(english.canonical, english.en);
  // …and both name the same pair, from either side. A one-way hreflang is
  // worse than declaring nothing at all.
  assert.equal(arabic.ar, english.ar);
  assert.equal(arabic.en, english.en);
  assert.equal(arabic.xDefault, arabic.ar, 'and Arabic is the default: this shop is Egyptian');
  assert.equal(english.xDefault, arabic.ar);
  assert.match(english.en, /\?lang=en$/);
});

test('a sorted shelf and a second page are told apart from each other', async () => {
  const shelf = `${base}/t/mm/shop/products`;

  // A sort order is the same products in a different order: one address.
  assert.equal(head((await get('/t/mm/shop/products')).body).canonical, shelf);
  assert.equal(head((await get('/t/mm/shop/products?sort=price_asc')).body).canonical, shelf);
  assert.equal(head((await get('/t/mm/shop/products?sort=name')).body).canonical, shelf);

  // A second page is a different set of products, so it is its own address —
  // and it still sheds the sort.
  assert.equal(head((await get('/t/mm/shop/products?page=2')).body).canonical, `${shelf}?page=2`);
  assert.equal(head((await get('/t/mm/shop/products?page=2&sort=price_asc')).body).canonical, `${shelf}?page=2`);
  // The alternates carry it too, or they would point at a different page.
  assert.equal(head((await get('/t/mm/shop/products?page=2')).body).en, `${shelf}?page=2&lang=en`);

  // Junk in the query is not an address.
  assert.equal(head((await get('/t/mm/shop/products?page=0')).body).canonical, shelf);
  assert.equal(head((await get('/t/mm/shop/products?page=nonsense')).body).canonical, shelf);
  assert.equal(head((await get('/t/mm/shop/products?page=999999999')).body).canonical, shelf);
});

test('a page that is one customer\'s own is served, and is not indexable', async () => {
  for (const p of ['cart', 'checkout', 'track', 'favorites', 'search?q=oud', 'order/W-1']) {
    const page = await get(`/t/mm/shop/${p}`);
    assert.equal(page.status, 200, `/${p} still works for the customer holding the link`);
    assert.equal(head(page.body).robots, 'noindex, follow', `/${p} is not for an index`);
  }
});

/* ══════════════════════════════════ 2. what the structured data may claim */

test('structured data describes the offer, and claims no rating and no review', async () => {
  const page = await get('/t/mm/shop/product/1');
  const graph = graphOf(page.body);
  assert.deepEqual(graph.map((n) => n['@type']), ['Store', 'Product', 'BreadcrumbList']);

  const product = nodeOf(page.body, 'Product');
  assert.equal(product.name, 'سلسلة فضة إيطالي');
  assert.equal(product.brand.name, 'نادية سيلفر');
  assert.equal(product.category, 'عقود');
  assert.equal(product.offers.priceCurrency, 'EGP');
  assert.equal(product.offers.price, 850);
  assert.equal(product.offers.availability, 'https://schema.org/OutOfStock',
    'the stock verdict the page itself shows, not a guess');
  assert.equal(product.offers.shippingDetails.shippingRate.value, 55);

  // The whole point. This shop has never had a review or a rating; inventing
  // one is a manual action from Google and a lie to a customer deciding
  // whether to trust a shop they have never heard of.
  const asText = JSON.stringify(graph);
  assert.doesNotMatch(asText, /aggregateRating|"review"|ratingValue|reviewCount/i);
  // Nor opening hours, which this shop stores as a line of free text an owner
  // typed and which cannot be turned into a specification without guessing.
  assert.doesNotMatch(asText, /openingHours/i);

  // The trail claimed is the trail the page draws: Home / <brand> / <product>.
  const crumbs = nodeOf(page.body, 'BreadcrumbList').itemListElement.map((i) => i.name);
  assert.deepEqual(crumbs, ['الرئيسية', 'نادية سيلفر', 'سلسلة فضة إيطالي']);
});

test('a shop that has entered an address is a Store; one that has not is an Organization', async () => {
  assert.equal(nodeOf((await get('/t/mm/shop')).body, 'Store').address.addressCountry, 'EG');
  assert.equal(nodeOf((await get('/t/zahra/shop')).body, 'Organization').address, undefined);
});

/* ══════════════════════════ 3. an unpublished product, and a closed shop */

test('an unpublished product is in no sitemap, and its page is not indexable', async () => {
  const products = await get('/t/mm/sitemap/products-1.xml');
  assert.equal(products.status, 200);
  assert.match(products.body, /shop\/product\/1\//, 'the published piece is listed');
  assert.doesNotMatch(products.body, /shop\/product\/2/, 'the unreleased one is not');
  assert.doesNotMatch(products.body, /قطعة شتوي/, 'and neither is its name');
  assert.doesNotMatch(products.body, /images\/2/, 'nor its photograph');

  const page = await get('/t/mm/shop/product/2');
  assert.equal(page.status, 404, 'and the page itself is a 404, not a 403 that confirms it exists');
  assert.equal(head(page.body).robots, 'noindex, follow');
  assert.doesNotMatch(page.body, /قطعة شتوي/, 'the name never reaches the HTML at all');
});

test('a shop with its website switched off has nothing a crawler can reach', async () => {
  for (const p of [
    '/t/closed/shop',
    '/t/closed/shop/product/1',
    '/t/closed/shop/app.html',
    '/t/closed/robots.txt',
    '/t/closed/sitemap.xml',
    '/t/closed/sitemap/products-1.xml',
    '/t/closed/api/shop/images/1',
  ]) {
    const res = await get(p);
    assert.equal(res.status, 404, `${p} must be nothing at all`);
    assert.doesNotMatch(res.body, /<html/, `${p} answers with no document`);
    assert.doesNotMatch(res.body, /محل مقفول|Closed Shop/, `${p} does not name the shop it is hiding`);
  }
});

test('a shop closed in the ERP keeps its pages for its customers and loses its sitemap', async () => {
  await withShop('zahra', async (db) => {
    await db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES ('shop.enabled', '0', 'boolean')").run();
  });
  try {
    const page = await get('/t/zahra/shop/product/1');
    assert.equal(page.status, 200, 'a customer with the link still gets a page saying the shop is shut');
    assert.equal(head(page.body).robots, 'noindex, follow');
    assert.equal(await (await get('/t/zahra/sitemap.xml')).status, 404);
    assert.equal(await (await get('/t/zahra/sitemap/products-1.xml')).status, 404);
    assert.doesNotMatch((await get('/t/zahra/robots.txt')).body, /Sitemap:/);
  } finally {
    await withShop('zahra', async (db) => {
      await db.prepare("INSERT OR REPLACE INTO settings (key, value, value_type) VALUES ('shop.enabled', '1', 'boolean')").run();
    });
  }
});

/* ═════════════════════════════════ 4. two shops, one deployment, no leakage */

test('two shops on one deployment never see each other\'s metadata', async () => {
  const mm = await get('/t/mm/shop/product/1');
  const zahra = await get('/t/zahra/shop/product/1');

  assert.match(mm.body, /إم آند إم للإكسسوارات/);
  assert.match(zahra.body, /زهرة للملابس/);

  // Neither document contains one word of the other's — not its name, not its
  // catalogue, not its address. This is the bug that made a clothes shop call
  // itself an accessories shop, and the shell is still one file for both.
  for (const stranger of ['إم آند إم للإكسسوارات', 'M&amp;M Accessories', 'M&M Accessories', 'سلسلة فضة إيطالي', 'Nadia Silver', 'شارع شبرا']) {
    assert.doesNotMatch(zahra.body, new RegExp(stranger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `Zahra's page must not carry "${stranger}"`);
  }
  for (const stranger of ['زهرة للملابس', 'Zahra Clothing', 'فستان كتان صيفي']) {
    assert.doesNotMatch(mm.body, new RegExp(stranger), `M&M's page must not carry "${stranger}"`);
  }

  // Their sitemaps and their photographs are separate too.
  const mmMap = await get('/t/mm/sitemap/products-1.xml');
  assert.match(mmMap.body, /\/t\/mm\/shop\/product\//);
  assert.doesNotMatch(mmMap.body, /\/t\/zahra\//);
  assert.doesNotMatch(mmMap.body, /فستان/);
});

test('the shell that ships on disk names no shop and refuses to be indexed', async () => {
  const shell = fs.readFileSync(path.join(here, '..', 'public', 'shop', 'app.html'), 'utf8');
  assert.ok(shell.includes('<!--MM-SEO-START-->') && shell.includes('<!--MM-SEO-END-->'),
    'the markers the renderer replaces are still there');
  assert.ok(shell.includes('<html lang="ar" dir="rtl">'), 'and the opening tag the renderer rewrites');
  assert.match(shell, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!fs.existsSync(path.join(here, '..', 'public', 'shop', 'index.html')),
    'and there is no directory index for a CDN to serve ahead of the application');
});

/* ═══════════════════════════════════════════ 5. links already in the world */

test('an old #/ link still reaches the right page', async () => {
  // The fragment is never sent to a server, so the translation is the browser's
  // and this is the function that does it — public/shared/shopUrls.js, imported
  // by core/router.js on arrival and `replaceState`d before the first render.
  assert.equal(legacyHashRoute('#/product/12'), 'product/12');
  assert.equal(legacyHashRoute('#/category/3'), 'category/3');
  assert.equal(legacyHashRoute('#/search?q=oud'), 'search?q=oud');
  assert.equal(legacyHashRoute('#/'), '');
  assert.equal(legacyHashRoute('#main'), null, 'an in-page anchor is left alone');
  assert.equal(legacyHashRoute(''), null);

  // And the address it translates to is a real page of the right product.
  const landed = await get(`/t/mm/shop/${legacyHashRoute('#/product/1')}`);
  assert.equal(landed.status, 200);
  assert.equal(head(landed.body).title, 'سلسلة فضة إيطالي — إم آند إم للإكسسوارات');

  // The pre-platform address keeps working too, and a browser carries the
  // fragment across the redirect.
  const old = await get('/shop/product/1');
  assert.equal(old.status, 302);
  assert.equal(old.headers.get('location'), '/t/mm/shop/product/1');
});

/* ═══════════════════════════════════════════════ robots, sitemaps, caching */

test('robots.txt refuses the back office and allows the shop', async () => {
  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.body, /^Disallow: \/$/m, 'everything is a back office unless it is a shop');
  assert.match(robots.body, /^Allow: \/t\/\*\/shop$/m);
  assert.match(robots.body, /^Allow: \/t\/\*\/api\/shop\/images\/$/m, 'photographs are for image search');
  // Googlebot renders before it judges, and the storefront's own modules live
  // at the root: blocking them would leave a crawler holding a shell.
  assert.match(robots.body, /^Allow: \/shared\/$/m);
  assert.match(robots.body, /^Allow: \/kj$/m, 'the marketing page is nobody\'s tenant and wants to be found');
  for (const page of ['cart', 'checkout', 'search', 'favorites']) {
    assert.match(robots.body, new RegExp(`^Disallow: /t/\\*/shop/${page}$`, 'm'));
  }
  assert.match(robots.body, new RegExp(`^Sitemap: ${base}/t/mm/sitemap\\.xml$`, 'm'));
  // One shop is named — the one that owns this address. A list of the shops on
  // a platform is not the internet's to have.
  assert.doesNotMatch(robots.body, /zahra|closed/);
});

test('the sitemap is an index of bounded shards, and lists only what is public', async () => {
  const index = await get('/t/mm/sitemap.xml');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /xml/);
  assert.deepEqual(
    [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    [
      `${base}/t/mm/sitemap/pages.xml`,
      `${base}/t/mm/sitemap/taxonomy.xml`,
      `${base}/t/mm/sitemap/products-1.xml`,
    ],
  );

  const pages = await get('/t/mm/sitemap/pages.xml');
  assert.match(pages.body, new RegExp(`<loc>${base}/t/mm/shop</loc>`));
  // Nothing that is one person's session, and nothing that is a search.
  assert.doesNotMatch(pages.body, /cart|checkout|favorites|search|track|order/);

  const taxonomy = await get('/t/mm/sitemap/taxonomy.xml');
  assert.match(taxonomy.body, /shop\/category\/1\//);
  assert.match(taxonomy.body, /shop\/brand\/1\//);

  // Both languages are declared in the sitemap, matching the pages' own tags.
  const products = await get('/t/mm/sitemap/products-1.xml');
  assert.match(products.body, /hreflang="ar"/);
  assert.match(products.body, /hreflang="en"/);
  assert.match(products.body, /hreflang="x-default"/);
  assert.match(products.body, /<lastmod>2026-01-05<\/lastmod>/);

  // A shard nobody asked for is a 404, not an empty document that would tell a
  // crawler to keep asking.
  assert.equal((await get('/t/mm/sitemap/products-9.xml')).status, 200, 'a shard past the end is empty, not missing');
  assert.equal((await get('/t/mm/sitemap/nonsense.xml')).status, 404);
});

test('a large catalogue is sharded rather than built in one go', async () => {
  const { SHARD_SIZE } = await import('../src/services/SitemapService.js');
  const storefront = (await import('../src/services/StorefrontService.js')).default;

  await withShop('mm', async (db) => {
    // Enough to spill into a second shard, written straight in.
    for (let i = 100; i < 100 + SHARD_SIZE + 5; i += 1) {
      await db.prepare(`
        INSERT INTO products (id, sku_prefix, name_en, name_ar, base_price, is_active, is_published)
        VALUES (?, ?, ?, ?, 10, 1, 1)
      `).run(i, `BULK-${i}`, `Bulk ${i}`, `منتج ${i}`);
      await db.prepare('INSERT INTO product_variants (product_id, sku, selling_price, is_active) VALUES (?, ?, 10, 1)')
        .run(i, `BULK-${i}-A`);
    }
  });

  try {
    const index = await get('/t/mm/sitemap.xml');
    const shards = [...index.body.matchAll(/sitemap\/products-(\d+)\.xml/g)].map((m) => Number(m[1]));
    assert.deepEqual(shards, [1, 2], 'the index grew a shard rather than the shard growing');

    const first = await get('/t/mm/sitemap/products-1.xml');
    assert.equal((first.body.match(/<loc>/g) || []).length, SHARD_SIZE,
      'and no single request ever builds more than one shard');
    const second = await get('/t/mm/sitemap/products-2.xml');
    assert.equal((second.body.match(/<loc>/g) || []).length, 6);

    // The query behind it is bounded, whatever the catalogue does.
    const rows = await withShop('mm', () => storefront.sitemapProducts({ offset: 0, limit: SHARD_SIZE }));
    assert.equal(rows.length, SHARD_SIZE);
  } finally {
    await withShop('mm', async (db) => {
      await db.prepare('DELETE FROM product_variants WHERE sku LIKE ?').run('BULK-%');
      await db.prepare('DELETE FROM products WHERE sku_prefix LIKE ?').run('BULK-%');
    });
  }
});

/**
 * Both drivers, explicitly.
 *
 * `mm` is a `node:sqlite` file — the shop PC — and `zahra` is libsql, which is
 * what a hosted deployment actually talks to. The head and the sitemap are both
 * built from queries, and a query that works on one driver and not on the other
 * is a shop that is fine on the counter and blank on the internet.
 */
for (const [slug, driver] of [['mm', 'sqlite'], ['zahra', 'libsql']]) {
  test(`${driver}: the head and the sitemap are built from that shop's own database`, async () => {
    const row = await platformDb().prepare('SELECT driver FROM tenants WHERE slug = ?').get(slug);
    assert.equal(row.driver, driver, 'the fixture really is on this driver');

    const spec = SHOPS[slug];
    const page = await get(`/t/${slug}/shop/product/1`);
    assert.equal(page.status, 200);
    assert.equal(head(page.body).title, `${spec.products[0].ar} — ${spec.nameAr}`);
    assert.equal(head(page.body).description, spec.products[0].dAr);

    const products = await get(`/t/${slug}/sitemap/products-1.xml`);
    assert.equal(products.status, 200);
    assert.equal((products.body.match(/<loc>/g) || []).length, 1, 'one published product, one address');
    assert.match(products.body, new RegExp(`/t/${slug}/shop/product/1/`));

    const taxonomy = await get(`/t/${slug}/sitemap/taxonomy.xml`);
    assert.match(taxonomy.body, /shop\/category\/1\//);
    assert.match(taxonomy.body, /shop\/brand\/1\//);
  });
}

test('a storefront page is never cached; a sitemap is, briefly', async () => {
  // The page now carries prices, a stock verdict and whether the shop is open —
  // all answers that were only true when they were given. Same rule as /api.
  const page = await get('/t/mm/shop/product/1');
  assert.match(page.headers.get('cache-control'), /no-store/);

  const sitemap = await get('/t/mm/sitemap.xml');
  assert.match(sitemap.headers.get('cache-control'), /max-age=300/);
});

test('the ERP and the owner\'s console refuse to be indexed on their own account', async () => {
  for (const file of ['index.html', path.join('platform', 'index.html')]) {
    const html = fs.readFileSync(path.join(here, '..', 'public', file), 'utf8');
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/, `${file} says so itself`);
  }
});

/* ═══════════════════════════════════════ the words, written down once */

test('the head and the page read the same dictionary, in both languages', async () => {
  // The server renders the head out of `public/shop/js/core/i18n.js` — the
  // storefront's own file, imported by Node. If that ever became a second copy,
  // the sentence a shared link arrives wearing and the sentence the page
  // settles on would drift, and only one of them is ever looked at.
  const { translate } = await import('../public/shop/js/core/i18n.js');
  const page = await get('/t/mm/shop/category/1/x');
  assert.equal(
    head(page.body).description,
    translate('ar', 'metaListing', 'عقود', 'إم آند إم للإكسسوارات'),
  );

  const english = await get('/t/mm/shop/category/1/x?lang=en');
  assert.equal(
    head(english.body).description,
    translate('en', 'metaListing', 'Necklaces', 'M&M Accessories'),
  );
});
