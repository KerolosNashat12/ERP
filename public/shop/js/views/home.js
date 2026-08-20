/** The landing page: one request, four shelves. */
import { el, fill, icon, chevron, ICONS } from '../core/dom.js';
import { api, assetUrl } from '../core/api.js';
import { t, pick } from '../core/i18n.js';
import { shopName, tagline, bilingual } from '../core/branding.js';
import { href } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import { shop, deliverySettings } from '../core/store.js';
import { money, number } from '../core/format.js';
import { productGrid, taxonomyTile, sectionHead } from '../ui/cards.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

/**
 * Pick the language side of a `{ en, ar }` config record — the banner's copy
 * here, the shop's own tagline and About paragraph in core/branding.js, which
 * is where the one implementation now lives.
 */
const bt = bilingual;

// `config.banner.align` is physical ('right' means the text sits on the
// right-hand side of the photo in BOTH languages), so it maps straight onto
// `justify-content` on a flex row whose own `direction` is pinned to `ltr` in
// CSS (see `.hero-frame` in shop.css) — `flex-start` there is always the true
// left, `flex-end` always the true right, independent of page language.
const ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' };
const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
// Ratios, not fixed sizes, so the existing `clamp()` viewport scaling in
// shop.css keeps doing its job at every one of the three settings.
const SIZE_SCALE = { small: 0.82, medium: 1, large: 1.18 };
// `textColor: 'dark'` is for a light or busy-but-pale photo, where dark text
// needs a LIGHT scrim to sit on, not the usual dark one — inverting the
// overlay's colour, not just the ink, is what actually keeps it readable.
const TEXT_COLOR = {
  light: {
    ink: '#ffffff', bodyInk: '#f2f3f5', scrim: '0 0 0',
    shadow: '0 2px 10px rgba(0, 0, 0, .55), 0 1px 3px rgba(0, 0, 0, .45)',
  },
  dark: {
    ink: '#15181f', bodyInk: '#262a33', scrim: '255 255 255',
    shadow: '0 2px 10px rgba(255, 255, 255, .55), 0 1px 3px rgba(255, 255, 255, .4)',
  },
};

/**
 * The hero is one fixed-size box (16:5 on desktop, 4:3 on a phone — see
 * `.hero` in shop.css) whichever shop opens it: a shop with a banner photo
 * gets that photo `cover`-cropped into the box; a shop that has not uploaded
 * one yet gets the same box filled with the original gradient/monogram
 * design, so "nothing configured" still reads as a finished page, not a
 * missing one.
 */
function hero() {
  const banner = shop.config?.banner || {};
  // What a shop that has uploaded no banner says on its own front page: its
  // banner heading, then its tagline, then a neutral line. Never a sentence
  // naming a product category — see `heroTagline` in core/i18n.js.
  const heading = bt(banner.heading) || tagline() || t('heroTagline');
  const body = bt(banner.text) || t('heroBody');
  const cta = banner.cta && bt(banner.cta.label) && banner.cta.link
    ? { label: bt(banner.cta.label), href: href(banner.cta.link) }
    : null;
  const overlay = Number.isFinite(Number(banner.overlay)) ? Number(banner.overlay) : 35;
  // Prefixed with this tenant's own path: `/api/shop/banner` from the server
  // is prefix-agnostic, and unprefixed it would fetch the default shop's.
  const image = assetUrl(banner.image);

  const align = ALIGN[banner.align] || ALIGN.right;
  const valign = VALIGN[banner.valign] || VALIGN.middle;
  const scale = SIZE_SCALE[banner.size] || SIZE_SCALE.medium;
  const boxWidthRaw = Number(banner.boxWidth);
  const boxWidth = Number.isFinite(boxWidthRaw) ? Math.min(Math.max(boxWidthRaw, 30), 100) : 45;
  const colors = TEXT_COLOR[banner.textColor] || TEXT_COLOR.light;

  // One `style` string of custom properties rather than a class per
  // align×valign×size×color×width combination — shop.css has one generic
  // ruleset that reads all five, so this is the only place any of them is
  // decided.
  const heroStyle = [
    `--hero-align: ${align}`,
    `--hero-valign: ${valign}`,
    `--hero-scale: ${scale}`,
    `--hero-box-width: ${boxWidth}%`,
    `--hero-ink: ${colors.ink}`,
    `--hero-body-ink: ${colors.bodyInk}`,
    `--hero-scrim: ${colors.scrim}`,
    `--hero-text-shadow: ${colors.shadow}`,
  ].join('; ');

  const photo = image && el('img.hero-photo', {
    src: image,
    alt: '',
    loading: 'eager',
    decoding: 'async',
    // A banner row can exist with `hasImage` stale for a moment after an ERP
    // delete; falling back to the gradient beats a broken-image glyph on the
    // storefront's most visible pixel.
    onError: (event) => { event.currentTarget.closest('.hero')?.classList.remove('has-image'); event.currentTarget.remove(); },
  });

  return el('section.hero', { class: image ? 'has-image' : '', style: heroStyle },
    photo,
    image && el('div.hero-overlay', { style: `--hero-overlay: ${overlay / 100}` }),
    el('div.hero-frame',
      el('div.hero-inner',
        // The shop's own name, above its own heading — the eyebrow used to
        // read "From Cairo", which is a claim only one shop had made.
        !image && el('p.hero-eyebrow', shopName()),
        el('h1.hero-title', heading),
        el('p.hero-body', body),
        // The design's two-button rhythm, and only where it can be trusted to
        // read: over the shop's OWN gradient, where this file knows what the
        // ink is. Over an uploaded photograph the banner keeps exactly the one
        // configured button it has always had — an outline button whose colour
        // this file chose could land white-on-white on somebody's photo.
        (cta || !image) && el('div.hero-actions',
          cta && el('a.btn.btn-primary', { href: cta.href }, cta.label, chevron(16)),
          !image && el('a.btn.btn-outline', { href: href('products') }, t('heroCta'))))));
}

