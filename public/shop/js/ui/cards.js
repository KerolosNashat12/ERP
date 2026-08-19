/** Product cards, availability badges and the grids they live in. */
import { el, chevron } from '../core/dom.js';
import { imageUrl } from '../core/api.js';
import { t, pick } from '../core/i18n.js';
import { monogramText } from '../core/branding.js';
import { priceRange } from '../core/format.js';
import { href } from '../core/router.js';

/**
 * Availability is a word from the API — 'in_stock' | 'low' | 'out' — and never a
 * count. "Only a few left" does the same sales job as "2 left" without telling
 * a competitor what the shop is holding.
 */
export function availabilityBadge(availability) {
  const map = {
    in_stock: ['badge-ok', t('inStock')],
    low: ['badge-low', t('lowStock')],
    out: ['badge-out', t('outOfStock')],
  };
  const [className, label] = map[availability] || map.out;
  return el(`span.badge.${className}`, label);
}

/**
 * What fills a card with no photograph in it: this shop's own monogram, never
 * a set of letters belonging to whoever this platform hosted first. The
 * monogram rather than the logo even for a shop that has uploaded one — a
 * wordmark stretched into a square photo frame is a worse placeholder than two
 * quiet letters.
 */
const placeholderMark = () => el('span.photo-mark', monogramText());

/**
 * A photo that reserves its space before it loads, so a grid of cards does not
 * jump as the images arrive. `loading="lazy"` matters more than usual here:
 * most of these visits are on mobile data.
 */
export function productPhoto(imageId, alt, { eager = false } = {}) {
  const frame = el('div.photo');
  if (!imageId) {
    frame.classList.add('photo-empty');
    frame.append(placeholderMark());
    return frame;
  }
  const img = el('img', {
    src: imageUrl(imageId),
    alt: alt || '',
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
  });
  // A photo the API cannot serve leaves the monogram behind rather than the
  // browser's broken-image glyph.
  img.addEventListener('error', () => {
    frame.classList.add('photo-empty');
    img.remove();
    frame.append(placeholderMark());
  });
  frame.append(img);
  return frame;
}

/** One product in a grid. The whole card is the link — a big target on a phone. */
export function productCard(card, { eager = false } = {}) {
  const name = pick(card, 'name');
  const brand = pick(card, 'brand_name');
  const out = card.availability === 'out';

  return el('a.card', {
    href: href(`product/${card.id}`),
    class: out ? 'is-out' : '',
    'aria-label': name,
  },
  el('div.card-photo',
    productPhoto(card.image_id, name, { eager }),
    card.availability !== 'in_stock' && el('div.card-badge', availabilityBadge(card.availability))),
  el('div.card-body',
    brand && el('span.card-brand', brand),
    el('h3.card-name', name),
    el('span.card-price', priceRange(card.price_from, card.price_to))));
}

export function productGrid(cards, { eagerCount = 4 } = {}) {
  return el('div.grid', cards.map((card, index) => productCard(card, { eager: index < eagerCount })));
}

/** A category or brand tile — same record shape from both endpoints. */
export function taxonomyTile(row, kind) {
  return el('a.tile', { href: href(`${kind}/${row.id}`) },
    el('span.tile-name', pick(row, 'name')),
    el('span.tile-count', t('itemsCount', Number(row.product_count || 0))),
    chevron(16));
}

/** A section heading with an optional "view all" on the far inline end. */
export function sectionHead(title, note, link) {
  return el('div.section-head',
    el('div',
      el('h2.section-title', title),
      note && el('p.section-note', note)),
    link && el('a.link-more', { href: link.href }, link.label, chevron(15)));
}

