/**
 * Storefront entry point.
 *
 * Vanilla ES modules, no build step, no dependencies — the same constraint the
 * ERP works under, for the same reason: this has to be deployable by copying a
 * folder, and debuggable by reading the file the browser actually loaded.
 */
import { el, fill } from './core/dom.js';
import { api } from './core/api.js';
import { applyDocumentLanguage, onLanguageChange, t } from './core/i18n.js';
import { setConfig, shop, isOpen } from './core/store.js';
import { defineRoutes, start, render, href } from './core/router.js';
import { setPageMeta } from './core/seo.js';
import * as cart from './core/cart.js';
import { buildHeader, buildFooter, refreshCartCount, syncSearchInput, syncNav } from './ui/layout.js';
import { errorState, closedState, emptyState } from './ui/states.js';

import homeView from './views/home.js';
import { listingView } from './views/listing.js';
import productView from './views/product.js';
import cartView from './views/cart.js';
import checkoutView from './views/checkout.js';
import successView from './views/success.js';
import trackView from './views/track.js';
import contactView from './views/contact.js';

const headerSlot = el('div');
const main = el('main#main.site-main', { tabindex: '-1' });
const footerSlot = el('div');

function paintShell() {
  fill(headerSlot, buildHeader());
  fill(footerSlot, buildFooter());
  refreshCartCount();
  syncSearchInput();
  syncNav(headerSlot);
}

/**
 * Every page shows the same closed notice when the shop is switched off in the
 * ERP. It is checked here, once, rather than in each view — a route that forgot
 * to ask would happily serve the catalogue of a shop that is meant to be shut.
 */
function closedRoute(root) {
  setPageMeta({ title: t('closedTitle'), description: t('closedBody') });
  root.append(el('div.wrap.stack', closedState(shop.config?.whatsapp)));
}

function notFoundRoute(root) {
  setPageMeta({ title: t('notFoundTitle') });
  root.append(el('div.wrap.stack', emptyState({
    title: t('notFoundTitle'),
    body: t('notFoundBody'),
    action: el('a.btn.btn-primary', { href: href('') }, t('home')),
  })));
}

/** Wrap every view so one closed-shop check covers the whole site. */
const guard = (view) => (root, route) => (isOpen() ? view(root, route) : closedRoute(root, route));

async function boot() {
  applyDocumentLanguage();
  document.body.append(
    el('a.skip-link', { href: '#main' }, t('skipToContent')),
    headerSlot, main, footerSlot,
  );

  try {
    // The config decides whether there is a shop at all; the two taxonomies
    // feed the header nav and every listing heading, so one round of requests
    // covers the chrome for the whole visit.
    const [config, categories, brands] = await Promise.all([
      api.config(), api.categories(), api.brands(),
    ]);
    setConfig(config);
    shop.categories = categories.rows || [];
    shop.brands = brands.rows || [];
  } catch (error) {
    document.body.classList.remove('is-booting');
    fill(main, el('div.wrap.stack', errorState(error, () => window.location.reload())));
    return;
  }

  paintShell();
  document.body.classList.remove('is-booting');

  defineRoutes({
    '': guard(homeView),
    products: guard(listingView('all')),
    'category/:id': guard(listingView('category')),
    'brand/:id': guard(listingView('brand')),
    search: guard(listingView('search')),
    'product/:id': guard(productView),
    cart: guard(cartView),
    checkout: guard(checkoutView),
    'order/:orderNo': guard(successView),
    track: guard(trackView),
    // Not `guard()`-wrapped: a closed shop still needs a way to be reached.
    contact: contactView,
  }, {
    notFound: guard(notFoundRoute),
    onRendered: () => {
      syncSearchInput();
      syncNav(headerSlot);
    },
  });

  cart.onChange(refreshCartCount);

  // Switching language re-renders everything: the chrome, because its labels
  // changed, and the current view, because the product names on it come from a
  // different column.
  onLanguageChange(() => {
    paintShell();
    render();
  });

  // A hash change is a page change to the customer, so it behaves like one.
  window.addEventListener('hashchange', () => window.scrollTo({ top: 0, behavior: 'instant' }));

  await start(main);
}

boot();
