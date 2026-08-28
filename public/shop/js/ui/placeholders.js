/**
 * What a shop shows where a photograph should be.
 *
 * Every catalogue has gaps. A product added at the counter in a hurry, a brand
 * whose logo nobody has found yet - and until now those drew two quiet letters
 * in a box, which reads as a page that has not finished loading rather than as
 * a shop. On a grid where the cards beside it have real photographs it is worse
 * than that: it looks broken.
 *
 * So the gap gets ARTWORK instead: a bottle for a product, a mark for a brand.
 * Drawn rather than photographed, on purpose - a stock photograph of somebody
 * else's perfume on a card is a small lie about what is in the box, and this
 * shop sells the real thing. A line drawing says "no picture yet" honestly
 * while still filling the frame like a picture.
 *
 * Inline SVG, not a file: it is a few hundred bytes, it costs no request on a
 * page that may draw forty of them, and - the reason it is worth doing this way
 * - it can be tinted with the shop's own accent, so a placeholder on a gold
 * shop and one on a green shop belong to their shops.
 */
import { el } from '../core/dom.js';
import { monogramText } from '../core/branding.js';

/** The accent, as the CSS variable resolves it right now. */
function accent(fallback = '#b58a3c') {
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

const svg = (markup) => `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

/**
 * A bottle, square, on the frame's own background.
 *
 * Square because every photo frame in this shop is square (`--photo-ratio`), and
 * a placeholder that is a different shape from the pictures beside it defeats
 * the point of having a ratio at all.
 */
export function defaultProductArt(label = '') {
  const tint = accent();
  const initials = String(label || monogramText() || '').trim().slice(0, 2).toUpperCase();
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-hidden="true">
  <rect width="200" height="200" fill="none"/>
  <g fill="none" stroke="${tint}" stroke-opacity="0.42" stroke-width="3.2"
     stroke-linejoin="round" stroke-linecap="round">
    <rect x="86" y="34" width="28" height="18" rx="4"/>
    <path d="M92 52v10c0 4-2 6-6 9-10 6-16 15-16 27v46c0 8 6 14 14 14h32c8 0 14-6 14-14v-46c0-12-6-21-16-27-4-3-6-5-6-9V52"/>
    <path d="M74 118h52"/>
  </g>
  <text x="100" y="106" text-anchor="middle" font-family="Georgia, serif"
        font-size="26" fill="${tint}" fill-opacity="0.5">${initials}</text>
</svg>`);
}

/** A brand with no logo: its initials inside a ring, in the shop's accent. */
export function defaultBrandArt(label = '') {
  const tint = accent();
  const initials = String(label || '').trim().slice(0, 2).toUpperCase() || monogramText();
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-hidden="true">
  <circle cx="60" cy="60" r="46" fill="none" stroke="${tint}" stroke-opacity="0.35" stroke-width="2.5"/>
  <text x="60" y="72" text-anchor="middle" font-family="Georgia, serif"
        font-size="34" fill="${tint}" fill-opacity="0.7">${initials}</text>
</svg>`);
}

/**
 * The <img> a card uses when there is no photograph. An image element rather
 * than a background, so it sits in exactly the same box, with exactly the same
 * fitting rules, as a real photograph would - which is what keeps the grid even.
 */
export function defaultProductImage(label = '') {
  return el('img.photo-default', {
    src: defaultProductArt(label),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
}

export function defaultBrandImage(label = '') {
  return el('img.brand-logo-img.brand-logo-default', {
    src: defaultBrandArt(label),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
}
