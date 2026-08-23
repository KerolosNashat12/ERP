/**
 * What the server already sent, so the browser does not ask for it again.
 *
 * The storefront used to open every visit with three requests — the config, the
 * categories and the brands — before it could paint anything but the boot mark,
 * and a fourth on a product page. The server now has to read all of those
 * anyway in order to write the page's `<head>` (src/services/StorefrontSeo.js),
 * so it sends them down inside the HTML rather than making a phone on Egyptian
 * mobile data pay a round trip to ask for what has already been fetched.
 *
 * That is what pays for rendering the head: the first paint is a round trip
 * FASTER than it was before any of this existed, not slower.
 *
 * Read once and forgotten. Every navigation after the first calls the API
 * exactly as it always did, because this payload was only ever true at the
 * moment the page was sent — which is also why the shell is served `no-store`.
 * A missing or unreadable payload is not an error: the shop falls back to
 * asking, which is what it did before, and nothing else changes.
 */
let payload = null;
let read = false;

function load() {
  if (read) return payload;
  read = true;
  try {
    const node = document.getElementById('mm-boot');
    if (!node) return null;
    payload = JSON.parse(node.textContent);
  } catch {
    // A truncated response, a proxy that mangled the page: ask the API instead.
    payload = null;
  }
  return payload;
}

/**
 * The three shop-wide answers, or null. Consumed once — a language switch or a
 * navigation must not re-adopt a config that was true two minutes ago.
 */
export function takeShell() {
  const data = load();
  if (!data || !data.config) return null;
  const shell = { config: data.config, categories: data.categories || [], brands: data.brands || [] };
  payload = { ...data, config: null };
  return shell;
}

/** The product this page is about, if this page is about one. Consumed once. */
export function takeProduct(id) {
  const data = load();
  if (!data || !data.product) return null;
  if (String(data.product.id) !== String(id)) return null;
  const product = data.product.data;
  payload = { ...data, product: null };
  return product;
}

/** The language the server rendered this document in, or null. */
export const serverLanguage = () => load()?.lang || null;
