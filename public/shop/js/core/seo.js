/**
 * Per-page `<title>`, `<meta name="description">` and the Open Graph block a
 * link preview is built from.
 *
 * A single-page shop has one HTML file, so without this every product a
 * customer sends to a friend on WhatsApp arrives titled with whatever was
 * typed into that file. Setting them per view is the difference between a link
 * that sells the dress and a link that does not — and, since this platform
 * hosts more than one shop from one file, the difference between a shared link
 * arriving wearing the shop it points at and one arriving wearing the first
 * tenant's name.
 *
 * Everything below comes from `config.branding`; there is no shop name and no
 * description written down here.
 */
import { shopName, metaDescription } from './branding.js';
import { assetUrl } from './api.js';
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
  const name = shopName();
  const full = title ? `${title} — ${name}` : name;
  document.title = full;
  property('og:title').setAttribute('content', full);
  property('og:site_name').setAttribute('content', name);
  property('og:type').setAttribute('content', 'website');
  property('og:url').setAttribute('content', window.location.href);

  // A page that says nothing about itself still says something about the shop:
  // the shop's own meta description, which the server has already fallen back
  // to its About paragraph and then to its name.
  const text = description || metaDescription();
  if (text) {
    meta('description').setAttribute('content', text);
    property('og:description').setAttribute('content', text);
  }

  // The preview picture: this page's own photo where it has one (a product),
  // the shop's logo otherwise — so a shared link to the home page arrives
  // wearing the shop's mark rather than as a blank card.
  const preview = image || assetUrl(shop.config?.branding?.logo);
  if (preview) property('og:image').setAttribute('content', new URL(preview, window.location.origin).href);
  else document.head.querySelector('meta[property="og:image"]')?.remove();
}
