/**
 * Per-page `<title>` and `<meta name="description">`.
 *
 * A single-page shop has one HTML file, so without this every product a
 * customer sends to a friend on WhatsApp arrives titled "M&M Accessories" with
 * the shop's generic blurb underneath. Setting them per view is the difference
 * between a link that sells the bag and a link that does not.
 */
import { getLanguage } from './i18n.js';
import { shop } from './store.js';

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

export function setPageMeta({ title, description, image } = {}) {
  const shopName = getLanguage() === 'ar'
    ? (shop.config?.companyName?.ar || 'إم آند إم للإكسسوارات')
    : (shop.config?.companyName?.en || 'M&M Accessories');

  const full = title ? `${title} — ${shopName}` : shopName;
  document.title = full;
  property('og:title').setAttribute('content', full);
  property('og:type').setAttribute('content', 'website');
  property('og:url').setAttribute('content', window.location.href);

  if (description) {
    meta('description').setAttribute('content', description);
    property('og:description').setAttribute('content', description);
  }
  if (image) property('og:image').setAttribute('content', new URL(image, window.location.origin).href);
  else document.head.querySelector('meta[property="og:image"]')?.remove();
}
