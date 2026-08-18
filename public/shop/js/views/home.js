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

  return el('section.hero', { class: image ? 'has-image' : '' },
    photo,
    image && el('div.hero-overlay', { style: `--hero-overlay: ${overlay / 100}` }),
    el('div.hero-frame',
      el('div.wrap.hero-inner',
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
