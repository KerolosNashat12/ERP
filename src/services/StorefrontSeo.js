/**
 * The `<head>` a crawler and a link preview actually see.
 *
 * ── The problem this file exists for ─────────────────────────────────────────
 * The storefront is one HTML shell for every shop on the platform, and until
 * now everything that identified a page — its title, its description, its Open
 * Graph card — was written by JavaScript after the page loaded. A browser
 * catches up in a moment. WhatsApp, Facebook and Twitter never run the script
 * at all, so every product a customer forwarded to a friend arrived wearing a
 * placeholder; and Google, which does run it, ran it late and only ever found
 * one address per shop because every page was a `#/` fragment.
 *
 * So the head is rendered here, on the server, into the shell before it is
 * sent. That is the whole change: the shell stays a static file with no shop's
 * name in it, and this file fills in one region of it.
 *
 * ── Not a rendering engine ───────────────────────────────────────────────────
 * The BODY is untouched. Nothing here renders a product card, a price or a
 * paragraph — the storefront's views keep doing that in the browser, exactly as
 * they did. This writes a `<head>` and one `<script type="application/json">`,
 * and it does it by replacing a marked region of the shell with a string. Two
 * literal substitutions on a template read from disk once. There is no
 * template language, no component, no second renderer to keep in step with the
 * first.
 *
 * ── And not a second copy of the shop's words ────────────────────────────────
 * Every sentence in the head comes out of `public/shop/js/core/i18n.js` — the
 * storefront's own dictionary, imported directly. Node can read a plain ES
 * module out of `public/`; the browser cannot read `src/`, which is why the
 * mirror in `core/store.js` exists and says so. This is the direction that
 * works, so it is the direction used, and there is exactly one place where the
 * words "متاح دلوقتي في" are written down. A shop name never appears in either
 * file: it is always an argument, always from `config.branding`, because a
 * literal here would be shown by every other tenant on the deployment.
 *
 * ── What the structured data is allowed to say ───────────────────────────────
 * Only what this shop actually knows: a price, a currency, a stock verdict, a
 * brand, a category, photographs, and — where the owner typed one — a postal
 * address and a phone number. There is NO `aggregateRating` and NO `review`,
 * anywhere, ever. This shop has no reviews and no ratings; inventing them is a
 * manual action from Google and a lie told to a customer who is deciding
 * whether to trust a shop they have never heard of. Opening hours are stored as
 * a free-text line an owner typed in his own words, which cannot be turned into
 * `openingHoursSpecification` without guessing, so they are not claimed either.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config/index.js';
import storefront from './StorefrontService.js';
import { publicBaseUrl } from '../platform/links.js';
import { NotFoundError } from '../shared/errors.js';
import { markFor, chromeColor, monogramFavicon } from '../../public/shared/brandTheme.js';
import { translate, pickIn } from '../../public/shop/js/core/i18n.js';
import {
  LANG_PARAM, DEFAULT_LANG, slugFor, shopUrl, withLanguage, languageFrom,
} from '../../public/shared/shopUrls.js';

const SHELL = path.join(config.paths.public, 'shop', 'app.html');
const START = '<!--MM-SEO-START-->';
const END = '<!--MM-SEO-END-->';
const HTML_TAG = '<html lang="ar" dir="rtl">';

/**
 * The shell, read once per process and split around the region this file owns.
 *
 * A serverless instance handles many requests; reading and splitting the file
 * on each of them would be the only disk I/O on the page's critical path. The
 * cache holds the TEMPLATE and never a rendered page — a rendered page belongs
 * to one shop, and one shop's page in a cache shared by every tenant is the
 * exact bug this storefront already has comments about.
 */
let template = null;

