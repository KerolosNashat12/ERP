/**
 * `robots.txt` and `sitemap.xml`, for whichever shop is asking.
 *
 * ── What a sitemap is for, and what it must never contain ────────────────────
 * A sitemap is an instruction to a machine to go and fetch every address in it.
 * That makes the omissions matter more than the entries:
 *
 *   - an unpublished product is absent, because `StorefrontService` builds the
 *     list behind the same `PUBLISHED_PRODUCT` gate every public page uses — a
 *     product photographed for next season is one incrementing id away from
 *     public, and a sitemap that listed it would hand a competitor the range;
 *   - an empty or unpublished category or brand is absent, for the same reason
 *     and by the same queries;
 *   - a cart, a checkout, a customer's own order, a saved-items list and the
 *     search page are absent — they are one person's session, or an unbounded
 *     space of query strings that would spend a small shop's crawl budget on
 *     nothing;
 *   - the ERP and the owner's console are absent, and `robots.txt` refuses them
 *     outright;
 *   - a shop whose website is switched off has NO sitemap at all. The routes
 *     that serve this sit behind the same tenant gate the storefront does, so
 *     the answer is a 404 in the same shape as an address that never existed —
 *     including for its photographs, which are what a sitemap would otherwise
 *     have led an image crawler to.
 *
 * ── What it costs on a serverless function ───────────────────────────────────
 * A shop with 5,000 products is 5,000 addresses, two language variants each and
 * a photograph apiece — several megabytes of XML, built in a function with a
 * memory limit and a wall clock, on every crawl. So `sitemap.xml` is an INDEX
 * and the addresses live in shards of `SHARD_SIZE`. Each request builds one
 * shard from one bounded query, whatever the catalogue grows to; the index
 * itself costs a single `COUNT(*)`. A 5,000-product shop is five shard requests
 * a crawl, none of them large, instead of one request that gets slower every
 * time the shop adds a shelf.
 *
 * Sitemaps and robots are the one public answer here allowed a short cache:
 * they contain nothing that is not already on a page a crawler can read, and a
 * crawler that re-fetches a sitemap every few minutes is not a customer waiting
 * for a price. Five minutes, so switching a website off still takes a shop's
 * addresses out of circulation within the same window everything else uses.
 */
import storefront from './StorefrontService.js';
import { shopUrl, slugFor, withLanguage } from '../../public/shared/shopUrls.js';

/** Addresses per shard. Well under the 50,000 a sitemap may hold, and small. */
export const SHARD_SIZE = 1000;

/** How long a crawler may reuse one of these. */
export const CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

const xml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/** An ISO date, or nothing — never a guess at when something last changed. */
function lastmod(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `<lastmod>${date.toISOString().slice(0, 10)}</lastmod>`;
}

/**
 * One `<url>`, with its own language alternates on it.
 *
 * `xhtml:link` in a sitemap is the same claim the `<link rel="alternate">` tags
 * on the page make, and Google requires the two to agree. Both entries name
 * both languages, so the pair is reciprocal from either direction — a one-way
 * `hreflang` is the failure mode that is worse than declaring nothing.
 */
function urlEntry({
  url, alternates, changefreq, priority, modified, image, imageAlt,
}) {
  const alts = alternates.map(({ lang, href }) => `
    <xhtml:link rel="alternate" hreflang="${xml(lang)}" href="${xml(href)}"/>`).join('');
  const picture = image ? `
    <image:image><image:loc>${xml(image)}</image:loc>${imageAlt ? `<image:title>${xml(imageAlt)}</image:title>` : ''}</image:image>` : '';
  return `  <url>
    <loc>${xml(url)}</loc>${alts}${picture}
    ${lastmod(modified)}${changefreq ? `<changefreq>${changefreq}</changefreq>` : ''}${priority ? `<priority>${priority}</priority>` : ''}
  </url>`;
}

const document = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${body}
</urlset>
`;

/** Absolute, and in both languages — the pair every entry carries. */
function pair(base, root, name, params = {}) {
  const absolute = new URL(shopUrl(root, name, params), base).href;
  return {
    url: withLanguage(absolute, 'ar'),
    alternates: [
      { lang: 'ar', href: withLanguage(absolute, 'ar') },
      { lang: 'en', href: withLanguage(absolute, 'en') },
      { lang: 'x-default', href: withLanguage(absolute, 'ar') },
    ],
  };
}

// ------------------------------------------------------------------ the index

/**
 * `sitemap.xml` — a list of the shards, never the addresses themselves.
 *
 * Products dominate and are the only part that grows, so they are the only part
 * that is sharded; the shop's own handful of pages and its taxonomy fit in one
 * document each and always will.
 */
export async function sitemapIndex({ base, root }) {
  const total = await storefront.sitemapCount();
  const shards = ['pages', 'taxonomy'];
  for (let i = 0; i < Math.max(Math.ceil(total / SHARD_SIZE), 1); i += 1) {
    shards.push(`products-${i + 1}`);
  }
  const entries = shards.map((shard) => `  <sitemap><loc>${xml(new URL(`${root.replace(/\/shop$/, '')}/sitemap/${shard}.xml`, base).href)}</loc></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</sitemapindex>
