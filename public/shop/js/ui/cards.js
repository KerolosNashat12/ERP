/** Product cards, availability badges and the grids they live in. */
import { el, icon, chevron, ICONS } from '../core/dom.js';
import { imageUrl, brandLogoUrl, categoryImageUrl } from '../core/api.js';
import { t, pick, isRtl } from '../core/i18n.js';
import { monogramText } from '../core/branding.js';
import { defaultProductImage, defaultBrandImage, categoryArt } from './placeholders.js';
import { priceRange } from '../core/format.js';
import { href } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import * as favorites from '../core/favorites.js';
// The quick-add button on a card puts a line in the basket and says so — the
// same two modules the product page uses, so there is one cart and one toast.
import * as cart from '../core/cart.js';
import { toast } from './states.js';

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
 * What fills a card with no photograph in it.
 *
 * It used to be two quiet letters, which on a shelf beside real photographs
 * reads as a page that has not finished loading. Now it is a drawn bottle in
 * the shop's own accent - the same square frame, the same fitting rules as a
 * photograph, so the grid stays even - with the shop's monogram inside it.
 * Drawn rather than a stock photograph on purpose: a picture of somebody else's
 * perfume on this card would be a small lie about what is in the box.
 */
const placeholderMark = (label = '') => defaultProductImage(label || monogramText());

/**
 * A photo that reserves its space before it loads, so a grid of cards does not
 * jump as the images arrive. `loading="lazy"` matters more than usual here:
 * most of these visits are on mobile data.
 */
export function productPhoto(imageId, alt, { eager = false } = {}) {
  const frame = el('div.photo');
  if (!imageId) {
    frame.classList.add('photo-empty');
    frame.append(placeholderMark(alt));
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
    frame.append(placeholderMark(alt));
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
 * The price on a card, with the offer on it when there is one.
 *
 * Three things, in the order a shopper reads them: what it costs now, what it
 * cost before with a line through it, and by how much — because a struck-out
 * number on its own makes a person do the subtraction, and a percentage on its
 * own makes them do the multiplication.
 *
 * The old price is `<s>` and not a class on a span: a screen reader announces
 * it as struck-out content, so somebody listening to the page hears that this
 * is the former price rather than two prices in a row with no explanation.
 * `aria-label` on the row says the whole thing in one sentence for exactly the
 * same reason.
 */
export function cardPrice(card) {
  const now = priceRange(card.price_from, card.price_to);
  if (!card.on_sale) return el('span.card-price', now);

  const was = priceRange(card.list_price_from, card.list_price_to);
  return el('span.card-price.is-sale', {
    'aria-label': t('priceWasNow', was, now, card.discount_percent),
  },
  el('span.price-now', now),
  el('s.price-was', { 'aria-hidden': 'true' }, was),
  el('span.price-off', { 'aria-hidden': 'true' }, `−${card.discount_percent}%`));
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
        // The sale flash sits opposite the stock badge so the two never
        // collide, and it is drawn even on a piece that is out of stock —
        // "sold out at that price" is still information a shopper wants.
        card.on_sale && el('div.card-sale', `−${card.discount_percent}%`),
        card.availability !== 'in_stock' && el('div.card-badge', availabilityBadge(card.availability))),
      el('div.card-body',
        brand && el('span.card-brand', brand),
        el('h3.card-name', name),
        cardPrice(card))),
    favoriteButton(card.id),
    quickAdd(card));
}

/**
 * The button the design lays over a photograph on hover.
 *
 * ── Three states, and each of them is the truth about the product ───────────
 * A basket line is a VARIANT, so what this can offer depends on how many the
 * product has, and the server answers that per card (see `cardVariant` in
 * StorefrontService):
 *
 *   one variant, in stock   → adds it, in one tap, without leaving the shelf.
 *   two or more variants    → "choose" — it opens the product page, because
 *                             there is a real question to answer and guessing
 *                             the first variant is how somebody ends up with
 *                             the 30ml they did not want.
 *   out of stock            → nothing at all. A button that cannot work is
 *                             worse than no button.
 *
 * ── Why it is a sibling of the link, not inside it ─────────────────────────
 * The whole card is one anchor so a thumb anywhere on it opens the product. A
 * `<button>` inside an `<a>` is invalid HTML and browsers disagree about the
 * click; the favourite heart already solved this by being a sibling laid over
 * the corner, and this is the same arrangement over the bottom of the photo.
 */
