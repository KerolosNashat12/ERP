/** The landing page: one request, four shelves. */
import { el, fill, chevron } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { href } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import { shop } from '../core/store.js';
import { productGrid, taxonomyTile, sectionHead } from '../ui/cards.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

/**
 * Pick the language side of a `{ en, ar }` config record. Falls back to the
 * other language rather than blanking, same rule `pick()` applies to a row —
 * a shop owner who only wrote the Arabic banner copy still gets a banner.
 */
const bt = (record) => {
  if (!record) return '';
  const wanted = getLanguage() === 'ar' ? record.ar : record.en;
  const other = getLanguage() === 'ar' ? record.en : record.ar;
  return (wanted && String(wanted).trim()) || (other && String(other).trim()) || '';
};

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
  const heading = bt(banner.heading) || t('heroTagline');
  const body = bt(banner.text) || t('heroBody');
  const cta = banner.cta && bt(banner.cta.label) && banner.cta.link
    ? { label: bt(banner.cta.label), href: href(banner.cta.link) }
    : null;
  const overlay = Number.isFinite(Number(banner.overlay)) ? Number(banner.overlay) : 35;
  const image = banner.image || null;

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
        !image && el('p.hero-eyebrow', getLanguage() === 'ar' ? 'من القاهرة' : 'From Cairo'),
        el('h1.hero-title', heading),
        el('p.hero-body', body),
        cta && el('a.btn.btn-primary.hero-cta', { href: cta.href }, cta.label, chevron(16)))));
}

export default async function homeView(root) {
  setPageMeta({
    description: getLanguage() === 'ar'
      ? 'شنط وعطور ومجوهرات مختارة — الدفع عند الاستلام والتوصيل لكل محافظات مصر.'
      : 'Handbags, perfume and jewellery, chosen piece by piece. Cash on delivery across Egypt.',
  });

  const shelves = el('div.wrap.stack');
  root.append(hero(), shelves);
  fill(shelves, el('div.section', skeletonGrid(4)), el('div.section', skeletonGrid(8)));

  let data;
  try {
    data = await api.home();
  } catch (error) {
    fill(shelves, errorState(error, () => homeView(fill(root))));
    return;
  }

  const { newest = [], featured = [], categories = [], brands = [] } = data;
  shop.categories = categories;
  shop.brands = brands;

  const sections = [];

  if (categories.length) {
    sections.push(el('section.section',
      sectionHead(t('shopByCategory')),
      el('div.tiles', categories.map((row) => taxonomyTile(row, 'category')))));
  }

  if (brands.length) {
    sections.push(el('section.section',
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

  // Best sellers is the shop's own sales record, so on a quiet week the API
  // tops it up with new arrivals. If that makes it identical to the shelf
  // above, showing it twice is just noise — so it is dropped.
  const sameAsNewest = featured.length
    && featured.every((card, index) => card.id === newest[index]?.id);
  if (featured.length && !sameAsNewest) {
    sections.push(el('section.section',
      sectionHead(t('bestSellers'), t('bestSellersNote'),
        { href: href('products'), label: t('viewAll') }),
      productGrid(featured, { eagerCount: 0 })));
  }

  if (!sections.length) {
    fill(shelves, emptyState({ title: t('nothingHere'), body: t('nothingHereBody') }));
    return;
  }
  fill(shelves, sections);
}