function shell() {
  if (template) return template;
  const raw = fs.readFileSync(SHELL, 'utf8');
  const from = raw.indexOf(START);
  const to = raw.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${SHELL} has lost its ${START} / ${END} markers`);
  }
  template = {
    head: raw.slice(0, from),
    tail: raw.slice(to + END.length),
  };
  return template;
}

/** Tests reload the shell after touching it on disk. */
export const forgetShell = () => { template = null; };

// ------------------------------------------------------------------ escaping

const escape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * JSON that cannot end the script element it is sitting in. `</script>` inside
 * a product description would otherwise close the block and put the rest of the
 * shop's catalogue into the page as markup.
 */
const jsonScript = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026')
  // U+2028 and U+2029 are line terminators to a JavaScript parser but not to a
  // JSON one, so a product description pasted out of Word could otherwise end
  // the statement it is sitting in.
  .replace(/[\u2028]/g, '\\u2028')
  .replace(/[\u2029]/g, '\\u2029');

const meta = (name, content) => (content ? `<meta name="${escape(name)}" content="${escape(content)}">` : '');
const og = (property, content) => (content ? `<meta property="${escape(property)}" content="${escape(content)}">` : '');

/** One line of prose, trimmed to something a search result will actually show. */
function summarise(text, limit = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[،,.\s-]+$/, '')}…`;
}

// ------------------------------------------------------------------- the page

/**
 * Which pages a crawler is welcome on.
 *
 * A cart, a checkout, a customer's own order, a saved-items list and a search
 * results page are not pages: they are one person's session, or an unbounded
 * space of query strings that would eat a small shop's entire crawl budget.
 * They stay reachable — a customer's link must work — and they say `noindex`.
 */
const INDEXABLE = new Set(['home', 'products', 'category', 'brand', 'product', 'contact']);

/** `product/12/silver-chain` -> the route this file knows how to describe. */
export function routeFor(segments) {
  const [first, second] = segments;
  if (!first) return { name: 'home' };
  if (['product', 'category', 'brand'].includes(first)) {
    const id = /^\d+$/.test(String(second || '')) ? Number(second) : null;
    return id ? { name: first, id } : { name: 'notFound' };
  }
  if (first === 'order') return { name: 'order' };
  if (['products', 'search', 'cart', 'checkout', 'track', 'favorites', 'contact'].includes(first)) {
    return { name: first };
  }
  return { name: 'notFound' };
}

/**
 * Everything the head of one page needs, in as few round trips as the page has.
 *
 * The three shop-wide reads are the same three the browser used to make on boot
 * and they are made in parallel, so rendering the head costs one round trip of
 * latency rather than four — and the browser then makes none of them, because
 * the answers ride down inside the HTML. See `bootPayload` below: this is what
 * pays for the render on a phone on Egyptian mobile data.
 */
async function gather(route) {
  const wants = INDEXABLE.has(route.name) || route.name === 'notFound';
  const [shopConfig, categories, brands, product] = await Promise.all([
    storefront.config(),
    storefront.categories(),
    storefront.brands(),
    route.name === 'product' && wants
      ? storefront.product(route.id).catch((error) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })
      : Promise.resolve(null),
  ]);
  return { shopConfig, categories, brands, product };
}

const bilingual = (record, lang) => {
  if (!record) return '';
  const wanted = lang === 'ar' ? record.ar : record.en;
  const other = lang === 'ar' ? record.en : record.ar;
  return (wanted && String(wanted).trim()) || (other && String(other).trim()) || '';
};

/**
 * What this page is called, what it says about itself, and where its picture is
 * — decided once, from the shop's own data and the storefront's own dictionary.
 */
