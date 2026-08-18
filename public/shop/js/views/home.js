/** The landing page: one request, four shelves. */
import { el, fill, chevron } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { href } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import { shop } from '../core/store.js';
import { productGrid, taxonomyTile, sectionHead } from '../ui/cards.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

function hero() {
  return el('section.hero',
    el('div.wrap.hero-inner',
      el('p.hero-eyebrow', getLanguage() === 'ar' ? 'من القاهرة' : 'From Cairo'),
      el('h1.hero-title', t('heroTagline')),
      el('p.hero-body', t('heroBody')),
      el('a.btn.btn-primary.hero-cta', { href: href('products') },
        t('heroCta'), chevron(16))));
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