`;
}

// ------------------------------------------------------------------ the shards

/** The shop's own pages: the front page, everything, and how to reach a human. */
export async function pagesSitemap({ base, root }) {
  const entries = [
    { ...pair(base, root, 'home'), changefreq: 'daily', priority: '1.0' },
    { ...pair(base, root, 'products'), changefreq: 'daily', priority: '0.8' },
    { ...pair(base, root, 'contact'), changefreq: 'monthly', priority: '0.3' },
  ];
  return document(entries.map(urlEntry).join('\n'));
}

/**
 * Shelves and makers. Both lists already refuse anything unpublished, anything
 * inactive and anything with no visible product behind it — an empty category
 * is a dead end that also tells the world what the shop is about to stock.
 */
export async function taxonomySitemap({ base, root }) {
  const [categories, brands] = await Promise.all([storefront.categories(), storefront.brands()]);
  const entries = [
    ...categories.map((row) => ({
      ...pair(base, root, 'category', { id: row.id, slug: slugFor(row) }), changefreq: 'weekly', priority: '0.7',
    })),
    ...brands.map((row) => ({
      ...pair(base, root, 'brand', { id: row.id, slug: slugFor(row) }), changefreq: 'weekly', priority: '0.6',
    })),
  ];
  return document(entries.map(urlEntry).join('\n'));
}

/** One bounded page of the catalogue. `shard` is 1-based, as the index writes it. */
export async function productsSitemap({ base, root, prefix, shard }) {
  const rows = await storefront.sitemapProducts({
    offset: (shard - 1) * SHARD_SIZE, limit: SHARD_SIZE,
  });
  const entries = rows.map((row) => ({
    ...pair(base, root, 'product', { id: row.id, slug: slugFor(row) }),
    changefreq: 'weekly',
    priority: '0.9',
    modified: row.lastmod,
    // The photograph goes with the address it belongs to, so image search finds
    // a product page rather than a bare `/api/shop/images/41`. A shop whose
    // website is off never reaches this function at all, which is what keeps
    // its photographs out of an image index too.
    image: row.image_id ? new URL(`${prefix}/api/shop/images/${row.image_id}`, base).href : '',
    imageAlt: row.name_ar || row.name_en || '',
  }));
  return document(entries.map(urlEntry).join('\n'));
}

/** `pages`, `taxonomy`, `products-3` — or null for anything else. */
export function shardFor(name) {
  if (name === 'pages' || name === 'taxonomy') return { kind: name };
  const match = String(name || '').match(/^products-(\d{1,4})$/);
  if (!match) return null;
  const index = Number(match[1]);
  return index > 0 ? { kind: 'products', shard: index } : null;
}

// ------------------------------------------------------------------ robots.txt

/**
 * One robots.txt per host, so this has to speak for everything on it.
 *
 * The default is refusal. The ERP lives at `/` on a single-shop deployment and
 * the owner's console lives at `/platform` on a fleet, so anything not
 * explicitly allowed below is a back office — and a `Disallow: /` with narrower
 * `Allow:` lines under it is the only arrangement where adding a new admin page
 * does not also mean remembering to hide it. Google resolves the longest
 * matching rule, so each `Allow` beats the blanket refusal and each longer
 * `Disallow` beats the `Allow`.
 *
 * Product photographs ARE allowed: an image crawler that cannot fetch them
 * cannot put this shop's pieces in image search, which for a shop selling
 * things people look at is most of the point. They are allowed by pattern, for
 * every tenant prefix, which is safe precisely because a shop with its website
 * switched off answers 404 there — permission to fetch is not the same as
 * something being there.
 *
 * `sitemapUrl` is omitted rather than guessed when there is no shop at this
 * address (a console-only deployment) or when the shop that owns the root has
 * its website switched off.
 */
export function robotsTxt({ sitemapUrl = '', prefixes = [''] } = {}) {
  const roots = prefixes.map((prefix) => `${prefix}/shop`);
  const lines = [
    'User-agent: *',
    '',
    '# Everything is a back office unless it is a shop.',
    'Disallow: /',
    '',
  ];

  for (const root of roots) {
    lines.push(`Allow: ${root}`);
  }
  // Photographs, the shop's logo and its banner — the pictures a page needs and
  // the ones image search should be able to reach.
  for (const prefix of prefixes) {
    lines.push(`Allow: ${prefix}/api/shop/images/`);
    lines.push(`Allow: ${prefix}/api/shop/logo`);
    lines.push(`Allow: ${prefix}/api/shop/banner`);
  }
  /**
   * The modules the storefront itself loads, and the page that sells the
   * platform.
   *
   * `/shared/` is not optional. Googlebot RENDERS a page before it judges it,
   * and `public/shop/js/main.js` imports `/shared/brandTheme.js`,
   * `/shared/shopUrls.js` and `/shared/deploymentBanner.js` from the root
   * rather than from under `/shop`. A blanket refusal that swallowed those
   * would leave the crawler with a shell it could not run — the one failure
   * mode of a `Disallow: /` policy, and the reason it is written out here
   * instead of being left to whoever adds the next shared module.
   *
   * `/kj` is the marketing page. It belongs to no shop and it is the one page
   * here that WANTS to be found by somebody who has never heard of any of this.
   */
  lines.push('Allow: /shared/');
  lines.push('Allow: /kj');
  lines.push('');
  lines.push('# One customer\'s session, and a search space with no bottom to it.');
  for (const root of roots) {
    for (const page of ['cart', 'checkout', 'track', 'order/', 'favorites', 'search']) {
      lines.push(`Disallow: ${root}/${page}`);
    }
    // The shell as a file. It is served rendered at every real address; the
    // bare file names no shop and says `noindex` on its own, and this keeps a
    // crawler from finding it a second time by its filename.
    lines.push(`Disallow: ${root}/app.html`);
  }
  lines.push('');
  if (sitemapUrl) lines.push(`Sitemap: ${sitemapUrl}`);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export default {
  sitemapIndex, pagesSitemap, taxonomySitemap, productsSitemap, shardFor, robotsTxt, SHARD_SIZE, CACHE_CONTROL,
};