function describe({ route, data, lang, links, prefix, base }) {
  const { shopConfig, categories, brands, product } = data;
  const name = bilingual(shopConfig.companyName, lang);
  const shopDescription = bilingual(shopConfig.branding?.metaDescription, lang)
    || bilingual(shopConfig.branding?.about, lang)
    || name;
  const asset = (value) => (value ? new URL(`${prefix}${value}`, base).href : null);
  const photo = (id) => (id ? new URL(`${prefix}/api/shop/images/${id}`, base).href : null);
  const logo = asset(shopConfig.branding?.logo);
  const fallbackImage = logo || asset(shopConfig.banner?.image);

  const t = (key, ...args) => translate(lang, key, ...args);
  const titled = (title) => (title ? t('metaTitle', title, name) : name);

  // A shop switched off in the ERP shows one closed notice on every page. It is
  // not a product page and must not be indexed as one, whatever it was
  // yesterday — see the note on `indexable` below.
  if (!shopConfig.shopEnabled) {
    return {
      title: titled(t('closedTitle')),
      description: t('closedBody'),
      image: fallbackImage,
      indexable: false,
      name,
      logo,
      shopDescription,
    };
  }

  switch (route.name) {
    case 'product': {
      if (!product) {
        return {
          title: titled(t('productGoneTitle')), description: t('notFoundBody'), image: fallbackImage, indexable: false, name, logo, shopDescription, status: 404,
        };
      }
      const productName = pickIn(lang, product, 'name');
      const prose = summarise(pickIn(lang, product, 'description'));
      return {
        title: titled(productName),
        description: prose || summarise(t('metaProduct', productName, name)),
        image: photo(product.image_id) || fallbackImage,
        imageAlt: productName,
        indexable: true,
        ogType: 'product',
        name,
        logo,
        shopDescription,
      };
    }
    case 'category':
    case 'brand': {
      const row = (route.name === 'category' ? categories : brands)
        .find((entry) => entry.id === route.id);
      if (!row) {
        return {
          title: titled(t('notFoundTitle')), description: t('notFoundBody'), image: fallbackImage, indexable: false, name, logo, shopDescription, status: 404,
        };
      }
      const label = pickIn(lang, row, 'name');
      return {
        title: titled(label),
        description: summarise(t('metaListing', label, name)),
        image: fallbackImage,
        indexable: true,
        heading: label,
        row,
        name,
        logo,
        shopDescription,
      };
    }
    case 'products':
      return {
        title: titled(t('allProducts')),
        description: summarise(t('metaListing', t('allProducts'), name)),
        image: fallbackImage,
        indexable: true,
        heading: t('allProducts'),
        name,
        logo,
        shopDescription,
      };
    case 'contact':
      return {
        title: titled(t('contactTitle')),
        description: t('contactIntro'),
        image: fallbackImage,
        indexable: true,
        heading: t('contactTitle'),
        name,
        logo,
        shopDescription,
      };
    case 'home':
      return {
        title: name, description: shopDescription, image: fallbackImage, indexable: true, name, logo, shopDescription,
      };
    case 'notFound':
      return {
        title: titled(t('notFoundTitle')), description: t('notFoundBody'), image: fallbackImage, indexable: false, name, logo, shopDescription, status: 404,
      };
    default: {
      // cart, checkout, track, order, favorites, search: a real page for the
      // customer holding the link, and nothing for a crawler to file.
      const key = {
        cart: 'yourCart', checkout: 'checkout', track: 'trackTitle', order: 'trackTitle', favorites: 'yourFavorites', search: 'search',
      }[route.name] || 'allProducts';
      return {
        title: titled(t(key)), description: shopDescription, image: fallbackImage, indexable: false, name, logo, shopDescription,
      };
    }
  }
}

// ------------------------------------------------------------ structured data

const AVAILABILITY = {
  in_stock: 'https://schema.org/InStock',
  low: 'https://schema.org/LimitedAvailability',
  out: 'https://schema.org/OutOfStock',
};

/**
 * The shop itself.
 *
 * A `Store` rather than a plain `Organization` only when the owner has actually
 * typed an address — that is what makes a local business a local business, and
 * claiming one without a location is the kind of thing that gets a small shop's
 * markup ignored wholesale. `sameAs` carries only the social accounts the owner
 * switched on. Opening hours are deliberately absent; see the file header.
 */
