/**
 * Storefront entry point.
 *
 * Vanilla ES modules, no build step, no dependencies — the same constraint the
 * ERP works under, for the same reason: this has to be deployable by copying a
 * folder, and debuggable by reading the file the browser actually loaded.
 */
import { el, fill } from './core/dom.js';
import { api } from './core/api.js';
import {
  applyDocumentLanguage, onLanguageChange, t, getLanguage, setLanguage,
} from './core/i18n.js';
import { setConfig, shop, isOpen } from './core/store.js';
import {
  defineRoutes, start, render, href, currentRoute, canonicalise,
} from './core/router.js';
import { setPageMeta, dropServerStructuredData } from './core/seo.js';
import { takeShell } from './core/boot.js';
import { LANG_PARAM, languageFrom } from '../../shared/shopUrls.js';
import { applyBranding, applyFavicon } from './core/branding.js';
import { applyDeploymentBanner } from '../../shared/deploymentBanner.js';
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
import favoritesView from './views/favorites.js';

const showDeployment = (deployment) => applyDeploymentBanner(deployment, {
  label: t('stagingTag'),
  detail: t('stagingHere'),
  wide: true,
  lang: getLanguage(),
});

/** True until the page the customer actually landed on has been drawn once. */
let landed = true;

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
  // A shop on a break is not a catalogue. The server says the same thing about
  // the same page, and takes its sitemap away for as long as it lasts.
  setPageMeta({ title: t('closedTitle'), description: t('closedBody'), indexable: false });
  root.append(el('div.wrap.stack', closedState(shop.config?.whatsapp)));
}

function notFoundRoute(root) {
  setPageMeta({ title: t('notFoundTitle'), indexable: false });
  root.append(el('div.wrap.stack', emptyState({
    title: t('notFoundTitle'),
    body: t('notFoundBody'),
    action: el('a.btn.btn-primary', { href: href('') }, t('home')),
  })));
}

/** Wrap every view so one closed-shop check covers the whole site. */
const guard = (view) => (root, route) => (isOpen() ? view(root, route) : closedRoute(root, route));

/**
 * The address decides the language, and only then the browser's memory of it.
 *
 * The bare address serves Arabic and `?lang=en` serves English — that is what
 * the `hreflang` pair in the head declares, and the server rendered this
 * document accordingly. A customer who followed an English link must therefore
 * be reading English whatever this browser remembers, or the page would say one
 * thing in its head and another on the screen.
 */
function adoptLanguageFromUrl() {
  const asked = new URLSearchParams(window.location.search).get(LANG_PARAM);
  if (asked) setLanguage(languageFrom(asked));
}

/**
 * Put the language back in the address after it changes, without adding a
 * history entry. So the URL a customer copies out of the bar opens in the
 * language they were reading, and matches the canonical in the head.
 */
function syncLanguageInUrl() {
  const route = currentRoute();
  const params = new URLSearchParams(window.location.search);
  params.delete(LANG_PARAM);
  const rest = params.toString();
  canonicalise(href(rest ? `${route.path}?${rest}` : route.path));
}

async function boot() {
  adoptLanguageFromUrl();
  applyDocumentLanguage();
  document.body.append(
    el('a.skip-link', { href: '#main' }, t('skipToContent')),
    headerSlot, main, footerSlot,
  );

  try {
    /*
     * The config decides whether there is a shop at all; the two taxonomies
     * feed the header nav and every listing heading, so this covers the chrome
     * for the whole visit.
     *
     * The server has already read all three in order to write this page's head,
     * and sent them down inside the HTML — see core/boot.js. Asking for them
     * again would be a round trip a phone on Egyptian mobile data pays for
     * nothing; measured on a 400 Kbps / 400 ms connection it is most of half a
     * second before a product is on the screen. Absent or unreadable, the shop
     * asks for them, exactly as it always did.
     */
    const embedded = takeShell();
    const [config, categories, brands] = embedded
      ? [embedded.config, { rows: embedded.categories }, { rows: embedded.brands }]
      : await Promise.all([api.config(), api.categories(), api.brands()]);
    setConfig(config);
    /**
     * A staging storefront quietly taking real customer orders is the whole
     * reason this exists, so the warning is drawn from the same response that
     * decides whether there is a shop here at all — never a frame later, never
     * a page that looks real for a moment first.
     *
     * `wide` gives this one a bar along the bottom edge rather than a corner
     * tag: a customer is being told not to place an order, which needs a
     * sentence. Still fixed and still un-clickable, so nothing on the page
     * moves and the checkout button is exactly as reachable as before.
     */
    showDeployment(config.deployment);
    shop.categories = categories.rows || [];
    shop.brands = brands.rows || [];
    // Before the first paint of anything but the boot screen: the accent, the
    // mode, the monogram and the tab icon are all one shop's, and they are all
    // set once here rather than component by component.
    applyBranding();
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
    // The slug is optional on all three: a link that arrived without it — an
    // old `#/product/12`, a URL somebody trimmed — is the same page, and the
    // canonical in the head says which spelling is the real one.
    'category/:id/:slug?': guard(listingView('category')),
    'brand/:id/:slug?': guard(listingView('brand')),
    search: guard(listingView('search')),
    'product/:id/:slug?': guard(productView),
    // The header has linked here since the hearts landed; this is the page.
    // Guarded like every other catalogue route — the list is a list of this
    // shop's products, and a shop switched off in the ERP serves none of them.
    favorites: guard(favoritesView),
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
      if (landed) {
        landed = false;
        return;
      }
      // Everything past the first paint is a page change to the customer, so it
      // behaves like one — and the structured data the server wrote for the
      // page they ARRIVED on is taken down rather than left describing a page
      // that is no longer on the screen.
      dropServerStructuredData();
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
  });

  cart.onChange(refreshCartCount);

  // Switching language re-renders everything: the chrome, because its labels
  // changed, and the current view, because the product names on it come from a
  // different column.
  onLanguageChange(() => {
    // The address changes with the language, so a copied link opens in the
    // language it was copied from and matches the canonical in the head.
    syncLanguageInUrl();
    // The storefront switches language in place rather than reloading, so the
    // warning has to change language with everything else on the page.
    showDeployment(shop.config?.deployment);
    paintShell();
    // A monogram is script-dependent — `ح ب` in Arabic, two Latin initials in
    // English — so the mark in the tab changes with the language, exactly as
    // the one in the header does.
    applyFavicon();
    render();
  });

  await start(main);
  // A returning customer whose browser remembers English landed on the bare
  // (Arabic) address. Now that the page is up, the address says so too.
  syncLanguageInUrl();
}

boot();