function quickAdd(card) {
  if (card.availability === 'out') return null;

  const many = Number(card.variant_count || 0) > 1 || !card.variant_id;
  if (many) {
    return el('a.card-add', {
      href: href(routePath('product', { id: card.id, slug: slugFor(card) })),
      tabindex: '-1',
      'aria-hidden': 'true',
    }, el('span.card-add-btn', icon(ICONS.bag, { size: 16 }), el('span', t('chooseOptions'))));
  }

  return el('button.card-add', {
    type: 'button',
    tabindex: '-1',
    'aria-hidden': 'true',
    onClick: (event) => {
      // The card is a link; adding to the basket must not also navigate.
      event.preventDefault();
      event.stopPropagation();
      cart.add({
        variant_id: card.variant_id,
        product_id: card.id,
        name_en: card.name_en,
        name_ar: card.name_ar,
        label: '',
        price: Number(card.price_from) || 0,
        tax_rate: Number(card.tax_rate || 0),
        image_id: card.image_id,
      }, 1);
      toast(t('addedToCart'));
    },
  }, el('span.card-add-btn', icon(ICONS.bag, { size: 16 }), el('span', t('addToCart'))));
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
 * What a shelf wears above its name: a photograph, or a drawn icon.
 *
 * The owner's instruction, in both halves: «ممكن تبقي صور ونضيف صور للفئات
 * وانت خلي الـdefault من عندك ايقونات لو الادمين مضفش صور». So:
 *
 *   the shop uploaded a picture   → that picture, filling the frame
 *   it did not                    → a line icon guessed from the name
 *                                   (see categoryArt in ui/placeholders.js)
 *
 * The letter-in-a-circle it used to draw is gone from the category path. It
 * survives for BRANDS with no logo, because a brand's mark is a wordmark and
 * there is no icon that means "Dior" — a letter is the honest stand-in there
 * and a drawn bottle would not be.
 *
 * `has_image` decides it, not a failed image load: asking for a picture that
 * is not there costs a 404 per tile on every visit, and a broken-image glyph
 * for however long it takes to fail.
 */
function tileMark(row, kind, name) {
  if (kind === 'category') {
    if (row.has_image) {
      return el('span.tile-badge.has-photo',
        el('img.tile-photo', {
          src: categoryImageUrl(row.id),
          alt: '',
          loading: 'lazy',
          decoding: 'async',
        }));
    }
    return el('span.tile-badge.is-icon', { 'aria-hidden': 'true' }, categoryArt(row));
  }
  return el('span.tile-badge', { 'aria-hidden': 'true' }, categoryLetter(name));
}

/**
 * A category or brand card — same record shape from both endpoints: a round
 * badge, the name, how many pieces are in it, and a way in.
 */
export function taxonomyTile(row, kind) {
  const name = pick(row, 'name');
  return el('a.tile', { href: href(routePath(kind, { id: row.id, slug: slugFor(row) })) },
    tileMark(row, kind, name),
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
  /*
   * The fallback is drawn now rather than typeset: the brand's initials inside
   * a ring, in the shop's accent, filling the same circle a real logo fills.
   * A bare letter next to five real marks looks like a brand that failed to
   * load; a drawn mark looks like a brand whose logo has not been added yet,
   * which is the truth.
   */
  const mark = defaultBrandImage(name);
  /*
   * Three sources, in order of how much the shop meant it:
   *   1. a picture uploaded against the brand in the ERP — `has_logo`;
   *   2. `logo_url`, a link somebody typed into the brand record years ago;
   *   3. the brand's first letter, which every brand has.
   */
  const source = row.has_logo ? brandLogoUrl(row.id) : String(row.logo_url || '').trim();
  const face = el('span.brand-card-face', { class: source ? 'has-logo' : '' });

  if (source) {
    const img = el('img.brand-logo-img', {
      src: source, alt: '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer',
    });
    // A logo that will not load leaves the letter behind rather than the
    // browser's broken-image glyph in a shop window.
    img.addEventListener('error', () => {
      img.remove();
      face.classList.remove('has-logo');
      face.append(mark);
    });
    face.append(img);
  } else {
    face.append(mark);
  }

  return el('a.brand-card', { href: href(routePath('brand', { id: row.id, slug: slugFor(row) })) },
    face,
    el('span.brand-card-name', name),
    el('span.brand-card-count', t('itemsCount', Number(row.product_count || 0))));
}

/**
 * A row that scrolls sideways — by itself, and by hand.
 *
 * ── The argument, and how it was settled ─────────────────────────────────────
 * A strip that slides on its own looks alive and is normally miserable to use:
 * every target is moving, so clicking the brand you spotted means chasing it.
 * That is why this was built as a plain scroller first. The shop's owner asked
 * twice for it to move, and he is right that a still row of sixty brands reads
 * as a list rather than as a shop — so it moves, and the objection is answered
 * rather than ignored: IT STOPS THE MOMENT YOU GO NEAR IT. Pointer over the
 * rail, keyboard focus inside it, a finger on it, or a hand on the wheel, and
 * the drift halts; nothing has to be caught. It also never starts at all for a
 * reader who has asked their system for less motion, and it gives up while the
 * tab is in the background rather than burning a phone battery on a page nobody
 * is looking at.
 *
 * ── The loop ─────────────────────────────────────────────────────────────────
 * The items are rendered twice and the scroll position wraps at the halfway
 * point, so the row never reaches an end to bounce off. The clones are
 * `aria-hidden` and not focusable: a screen reader and the Tab key see sixty
 * brands, not a hundred and twenty.
 */
export function rail(items, { label, drift = true, bleed = false } = {}) {
  const track = el('div.rail-track', { role: 'list', 'aria-label': label || '' }, items);
  const back = el('button.rail-btn.rail-back', {
    type: 'button', 'aria-label': t('previous'), tabIndex: -1, 'aria-hidden': 'true',
  }, chevron(18));
  const next = el('button.rail-btn.rail-next', {
    type: 'button', 'aria-label': t('next'), tabIndex: -1, 'aria-hidden': 'true',
  }, chevron(18));

  /*
   * `scrollLeft` runs negative in a right-to-left row in every current browser,
   * so everything below is written in terms of distance travelled rather than
   * position, and reads the same in both directions.
   */
  const away = isRtl() ? -1 : 1;
  const travelled = () => Math.abs(track.scrollLeft);
  const room = () => track.scrollWidth - track.clientWidth;

  function paint() {
    const scrollable = room() > 8;
    // A row that fits is centred; a row that scrolls starts at its beginning.
    track.classList.toggle('is-static', !scrollable);
    for (const button of [back, next]) {
      button.hidden = !scrollable;
      button.tabIndex = scrollable ? 0 : -1;
      button.setAttribute('aria-hidden', scrollable ? 'false' : 'true');
    }
  }

  function nudge(direction) {
    const step = Math.max(track.clientWidth * 0.8, 200);
    track.scrollBy({ left: away * direction * step, behavior: 'smooth' });
  }

  back.addEventListener('click', () => nudge(-1));
  next.addEventListener('click', () => nudge(1));
  window.addEventListener('resize', paint, { passive: true });
  requestAnimationFrame(paint);

  const node = el('div.rail', { class: bleed ? 'rail-bleed' : '' }, back, track, next);
  if (drift) startDrift(node, track, items, away);
  return node;
}

/** How fast the rail drifts, in CSS pixels per second. A reading pace, not a ride. */
const DRIFT_SPEED = 26;
/** How long after a person stops touching it before it picks up again. */
const RESUME_AFTER = 2500;
/** A moment of stillness at load, while the logos arrive. */
const SETTLE = 900;

function startDrift(node, track, items, away) {
  const calmer = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (calmer?.matches) return;

  /**
   * The second copy — and ONLY when the row is actually longer than the space
   * it has.
   *
   * It was made unconditionally at first, and a shop with one brand in it
   * showed that brand twice. Which is obvious in hindsight and was invisible in
   * testing: the copy exists so the drift can wrap without reaching an end, and
   * a row that fits on screen has no end to reach and never drifts at all — so
   * the copy is pure duplication, sitting in plain sight next to the original.
   *
   * Cloned rather than re-rendered so the two halves cannot disagree, hidden
   * from assistive technology and taken out of the tab order so a screen reader
   * and the Tab key still count the brands the shop really has.
   */
  let clones = null;
  const FITS = 8;                 // px of slack before a row counts as scrollable

  function syncClones() {
    if (!clones) {
      if (track.scrollWidth <= track.clientWidth + FITS) return false;
      clones = el('div.rail-clones', { 'aria-hidden': 'true' },
        items.map((item) => item.cloneNode(true)));
      for (const link of clones.querySelectorAll('a')) link.tabIndex = -1;
      track.append(clones);
      return true;
    }
    // The window grew, or a filter left fewer brands: one copy now fits, so the
    // second one has to go before it becomes the duplicate all over again.
    if (track.scrollWidth / 2 <= track.clientWidth + FITS) {
      clones.remove();
      clones = null;
      track.scrollLeft = 0;
      return false;
    }
    return true;
  }
  window.addEventListener('resize', syncClones, { passive: true });

  let held = 0;             // pointer, focus or finger currently on the rail
  /*
   * When the person last moved it themselves — and, at load, a deliberate
   * settle: a row that is already sliding while its logos are still arriving
   * looks like a page that has not finished rendering.
   */
  let touchedAt = performance.now() - RESUME_AFTER + SETTLE;
  let last = 0;
  let carry = 0;            // sub-pixel remainder: scrollLeft is an integer

  const hold = () => { held += 1; };
  const release = () => { held = Math.max(0, held - 1); };

  node.addEventListener('pointerenter', hold);
  node.addEventListener('pointerleave', release);
  node.addEventListener('focusin', hold);
  node.addEventListener('focusout', release);
  track.addEventListener('touchstart', hold, { passive: true });
  track.addEventListener('touchend', release, { passive: true });
  // A wheel or a drag is the clearest "I am reading this" there is.
  const touched = () => { touchedAt = performance.now(); };
  track.addEventListener('wheel', touched, { passive: true });
  track.addEventListener('pointerdown', touched);

  function step(now) {
    const elapsed = last ? Math.min(now - last, 100) : 0;
    last = now;

    // No second copy means the whole row is on screen: there is nothing to
    // drift towards, and nothing to wrap around.
    const looping = syncClones();
    const half = track.scrollWidth / 2;
    const paused = !looping
      || held > 0
      || document.hidden
      || (now - touchedAt) < RESUME_AFTER
      || half <= track.clientWidth;

    if (!paused && elapsed) {
      carry += (DRIFT_SPEED * elapsed) / 1000;
      const whole = Math.floor(carry);
      if (whole) {
        carry -= whole;
        track.scrollLeft += away * whole;
      }
      // One copy travelled: jump back by exactly that copy's width. The pixels
      // under the reader are identical, so the seam cannot be seen.
      if (Math.abs(track.scrollLeft) >= half) track.scrollLeft -= away * half;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/** A section heading with an optional "view all" on the far inline end. */
export function sectionHead(title, note, link) {
  return el('div.section-head',
    el('div',
      el('h2.section-title', title),
      note && el('p.section-note', note)),
    link && el('a.link-more', { href: link.href }, link.label, chevron(15)));
}