function shopNode({ shopConfig, lang, id, url, name, logo }) {
  const address = bilingual(shopConfig.contact?.address, lang);
  const social = (shopConfig.social || []).map((entry) => entry.url).filter(Boolean);
  const node = {
    '@type': address ? 'Store' : 'Organization',
    '@id': id,
    name,
    url,
    description: bilingual(shopConfig.branding?.metaDescription, lang)
      || bilingual(shopConfig.branding?.about, lang) || undefined,
    logo: logo || undefined,
    image: logo || undefined,
    telephone: shopConfig.contact?.phone || undefined,
    email: shopConfig.contact?.email || undefined,
    hasMap: shopConfig.contact?.mapUrl || undefined,
    currenciesAccepted: shopConfig.currency || undefined,
    sameAs: social.length ? social : undefined,
  };
  if (address) {
    node.address = { '@type': 'PostalAddress', streetAddress: address, addressCountry: 'EG' };
  }
  return node;
}

/** The offer on a product page, and nothing that is not on the page. */
function offerFor({ product, shopConfig, url }) {
  const currency = shopConfig.currency || 'EGP';
  const availability = AVAILABILITY[product.availability] || AVAILABILITY.out;
  const delivery = shopConfig.delivery || {};
  const base = {
    priceCurrency: currency,
    availability,
    url,
    // A flat fee to every governorate is a fact this shop states on its own
    // product pages. A percentage of the basket cannot be expressed as a
    // shipping rate without inventing a basket, so in that mode nothing is
    // claimed at all.
    ...(delivery.mode !== 'percent' && Number(delivery.fee) >= 0 ? {
      shippingDetails: {
        '@type': 'OfferShippingDetails',
        shippingRate: { '@type': 'MonetaryAmount', value: Number(delivery.fee) || 0, currency },
        shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'EG' },
      },
    } : {}),
  };

  const from = Number(product.price_from);
  const to = Number(product.price_to);
  if (Number.isFinite(from) && Number.isFinite(to) && to !== from) {
    return {
      '@type': 'AggregateOffer', lowPrice: from, highPrice: to, offerCount: (product.variants || []).length || 1, ...base,
    };
  }
  return { '@type': 'Offer', price: Number.isFinite(from) ? from : 0, ...base };
}

function breadcrumb({ items }) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((entry, index) => ({
      '@type': 'ListItem', position: index + 1, name: entry.name, item: entry.url,
    })),
  };
}

/**
 * The whole `@graph` for one page. Never a rating, never a review — see the
 * file header, and do not add one because a competitor's markup has them.
 */
function structuredData({
  route, data, page, lang, links, prefix, base, root,
}) {
  const { shopConfig, categories, product } = data;
  const shopId = `${links.canonicalHome}#shop`;
  const graph = [shopNode({
    shopConfig, lang, id: shopId, url: links.canonicalHome, name: page.name, logo: page.logo,
  })];

  if (route.name === 'home') {
    graph.push({
      '@type': 'WebSite',
      '@id': `${links.canonicalHome}#site`,
      url: links.canonicalHome,
      name: page.name,
      inLanguage: lang,
      publisher: { '@id': shopId },
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${new URL(`${root}/search`, base).href}?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    });
    return graph;
  }

  const home = { name: translate(lang, 'home'), url: links.canonicalHome };

  if (route.name === 'product' && product) {
    const productName = pickIn(lang, product, 'name');
    const category = categories.find((entry) => entry.id === product.category_id);
    /*
     * The trail a crawler is given is the trail that is DRAWN on the page —
     * `crumbs()` in public/shop/js/views/product.js, which is Home / <brand>.
     * Structured data that describes a navigation the visitor cannot see is
     * the kind of small untruth that gets a site's markup ignored wholesale,
     * and the shop's own category is already on the `Product` below where it
     * belongs.
     */
    const trail = [home];
    const brandName = pickIn(lang, product, 'brand_name');
    if (product.brand_id && brandName) {
      trail.push({
        name: brandName,
        url: withLanguage(
          new URL(shopUrl(root, 'brand', { id: product.brand_id, slug: slugFor(product, 'brand_name') }), base).href,
          lang,
        ),
      });
    }
    trail.push({ name: productName, url: links.canonical });

    graph.push({
      '@type': 'Product',
      '@id': `${links.canonical}#product`,
      name: productName,
      description: summarise(pickIn(lang, product, 'description'), 400) || undefined,
      image: (product.images || []).length
        ? product.images.map((image) => new URL(`${prefix}/api/shop/images/${image.id}`, base).href)
        : (page.image ? [page.image] : undefined),
      brand: pickIn(lang, product, 'brand_name')
        ? { '@type': 'Brand', name: pickIn(lang, product, 'brand_name') }
        : undefined,
      category: category ? pickIn(lang, category, 'name') : undefined,
      inLanguage: lang,
      offers: offerFor({ product, shopConfig, url: links.canonical }),
      seller: { '@id': shopId },
    });
    graph.push(breadcrumb({ items: trail }));
    return graph;
  }

  if (['category', 'brand', 'products', 'contact'].includes(route.name)) {
    // A `CollectionPage` and nothing more. No `BreadcrumbList`: these pages
    // draw a heading, not a trail, and describing a navigation nobody can see
    // is exactly the kind of small untruth that costs a site its rich results.
    graph.push({
      '@type': 'CollectionPage',
      '@id': `${links.canonical}#page`,
      url: links.canonical,
      name: page.heading || page.title,
      inLanguage: lang,
      isPartOf: { '@id': `${links.canonicalHome}#site` },
      about: { '@id': shopId },
    });
  }
  return graph;
}

