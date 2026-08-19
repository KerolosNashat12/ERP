/**
 * One view behind four routes — category, brand, search and "everything".
 *
 * They differ only in which filter goes on the request and what the heading
 * says, and keeping them as one file means the sort control, the pagination and
 * the empty state cannot drift apart between them.
 */
import { el, fill, chevron } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { href, navigate } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import { shopName } from '../core/branding.js';
import { shop } from '../core/store.js';
import { productGrid } from '../ui/cards.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

const SORTS = [
  ['newest', 'sortNewest'],
  ['price_asc', 'sortPriceAsc'],
  ['price_desc', 'sortPriceDesc'],
  ['name', 'sortName'],
];

/**
 * The listing routes carry their filter in the path and everything else in the
 * query, so `#/category/3?sort=price_asc&page=2` is a link worth sharing.
 */
function readRoute(route, kind) {
  const query = route.query || {};
  return {
    kind,
    id: route.params?.id ? Number(route.params.id) : null,
    q: kind === 'search' ? (query.q || '') : '',
    sort: SORTS.some(([value]) => value === query.sort) ? query.sort : 'newest',
    page: Math.max(Number(query.page) || 1, 1),
  };
}

const buildHref = (state, changes = {}) => {
  const next = { ...state, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.sort && next.sort !== 'newest') params.set('sort', next.sort);
  if (next.page > 1) params.set('page', String(next.page));
  const base = next.kind === 'category' ? `category/${next.id}`
    : next.kind === 'brand' ? `brand/${next.id}`
      : next.kind === 'search' ? 'search' : 'products';
  const query = params.toString();
  return href(query ? `${base}?${query}` : base);
};

/**
 * The heading. Category and brand names are not in the products response, so
 * they come from the lists cached at boot — no extra round trip for a title.
 */
function headingFor(state) {
  if (state.kind === 'search') return state.q ? t('resultsFor', state.q) : t('allProducts');
  if (state.kind === 'category') {
    const row = shop.categories.find((entry) => entry.id === state.id);
    return row ? pick(row, 'name') : t('allProducts');
  }
  if (state.kind === 'brand') {
    const row = shop.brands.find((entry) => entry.id === state.id);
    return row ? pick(row, 'name') : t('allProducts');
  }
  return t('allProducts');
}

function sortControl(state) {
  const select = el('select.select', {
    id: 'sort',
    onChange: (event) => navigate(buildHref(state, { sort: event.target.value, page: 1 })),
  }, SORTS.map(([value, key]) => el('option', { value, selected: value === state.sort }, t(key))));
  return el('div.sort',
    el('label.sort-label', { for: 'sort' }, t('sortBy')),
    select);
}

function pagination(state, result) {
  if (result.pages <= 1) return null;
  const prev = result.page > 1
    ? el('a.btn.btn-ghost.btn-back', { href: buildHref(state, { page: result.page - 1 }) },
      t('previous'))
    : el('span.btn.btn-ghost.is-disabled', { 'aria-disabled': 'true' }, t('previous'));
  const next = result.page < result.pages
    ? el('a.btn.btn-ghost', { href: buildHref(state, { page: result.page + 1 }) },
      t('next'), chevron(15))
    : el('span.btn.btn-ghost.is-disabled', { 'aria-disabled': 'true' }, t('next'));

  return el('nav.pager', { 'aria-label': t('pageOf', result.page, result.pages) },
    prev,
    el('span.pager-state', t('pageOf', result.page, result.pages)),
    next);
}

export function listingView(kind) {
  return async function render(root, route) {
    const state = readRoute(route, kind);
    const title = headingFor(state);

    // The shop's name comes from its own config, never from a literal here:
    // this same sentence used to name the first tenant on every other shop's
    // category pages.
    setPageMeta({
      title,
      description: getLanguage() === 'ar'
        ? `تصفّح ${title} في ${shopName()} — الدفع عند الاستلام في كل مصر.`
        : `Browse ${title} at ${shopName()} — cash on delivery across Egypt.`,
    });

    const head = el('div.listing-head',
      el('div',
        el('h1.page-title', title),
        el('p.page-note.muted', t('loading'))),
      sortControl(state));
    const body = el('div', skeletonGrid(8));
    root.append(el('div.wrap.stack', head, body));

    let result;
    try {
      result = await api.products({
        category: kind === 'category' ? state.id : undefined,
        brand: kind === 'brand' ? state.id : undefined,
        q: state.q || undefined,
        sort: state.sort,
        page: state.page,
      });
    } catch (error) {
      head.querySelector('.page-note').remove();
      fill(body, errorState(error, () => { root.replaceChildren(); render(root, route); }));
      return;
    }

    head.querySelector('.page-note').textContent = t('productsFound', result.total);

    if (!result.rows.length) {
      fill(body, state.q
        ? emptyState({
          title: t('noResultsTitle'),
          body: t('noResultsBody'),
          action: el('a.btn.btn-ghost', { href: href('products') }, t('allProducts')),
        })
        : emptyState({
          title: t('nothingHere'),
          body: t('nothingHereBody'),
          action: el('a.btn.btn-ghost', { href: href('') }, t('home')),
        }));
      return;
    }

    fill(body, productGrid(result.rows), pagination(state, result));
  };
}
