/** Product cards, availability badges and the grids they live in. */
import { el, icon, chevron, ICONS } from '../core/dom.js';
import { imageUrl } from '../core/api.js';
import { t, pick, isRtl } from '../core/i18n.js';
import { monogramText } from '../core/branding.js';
import { priceRange } from '../core/format.js';
import { href } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import * as favorites from '../core/favorites.js';

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

/**
 * Paint one heart from the list as it is right now.
 *
 * State lives in `core/favorites.js` and nowhere else — the button reads it
 * rather than remembering it, which is what lets the same product's heart on
 * two different shelves of the same page agree.
 */
function paintHeart(node) {
  const on = favorites.has(node.dataset.fav);
  // The label says what the tap will DO, which is the only thing a screen
  // reader user can act on; `aria-pressed` carries the state itself.
  const label = t(on ? 'removeFromFavorites' : 'addToFavorites');
  /*
   * The one hook the stylesheet cannot reach for itself.
   *
   * Filling a heart is the most satisfying tap on this site and shop.css
   * animates it (see `fav-beat` / `fav-ring` in the motion section), but a CSS
   * animation keyed off `[aria-pressed="true"]` alone would also fire for
   * every already-saved piece the moment the favourites page painted — a grid
   * of hearts all popping at once on load, which is noise, not delight.
   *
   * `was` is null on the very first paint of a button and a string on every
   * repaint after it, so this is true only when a heart is filled by a person
   * who was looking at it. The class is removed and re-added with a reflow
   * between, because re-adding a class the node already carries does not
   * restart an animation.
   */
  const was = node.getAttribute('aria-pressed');
  if (was === 'false' && on) {
    node.classList.remove('is-saved');
    void node.offsetWidth;
    node.classList.add('is-saved');
  } else if (!on) {
    node.classList.remove('is-saved');
  }
  node.setAttribute('aria-pressed', on ? 'true' : 'false');
  node.setAttribute('aria-label', label);
  // On a detail page the same words are also on screen (see `favoriteButton`
  // below). One string, set in one place, so the visible label and the
  // announced one cannot drift apart.
  const visible = node.querySelector('.fav-label');
  if (visible) visible.textContent = label;
}

/**
 * ONE subscription for the whole document, not one per card.
 *
 * A grid is thrown away and rebuilt on every navigation, and a listener
 * registered per card would keep every card this visit ever rendered alive in
 * the listener set. This walks the hearts that are actually in the DOM when a
 * change arrives, so a card that has been navigated away from is simply not
 * found — and a card still on screen repaints itself when the same product is
 * unfavourited on the favourites page in another tab, because `favorites.js`
 * turns a cross-tab `storage` event into the same change.
 */
let watching = false;
function watchFavorites() {
  if (watching) return;
  watching = true;
  favorites.onChange(() => document.querySelectorAll('[data-fav]').forEach(paintHeart));
}

/**
 * The favourite toggle. THE favourite toggle — there is one implementation of
 * it on this site and both places that draw a heart call this, so the grid and
 * the product page cannot end up disagreeing about whether something is saved.
 *
 * Only the dress changes: `className` is the geometry (`card-fav` is the
 * corner of a card, `btn btn-ghost btn-fav` is the pill on a product page) and
 * the state — the fill, the accent, `aria-pressed` — is drawn off the
 * `data-fav` attribute in shop.css, which every one of them carries.
 *
 * On a card: a `<button>` inside an `<a>` is invalid HTML and browsers do not
 * agree on what the click means, so the card is a container: the anchor covers
 * the photo and the body (the whole card is still one tap target on a phone)
 * and this is its sibling, laid on top. `preventDefault` and `stopPropagation`
 * are belt and braces — the button is outside the anchor, and it also must
 * not become one by anybody nesting these differently later.
 */
export function favoriteButton(productId, { className = 'card-fav', label = false, size = 18 } = {}) {
  const id = Number(productId);
  const button = el('button', {
    type: 'button',
    class: className,
    dataset: { fav: String(id) },
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      favorites.toggle(id);
    },
  },
  icon(ICONS.heart, { size }),
  // A corner of a card has no room for words and does not need them — the
  // heart is a heart. A product page has a whole column, and a labelled
  // control there is one less thing for a shopper to guess at, so it says so.
  label && el('span.fav-label'));
  paintHeart(button);
  watchFavorites();
  return button;
}

/**
 * One product in a grid. The anchor covers the whole of the card's content —
 * a thumb anywhere on it opens the product — and the heart sits over it.
 */
export function productCard(card, { eager = false } = {}) {
  const name = pick(card, 'name');
  const brand = pick(card, 'brand_name');
  const out = card.availability === 'out';

  return el('div.card', { class: out ? 'is-out' : '' },
    el('a.card-link', { href: href(routePath('product', { id: card.id, slug: slugFor(card) })), 'aria-label': name },
      el('div.card-photo',
        productPhoto(card.image_id, name, { eager }),
        card.availability !== 'in_stock' && el('div.card-badge', availabilityBadge(card.availability))),
      el('div.card-body',
        brand && el('span.card-brand', brand),
        el('h3.card-name', name),
        el('span.card-price', priceRange(card.price_from, card.price_to)))),
    favoriteButton(card.id));
}

export function productGrid(cards, { eagerCount = 4 } = {}) {
  return el('div.grid', cards.map((card, index) => productCard(card, { eager: index < eagerCount })));
}