// --------------------------------------------------------------- boot payload

/**
 * The three answers the storefront used to open every visit by asking for.
 *
 * They are already in hand — the head above was rendered out of them — so
 * sending them down inside the HTML costs a few kilobytes of a response that
 * was going to be sent anyway, and saves a phone on a 3G connection a full
 * round trip before it can paint anything but the boot mark. On a product page
 * the product rides along too, which is a second round trip saved on the one
 * page a customer actually decides on.
 *
 * `core/boot.js` uses it once and then forgets it; every later navigation calls
 * the API exactly as before. That is why the shell is `no-store`: this payload
 * contains prices and stock, which are only true at the moment they are given.
 */
function bootPayload({ data, route, lang }) {
  return {
    lang,
    config: data.shopConfig,
    categories: data.categories,
    brands: data.brands,
    ...(route.name === 'product' && data.product
      ? { product: { id: route.id, data: data.product } }
      : {}),
  };
}

// -------------------------------------------------------------------- render

/**
 * The head block, for one page of one shop in one language.
 *
 * `canonical` is the address this page would like to be known by; a request
 * that arrived with the wrong slug, with `?lang=ar` spelled out, or with a sort
 * order on it still renders, and still points at the one clean address. The
 * two `hreflang` lines are reciprocal — each language names both, and both name
 * the same pair — because a one-way `hreflang` is worse than none at all.
 */
function headBlock({
  page, links, lang, shopConfig, jsonLd,
}) {
  const branding = shopConfig.branding || {};
  const mark = markFor(branding, lang);
  const icon = mark.kind === 'logo'
    ? links.logoHref
    : monogramFavicon(mark.text || page.name, { accent: branding.accent, dark: branding.dark !== false });
  const iconType = mark.kind === 'logo' ? '' : ' type="image/svg+xml"';

  const parts = [
    `<title>${escape(page.title)}</title>`,
    meta('description', page.description),
    `<link rel="canonical" href="${escape(links.canonical)}">`,
    `<link rel="alternate" hreflang="ar" href="${escape(links.ar)}">`,
    `<link rel="alternate" hreflang="en" href="${escape(links.en)}">`,
    `<link rel="alternate" hreflang="x-default" href="${escape(links.ar)}">`,
    meta('robots', page.indexable
      ? 'index, follow, max-image-preview:large, max-snippet:-1'
      : 'noindex, follow'),
    og('og:type', page.ogType || 'website'),
    og('og:site_name', page.name),
    og('og:title', page.title),
    og('og:description', page.description),
    og('og:url', links.canonical),
    og('og:locale', lang === 'ar' ? 'ar_EG' : 'en_US'),
    og('og:locale:alternate', lang === 'ar' ? 'en_US' : 'ar_EG'),
    page.image ? og('og:image', page.image) : '',
    page.image ? og('og:image:alt', page.imageAlt || page.name) : '',
    meta('twitter:card', page.image ? 'summary_large_image' : 'summary'),
    meta('twitter:title', page.title),
    meta('twitter:description', page.description),
    page.image ? meta('twitter:image', page.image) : '',
    meta('theme-color', chromeColor(branding.dark !== false, branding.accent)),
    `<link rel="icon"${iconType} href="${escape(icon)}">`,
    `<script type="application/ld+json">${jsonScript({ '@context': 'https://schema.org', '@graph': jsonLd })}</script>`,
  ];
  return parts.filter(Boolean).join('\n  ');
}

