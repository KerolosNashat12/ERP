/**
 * The shell every page sits inside: announcement bar, header, category nav and
 * footer. Built once on boot and then patched in place — the cart count and the
 * language are the only things that change, and rebuilding the header on every
 * route would throw away the search box the customer is typing into.
 */
import { el, icon, ICONS } from '../core/dom.js';
import { t, pick, getLanguage, setLanguage } from '../core/i18n.js';
import { shop, isOpen } from '../core/store.js';
import { href, navigate, parseHash } from '../core/router.js';
import * as cart from '../core/cart.js';

let cartCountNode = null;
let searchInput = null;

const shopName = () => (getLanguage() === 'ar'
  ? (shop.config?.companyName?.ar || 'إم آند إم للإكسسوارات')
  : (shop.config?.companyName?.en || 'M&M Accessories'));

const whatsappHref = () => {
  const digits = String(shop.config?.whatsapp || '').replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}` : null;
};

// One glyph per network the ERP can switch on. `config.social` already comes
// pre-filtered to enabled + non-empty rows, so anything unrecognised here is
// simply skipped rather than shown as a blank square.
const SOCIAL_ICON = {
  facebook: ICONS.facebook,
  instagram: ICONS.instagram,
  tiktok: ICONS.tiktok,
  youtube: ICONS.youtube,
  whatsapp: ICONS.whatsapp,
  x: ICONS.x,
};
// Brand names, not translated — a shop's Arabic footer still says "Facebook".
const SOCIAL_LABEL = {
  facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok',
  youtube: 'YouTube', whatsapp: 'WhatsApp', x: 'X',
};

/** Icon links to whatever the shop has switched on — nothing when none has. */
function socialLinks() {
  const rows = (shop.config?.social || []).filter((row) => row.url && SOCIAL_ICON[row.network]);
  if (!rows.length) return null;
  return el('div.social-links', { 'aria-label': t('followUs') },
    rows.map((row) => el('a.social-link', {
      href: row.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': SOCIAL_LABEL[row.network],
    }, icon(SOCIAL_ICON[row.network], { size: 17 }))));
}

/** The announcement is optional and bilingual; an empty one takes no space. */
function announcementBar() {
  const text = getLanguage() === 'ar'
    ? shop.config?.announcement?.ar
    : shop.config?.announcement?.en;
  const fallback = shop.config?.announcement?.en || shop.config?.announcement?.ar;
  const message = (text && text.trim()) || (fallback && fallback.trim());
  if (!message || !isOpen()) return null;
  return el('div.announce', el('div.wrap', el('p', message)));
}

function searchForm() {
  const input = el('input.search-input', {
    type: 'search',
    name: 'q',
    'aria-label': t('search'),
    placeholder: t('searchPlaceholder'),
    autocomplete: 'off',
    value: parseHash().query.q || '',
  });
  searchInput = input;

  return el('form.search', {
    role: 'search',
    onSubmit: (event) => {
      event.preventDefault();
      const term = input.value.trim();
      // An empty search is a request to see everything, not an error.
      navigate(term ? `search?q=${encodeURIComponent(term)}` : 'products');
      input.blur();
    },
  },
  el('button.search-go', { type: 'submit', 'aria-label': t('search') }, icon(ICONS.search, { size: 18 })),
  input);
}

function languageToggle() {
  return el('button.icon-btn.lang-btn', {
    type: 'button',
    // The label is the language you would switch TO, which is how every shop
    // in Egypt writes it: the button says "English" while the page is Arabic.
    'aria-label': t('language'),
    onClick: () => setLanguage(getLanguage() === 'ar' ? 'en' : 'ar'),
  }, icon(ICONS.globe, { size: 18 }), el('span.lang-label', t('language')));
}

function cartButton() {
  cartCountNode = el('span.cart-count', { hidden: cart.count() === 0 }, String(cart.count()));
  return el('a.icon-btn.cart-btn', { href: href('cart'), 'aria-label': t('cart') },
    icon(ICONS.bag, { size: 19 }),
    el('span.btn-label', t('cart')),
    cartCountNode);
}

/**
 * The category strip. Scrolls sideways on a phone rather than wrapping to three
 * rows and pushing the products below the fold.
 */
function categoryNav() {
  if (!isOpen()) return null;
  const current = parseHash();
  const items = [
    el('a.chip', {
      href: href('products'),
      class: current.segments[0] === 'products' ? 'is-active' : '',
    }, t('allProducts')),
    ...shop.categories.map((category) => el('a.chip', {
      href: href(`category/${category.id}`),
      class: current.segments[0] === 'category' && current.segments[1] === String(category.id) ? 'is-active' : '',
    }, pick(category, 'name'))),
  ];
  if (items.length <= 1) return null;
  return el('nav.cat-nav', { 'aria-label': t('categories') }, el('div.wrap.cat-nav-inner', items));
}

export function buildHeader() {
  return el('header.site-head',
    announcementBar(),
    el('div.head-main', el('div.wrap.head-inner',
      el('a.brand', { href: href(''), 'aria-label': shopName() },
        el('span.brand-mark', 'M&M'),
        el('span.brand-word', getLanguage() === 'ar' ? 'للإكسسوارات' : 'Accessories')),
      isOpen() && searchForm(),
      el('div.head-actions',
        languageToggle(),
        // Reaching the shop is not conditional on it being open for orders.
        el('a.icon-btn.contact-btn', { href: href('contact') },
          icon(ICONS.mail, { size: 19 }), el('span.btn-label', t('contactUs'))),
        isOpen() && el('a.icon-btn.track-btn', { href: href('track') },
          icon(ICONS.truck, { size: 19 }), el('span.btn-label', t('trackOrder'))),
        isOpen() && cartButton()))),
    categoryNav());
}

export function buildFooter() {
  const wa = whatsappHref();
  const year = new Date().getFullYear();
  return el('footer.site-foot',
    el('div.wrap.foot-inner',
      el('div.foot-brand',
        el('span.brand-mark', 'M&M'),
        el('p.foot-about', t('footerAbout')),
        wa && el('a.wa-link', { href: wa, target: '_blank', rel: 'noopener noreferrer' },
          icon(ICONS.whatsapp, { size: 18 }), t('whatsappUs')),
        socialLinks()),
      // A closed shop offers no links into a catalogue nobody can buy from;
      // what is left is the note about how payment works and a way to reach a
      // human — which is also why "contact" survives the isOpen gate below.
      isOpen() && el('nav.foot-col', { 'aria-label': t('footerShop') },
        el('h3', t('footerShop')),
        el('a', { href: href('products') }, t('allProducts')),
        shop.categories.slice(0, 4).map((category) => el('a', { href: href(`category/${category.id}`) }, pick(category, 'name')))),
      el('nav.foot-col', { 'aria-label': t('footerHelp') },
        el('h3', t('footerHelp')),
        el('a', { href: href('contact') }, t('contactUs')),
        isOpen() && el('a', { href: href('track') }, t('trackOrder')),
        isOpen() && el('a', { href: href('cart') }, t('cart')),
        isOpen() && el('span.foot-note', t('payWithCash')))),
    el('div.wrap.foot-base',
      el('span', `© ${year} ${shopName()}`),
      el('span', t('rightsReserved'))));
}

/** Called on every cart change — the badge is the only part of the header that moves. */
export function refreshCartCount() {
  if (!cartCountNode) return;
  const n = cart.count();
  cartCountNode.textContent = String(n);
  cartCountNode.hidden = n === 0;
}

/**
 * Keep the header's search box in step with the URL, so landing on
 * `#/search?q=oud` from a shared link shows "oud" in the box.
 */
export function syncSearchInput() {
  if (!searchInput) return;
  const route = parseHash();
  const term = route.segments[0] === 'search' ? (route.query.q || '') : '';
  if (document.activeElement !== searchInput) searchInput.value = term;
}

/** Mark the active category chip after a navigation without rebuilding the header. */
export function syncNav(root) {
  const current = parseHash();
  root.querySelectorAll('.cat-nav .chip').forEach((chip) => {
    const target = chip.getAttribute('href').replace(/^#\//, '');
    const segments = target.split('/');
    const active = segments[0] === current.segments[0]
      && (segments.length < 2 || segments[1] === current.segments[1]);
    chip.classList.toggle('is-active', active);
  });
}

export { shopName, whatsappHref };
