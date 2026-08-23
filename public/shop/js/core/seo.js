/**
 * Keeping the head true as the customer moves around.
 *
 * The head a page ARRIVES with is written by the server, into the shell, before
 * any of this runs — see src/services/StorefrontSeo.js. That is what a crawler
 * reads and what a WhatsApp preview reads, and it is the half that matters for
 * being found. This file is the other half: once the script is running, every
 * navigation is a page swap rather than a page load, so the title, the
 * description, the canonical and the Open Graph block have to follow the
 * customer or the browser tab would still be showing the page they arrived on.
 *
 * The two halves say the same sentences because they read the same dictionary:
 * `core/i18n.js` here, and the very same file imported by Node there. Nothing
 * is written down twice — see the note on `translate` in that file.
 *
 * Everything else comes from `config.branding`; there is no shop name and no
 * description written down here.
 */
import { shopName, metaDescription } from './branding.js';
import { assetUrl } from './api.js';
import { shop } from './store.js';
import { t, getLanguage } from './i18n.js';
import { currentRoute, shopRoot } from './router.js';
import { withLanguage } from '../../../shared/shopUrls.js';

const meta = (name) => {
  let node = document.head.querySelector(`meta[name="${name}"]`);
  if (!node) {
    node = document.createElement('meta');
    node.setAttribute('name', name);
    document.head.append(node);
  }
  return node;
};

const property = (value) => {
  let node = document.head.querySelector(`meta[property="${value}"]`);
  if (!node) {
    node = document.createElement('meta');
    node.setAttribute('property', value);
    document.head.append(node);
  }
  return node;
};

/** `<link rel="…">`, matched by rel and — for the alternates — by hreflang. */
function link(rel, hreflang) {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]:not([hreflang])`;
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement('link');
    node.setAttribute('rel', rel);
    if (hreflang) node.setAttribute('hreflang', hreflang);
    document.head.append(node);
  }
  return node;
}

const absolute = (path) => new URL(path, window.location.origin).href;

/**
 * @param title         this page's own name, before the shop's is added
 * @param description   what it says about itself
 * @param image         the preview picture, when the page has one of its own
 * @param canonicalPath the address this page would like to be known by, relative
 *                      to the shop root ('product/12/سلسلة-فضة'). Defaults to
 *                      where the customer actually is, which is right for every
 *                      page except a product that arrived without its slug.
 * @param indexable     false for a cart, a checkout, an order or a search — one
 *                      customer's session is not a page, and the server says the
 *                      same thing about the same routes.
 */
export function setPageMeta({
  title, description, image, canonicalPath = null, indexable = true,
} = {}) {
  const name = shopName();
  const full = title ? t('metaTitle', title, name) : name;
  const lang = getLanguage();
  document.title = full;

  // The canonical address, and the same page in the other language. Both are
  // written, both always name the pair, and `x-default` is the Arabic one —
  // this shop is Egyptian and Arabic is what the bare address serves.
  const route = currentRoute();
  const asked = canonicalPath === null ? route.path : canonicalPath;
  const [path, query] = String(asked).split('?');
  const bare = absolute(path ? `${shopRoot()}/${path}` : shopRoot());
  // `withLanguage` puts the language marker last, after whatever the page keeps
  // of its own query — a sort order is dropped by the caller, a page number is
  // not, and both stay in front of `?lang=`.
  const canonical = withLanguage(bare, lang, { keepQuery: query || '' });
  link('canonical').setAttribute('href', canonical);
  link('alternate', 'ar').setAttribute('href', withLanguage(bare, 'ar', { keepQuery: query || '' }));
  link('alternate', 'en').setAttribute('href', withLanguage(bare, 'en', { keepQuery: query || '' }));
  link('alternate', 'x-default').setAttribute('href', withLanguage(bare, 'ar', { keepQuery: query || '' }));

  meta('robots').setAttribute('content', indexable
    ? 'index, follow, max-image-preview:large, max-snippet:-1'
    : 'noindex, follow');

  property('og:title').setAttribute('content', full);
  property('og:site_name').setAttribute('content', name);
  property('og:type').setAttribute('content', 'website');
  property('og:url').setAttribute('content', canonical);
  property('og:locale').setAttribute('content', lang === 'ar' ? 'ar_EG' : 'en_US');
  property('og:locale:alternate').setAttribute('content', lang === 'ar' ? 'en_US' : 'ar_EG');
  meta('twitter:title').setAttribute('content', full);

  // A page that says nothing about itself still says something about the shop:
  // the shop's own meta description, which the server has already fallen back
  // to its About paragraph and then to its name.
  const text = description || metaDescription();
  if (text) {
    meta('description').setAttribute('content', text);
    property('og:description').setAttribute('content', text);
    meta('twitter:description').setAttribute('content', text);
  }

  // The preview picture: this page's own photo where it has one (a product),
  // the shop's logo otherwise — so a shared link to the home page arrives
  // wearing the shop's mark rather than as a blank card.
  const preview = image || assetUrl(shop.config?.branding?.logo);
  if (preview) {
    const url = new URL(preview, window.location.origin).href;
    property('og:image').setAttribute('content', url);
    meta('twitter:image').setAttribute('content', url);
    meta('twitter:card').setAttribute('content', 'summary_large_image');
  } else {
    document.head.querySelector('meta[property="og:image"]')?.remove();
    document.head.querySelector('meta[name="twitter:image"]')?.remove();
  }
}

/**
 * The structured data the server wrote for the page the customer LANDED on.
 *
 * It is removed on the first client-side navigation and never rebuilt here.
 * That is deliberate: a crawler reads the document the server sent and nothing
 * after it, so a JSON-LD block maintained in the browser would be read by
 * nobody — and a `Product` block left behind while the customer is looking at
 * their cart is a claim about a page that is no longer on the screen.
 */
export function dropServerStructuredData() {
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((node) => node.remove());
}