/**
 * Render one storefront page.
 *
 * `req` is only ever asked for the address the visitor typed — see
 * platform/links.js. Nothing here reads a cookie, a session or a language
 * header: the same URL must produce the same bytes for everybody, or the
 * canonical and the `hreflang` beside it are describing a page that does not
 * exist.
 */
export async function renderPage({
  req, root, prefix, segments, query = {},
}) {
  const lang = languageFrom(query[LANG_PARAM]);
  const base = publicBaseUrl(req) || `https://${req?.headers?.host || 'localhost'}`;
  const route = routeFor(segments);
  const data = await gather(route);

  // The canonical address of this page: its own route, its own slug, and the
  // language marker only where the language is not the shop's default.
  const slugSource = route.name === 'product' ? data.product
    : route.name === 'category' ? data.categories.find((row) => row.id === route.id)
      : route.name === 'brand' ? data.brands.find((row) => row.id === route.id)
        : null;
  const cleanPath = shopUrl(root, route.name === 'notFound' ? 'home' : route.name, {
    id: route.id,
    slug: slugSource ? slugFor(slugSource) : '',
  });
  const absolute = new URL(cleanPath, base).href;
  const homeAbsolute = new URL(root, base).href;

  /**
   * What survives into the canonical address: the PAGE, and nothing else.
   *
   * Page 2 of a shelf is a different set of products and deserves an address of
   * its own. The same shelf ordered by price is the same products in a
   * different order, and three spellings of one shelf competing with each other
   * in an index is how a small shop's crawl budget gets spent on itself. So
   * `?sort=` is dropped and `?page=` is kept — which is exactly what
   * `views/listing.js` does when it takes the head over in the browser, because
   * the two must agree or the page would change its mind about its own address
   * the moment the script ran.
   */
  const paged = ['products', 'category', 'brand'].includes(route.name)
    && /^[1-9]\d{0,4}$/.test(String(query.page || ''))
    && Number(query.page) > 1;
  const keepQuery = paged ? `page=${Number(query.page)}` : '';

  const links = {
    canonical: withLanguage(absolute, lang, { keepQuery }),
    ar: withLanguage(absolute, 'ar', { keepQuery }),
    en: withLanguage(absolute, 'en', { keepQuery }),
    canonicalHome: withLanguage(homeAbsolute, lang),
    logoHref: data.shopConfig.branding?.logo
      ? new URL(`${prefix}${data.shopConfig.branding.logo}`, base).href
      : '',
  };

  const page = describe({
    route, data, lang, links, prefix, base,
  });
  const jsonLd = page.indexable
    ? structuredData({
      route, data, page, lang, links, prefix, base, root,
    })
    : [];

  const head = headBlock({
    page, links, lang, shopConfig: data.shopConfig, jsonLd,
  });
  const boot = `<script type="application/json" id="mm-boot">${jsonScript(bootPayload({ data, route, lang }))}</script>`;

  const { head: before, tail: after } = shell();
  const opening = lang === DEFAULT_LANG ? before : before.replace(HTML_TAG, '<html lang="en" dir="ltr">');
  return {
    status: page.status || 200,
    html: `${opening}${head}\n  ${boot}${after}`,
  };
}

export default { renderPage, routeFor, forgetShell };