/**
 * What this shop actually charges to deliver, in one sentence.
 *
 * Every shape here exists because it is a different promise: a flat fee, a
 * percentage, and a percentage with a floor and/or a cap are four things a
 * customer would plan differently around. Nothing is concatenated — the
 * sentences live in core/i18n.js in both languages, and the money goes
 * through core/format.js so it carries this shop's own currency.
 */
function deliveryPromise(delivery) {
  if (delivery.mode === 'percent' && delivery.percent > 0) {
    const percent = number(delivery.percent);
    if (delivery.min !== null && delivery.max !== null) {
      return t('trustDeliveryPercentMinMax', percent, money(delivery.min), money(delivery.max));
    }
    if (delivery.min !== null) return t('trustDeliveryPercentMin', percent, money(delivery.min));
    if (delivery.max !== null) return t('trustDeliveryPercentMax', percent, money(delivery.max));
    return t('trustDeliveryPercent', percent);
  }
  /*
   * One fixed amount, whatever the basket. That is a flat fee — and it is also
   * what "0% of your order, minimum 50" comes out as, so it is worded the same
   * way rather than told as a percentage that would always be wrong.
   *
   * A shop that charges nothing says so. "Delivery 0 to every governorate" is
   * a price tag on something that is free, and it reads as a bug.
   */
  const flat = delivery.mode === 'percent' ? (delivery.min || 0) : delivery.fee;
  return t('trustDeliveryFlat', flat > 0 ? money(flat) : t('free'));
}

/**
 * The three promises under the shelves. Real numbers or nothing: the free
 * delivery card only exists for a shop that has actually set a threshold.
 */
function trustRow() {
  const delivery = deliverySettings();
  const card = (glyph, title, note) => el('div.trust-card',
    el('span.trust-icon', icon(glyph, { size: 24 })),
    el('h3.trust-title', title),
    el('p.trust-note', note));

  return el('section.section',
    el('div.trust-row',
      card(ICONS.truck, t('trustDeliveryTitle'), deliveryPromise(delivery)),
      card(ICONS.wallet, t('trustCodTitle'), t('trustCodNote')),
      delivery.freeOver !== null
        && card(ICONS.gift, t('trustFreeTitle'), t('trustFreeNote', money(delivery.freeOver)))));
}

export default async function homeView(root) {
  // No description of its own: the home page IS the shop, so the shop's own
  // meta description (`config.branding`, resolved server-side) is the right
  // one, and `setPageMeta` falls back to it.
  setPageMeta({});

  const shelves = el('div.wrap.stack');
  // The banner is a rounded block inside the page's column, not a full-bleed
  // strip — see `.hero-wrap` in shop.css.
  root.append(el('div.wrap.hero-wrap', hero()), shelves);
  fill(shelves, el('div.section', skeletonGrid(4)), el('div.section', skeletonGrid(8)));

  let data;
  try {
    data = await api.home();
  } catch (error) {
    fill(shelves, errorState(error, () => homeView(fill(root))));
    return;
  }

  const { newest = [], featured = [], categories = [], brands = [], featuredFromSales = false } = data;
  shop.categories = categories;
  shop.brands = brands;

  const sections = [];

  if (categories.length) {
    sections.push(el('section.section',
      sectionHead(t('shopByCategory')),
      el('div.tiles', categories.map((row) => taxonomyTile(row, 'category')))));
  }

  // The white band. The design alternates paper and white full-bleed bands
  // down the page, and the brands and the best sellers are the white ones.
  if (brands.length) {
    sections.push(el('section.section.section-band',
      sectionHead(t('ourBrands')),
      el('div.brand-strip', brands.map((row) => el('a.brand-pill',
        { href: href(`brand/${row.id}`) }, pick(row, 'name'))))));
  }

  if (newest.length) {
    sections.push(el('section.section',
      sectionHead(t('newArrivals'), t('newArrivalsNote'),
        { href: href('products?sort=newest'), label: t('viewAll') }),
      productGrid(newest)));
  }

  /*
   * Best sellers is the shop's own sales record, topped up with new arrivals
   * so a quiet week does not leave a gap. `featuredFromSales` is the API
   * saying whether there is any sales record in there at all.
   *
   * With one — the owner asked for this shelf and it is telling the truth, so
   * it always shows, on its own white band. Without one, the shelf is made
   * entirely of the newest arrivals, and printing "الأكثر مبيعًا" over the
   * eight products that are already on the shelf above would be a brand-new
   * shop lying about what its customers bought. So the old dedupe stands and
   * the shelf disappears when it would only repeat itself.
   */
  const sameAsNewest = featured.length
    && featured.every((card, index) => card.id === newest[index]?.id);
  if (featured.length && (featuredFromSales || !sameAsNewest)) {
    sections.push(el('section.section.section-band',
      sectionHead(t('bestSellers'), t('bestSellersNote'),
        { href: href('products'), label: t('viewAll') }),
      productGrid(featured, { eagerCount: 0 })));
  }

  if (!sections.length) {
    fill(shelves, emptyState({ title: t('nothingHere'), body: t('nothingHereBody') }));
    return;
  }
  // The trust row closes the page, under whatever shelves the shop has.
  sections.push(trustRow());
  fill(shelves, sections);
}