/**
 * The badge on a category card.
 *
 * There is no per-category artwork on this platform and there is not going to
 * be one: an icon set would mean this file guessing what every category of
 * every shop looks like, and an emoji would be a different drawing on every
 * Android in Egypt. So the badge wears a letter — the category's own first
 * one, falling back to the shop's monogram for a name that begins with
 * something that is not a letter at all.
 */
const categoryLetter = (name) => Array.from(String(name).trim())[0] || monogramText();

/**
 * A category or brand card — same record shape from both endpoints: a round
 * badge, the name, how many pieces are in it, and a way in.
 */
export function taxonomyTile(row, kind) {
  const name = pick(row, 'name');
  return el('a.tile', { href: href(routePath(kind, { id: row.id, slug: slugFor(row) })) },
    el('span.tile-badge', { 'aria-hidden': 'true' }, categoryLetter(name)),
    el('span.tile-name', name),
    el('span.tile-count', t('itemsCount', Number(row.product_count || 0))),
    el('span.tile-more', t('viewAll'), chevron(14)));
}

/**
 * One brand, as a card in the brands rail.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The brands section was sixty identical text pills wrapped over six rows: a
 * wall with no shape to it, where finding "ديور" meant reading sixty names and
 * where every brand looked exactly as important as every other. A shopper
 * scanning for a name they know needs something to catch on.
 *
 * So a brand gets its logo where the shop has recorded one and a lettered badge
 * where it has not, plus how many pieces are behind it — the same three facts a
 * category tile carries, in a shape that scrolls sideways instead of stacking.
 *
 * `logo_url` is a field the ERP already has on every brand and the storefront
 * never used. A logo that fails to load falls back to the letter rather than
 * leaving the browser's broken-image glyph in a shop window.
 */
export function brandCard(row) {
  const name = pick(row, 'name');
  const mark = el('span.brand-mark-badge', { 'aria-hidden': 'true' }, categoryLetter(name));
  const logo = String(row.logo_url || '').trim();
  if (logo) {
    const img = el('img.brand-logo-img', {
      src: logo, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer',
    });
    img.addEventListener('error', () => { img.remove(); mark.hidden = false; });
    mark.hidden = true;
    // Both are appended; whichever survives is the one that could be shown.
    return el('a.brand-card', { href: href(routePath('brand', { id: row.id, slug: slugFor(row) })) },
      el('span.brand-card-face', img, mark),
      el('span.brand-card-name', name),
      el('span.brand-card-count', t('itemsCount', Number(row.product_count || 0))));
  }
  return el('a.brand-card', { href: href(routePath('brand', { id: row.id, slug: slugFor(row) })) },
    el('span.brand-card-face', mark),
    el('span.brand-card-name', name),
    el('span.brand-card-count', t('itemsCount', Number(row.product_count || 0))));
}

/**
 * A row that scrolls sideways, with buttons for the people who are not going to
 * drag it.
 *
 * Deliberately NOT a marquee. A strip that slides on its own looks alive in a
 * screenshot and is miserable to use: every target is moving, so clicking the
 * brand you spotted means chasing it, and a shopper who stops to read is fought
 * by the page. This scrolls when it is pushed — by finger, by wheel, by the
 * arrows, by the keyboard — and holds still when it is not.
 *
 * The arrows hide themselves when there is nothing to scroll to, so a shop with
 * six brands does not get a control that does nothing.
 */
export function rail(items, { label } = {}) {
  const track = el('div.rail-track', { role: 'list', 'aria-label': label || '' }, items);
  const back = el('button.rail-btn.rail-back', {
    type: 'button', 'aria-label': t('previous'), tabIndex: -1, 'aria-hidden': 'true',
  }, chevron(18));
  const next = el('button.rail-btn.rail-next', {
    type: 'button', 'aria-label': t('next'), tabIndex: -1, 'aria-hidden': 'true',
  }, chevron(18));

  /*
   * `scrollLeft` runs negative in a right-to-left row in every current browser,
   * so the sums below are written in terms of distance travelled rather than
   * position, and read the same in both directions.
   */
  const travelled = () => Math.abs(track.scrollLeft);
  const room = () => track.scrollWidth - track.clientWidth;

  function paint() {
    const scrollable = room() > 8;
    for (const button of [back, next]) {
      button.hidden = !scrollable;
      button.tabIndex = scrollable ? 0 : -1;
      button.setAttribute('aria-hidden', scrollable ? 'false' : 'true');
    }
    if (!scrollable) return;
    back.disabled = travelled() <= 4;
    next.disabled = travelled() >= room() - 4;
  }

  function nudge(direction) {
    const step = Math.max(track.clientWidth * 0.8, 200);
    // `by` is in logical inline pixels: positive is "further along the row",
    // which the browser mirrors for us when the document does.
    track.scrollBy({ left: isRtl() ? -direction * step : direction * step, behavior: 'smooth' });
  }

  back.addEventListener('click', () => nudge(-1));
  next.addEventListener('click', () => nudge(1));
  track.addEventListener('scroll', paint, { passive: true });
  // The width is not known until this is in the document; a frame later it is.
  requestAnimationFrame(paint);
  window.addEventListener('resize', paint, { passive: true });

  return el('div.rail', back, track, next);
}

/** A section heading with an optional "view all" on the far inline end. */
export function sectionHead(title, note, link) {
  return el('div.section-head',
    el('div',
      el('h2.section-title', title),
      note && el('p.section-note', note)),
    link && el('a.link-more', { href: link.href }, link.label, chevron(15)));
}

