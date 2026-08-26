/**
 * One view behind four routes — category, brand, search and "everything".
 *
 * They differ only in which filter goes on the request and what the heading
 * says, and keeping them as one file means the sort control, the pagination and
 * the empty state cannot drift apart between them.
 */
import { el, fill, chevron } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, pick } from '../core/i18n.js';
import { href, navigate } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import { setPageMeta } from '../core/seo.js';
import { shopName } from '../core/branding.js';
import { shop } from '../core/store.js';
import { productGrid } from '../ui/cards.js';
import { filterUi } from '../ui/filters.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

const SORTS = [
  ['newest', 'sortNewest'],
  ['price_asc', 'sortPriceAsc'],
  ['price_desc', 'sortPriceDesc'],
  ['discount', 'sortDiscount'],
  ['name', 'sortName'],
];

/** A comma-separated query value, back into a list. */
const listFrom = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

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
    /*
     * The filter panel's state, read straight off the address. Held here and
     * nowhere else: a shopper who narrows a shelf down and sends the link to a
     * friend must send the shelf she is looking at, and the back button has to
     * undo one choice rather than the whole session.
     */
    gender: listFrom(query.gender),
    attr: listFrom(query.attr),
    onSale: query.sale === '1',
    inStock: query.stock === '1',
    min: positive(query.min),
    max: positive(query.max),
  };
}

/** The shelf or the maker this listing is of — for its name and for its slug. */
const rowFor = (state) => (state.kind === 'category'
  ? shop.categories.find((entry) => entry.id === state.id)
  : state.kind === 'brand'
    ? shop.brands.find((entry) => entry.id === state.id)
    : null);

/** `category/3/<slug>` — the readable half of the address, without the query. */
function basePath(state) {
  if (state.kind === 'category' || state.kind === 'brand') {
    const row = rowFor(state);
    return routePath(state.kind, { id: state.id, slug: row ? slugFor(row) : '' });
  }
  return state.kind === 'search' ? 'search' : 'products';
}

const buildPath = (state, changes = {}) => {
  const next = { ...state, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.sort && next.sort !== 'newest') params.set('sort', next.sort);
  // Only what is switched ON reaches the address. A default never appears in
  // it, so an unfiltered shelf keeps the short, shareable URL it always had.
  if (next.gender?.length) params.set('gender', next.gender.join(','));
  if (next.attr?.length) params.set('attr', next.attr.join(','));
  if (next.onSale) params.set('sale', '1');
  if (next.inStock) params.set('stock', '1');
  if (next.min) params.set('min', String(next.min));
  if (next.max) params.set('max', String(next.max));
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  const base = basePath(next);
  return query ? `${base}?${query}` : base;
};

const buildHref = (state, changes = {}) => href(buildPath(state, changes));

/**
 * The heading. Category and brand names are not in the products response, so
 * they come from the lists cached at boot — no extra round trip for a title.
 */
function headingFor(state) {
  if (state.kind === 'search') return state.q ? t('resultsFor', state.q) : t('allProducts');
  const row = rowFor(state);
  if (state.kind === 'category' || state.kind === 'brand') return row ? pick(row, 'name') : t('allProducts');
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
    ? el('a.btn.btn-ghost', { href: buildHref(state, { page: result.page - 1 }) },
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

    /*
     * The shop's name comes from its own config, never from a literal here:
     * this same sentence used to name the first tenant on every other shop's
     * category pages. The sentence itself is `metaListing` in core/i18n.js, so
     * the server writes the identical one into the HTML before this runs.
     *
     * The canonical keeps the PAGE and drops the SORT. Page 2 of a shelf is a
     * different set of products and deserves its own address; the same page
     * ordered by price is the same products in a different order, and three
     * spellings of one shelf competing with each other in an index is how a
     * small shop's crawl budget gets spent on itself. A search results page is
     * not a page at all — see `indexable`.
     */
    setPageMeta({
      title,
      description: t('metaListing', title, shopName()),
      canonicalPath: buildPath(state, { sort: 'newest' }),
      indexable: kind !== 'search',
    });

    const head = el('div.listing-head',
      el('div',
        el('h1.page-title', title),
        el('p.page-note.muted', t('loading'))),
      el('div.listing-tools', sortControl(state)));
    const body = el('div', skeletonGrid(8));
    const side = el('div.listing-side');
    root.append(el('div.wrap.stack', head, el('div.listing-layout', side, body)));

    const scope = {
      category: kind === 'category' ? state.id : undefined,
      brand: kind === 'brand' ? state.id : undefined,
      q: state.q || undefined,
    };

    let result;
    let options;
    try {
      /*
       * The listing and the panel are fetched together. They are two requests
       * because they answer two different questions — what is on this page, and
       * what could be narrowed down — but they are asked at the same moment so
       * the page never paints a grid above an empty sidebar.
       *
       * The panel is allowed to fail on its own: a shop with no filters is a
       * shop that still sells things. `Promise.allSettled` rather than `all`
       * for exactly that.
       */
      const [listing, facets] = await Promise.allSettled([
        api.products({
          ...scope,
          sort: state.sort,
          page: state.page,
          gender: state.gender.length ? state.gender.join(',') : undefined,
          attr: state.attr.length ? state.attr.join(',') : undefined,
          onSale: state.onSale ? '1' : undefined,
          inStock: state.inStock ? '1' : undefined,
          minPrice: state.min || undefined,
          maxPrice: state.max || undefined,
        }),
        api.filters(scope),
      ]);
      if (listing.status === 'rejected') throw listing.reason;
      result = listing.value;
      options = facets.status === 'fulfilled' ? facets.value : null;
    } catch (error) {
      head.querySelector('.page-note').remove();
      fill(body, errorState(error, () => { root.replaceChildren(); render(root, route); }));
      return;
    }

    if (options) {
      const ui = filterUi(options, state, (nextState) => navigate(buildHref(state, nextState)));
      fill(side, ui.panel, ui.scrim);
      head.querySelector('.listing-tools').prepend(ui.toggle);
    }

    head.querySelector('.page-note').textContent = t('productsFound', result.total);

    if (!result.rows.length) {
      /*
       * Three different empties, because they need three different ways out.
       * A shopper who filtered herself into a corner wants the filters gone —
       * not a link to the home page, which reads as "give up".
       */
      const filtered = state.gender.length || state.attr.length
        || state.onSale || state.inStock || state.min || state.max;
      fill(body, filtered
        ? emptyState({
          title: t('noMatchesTitle'),
          body: t('noMatchesBody'),
          action: el('a.btn.btn-ghost', {
            href: buildHref(state, {
              gender: [], attr: [], onSale: false, inStock: false, min: null, max: null, page: 1,
            }),
          }, t('clearFilters')),
        })
        : state.q
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
