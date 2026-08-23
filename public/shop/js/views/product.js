/**
 * The product page — the only screen on the site where a decision is made, so
 * it is the one that gets the most care: a gallery that answers "what does it
 * actually look like", a price that changes with the option chosen, and a stock
 * verdict on every option before the customer picks one.
 */
import { el, fill, icon, ICONS } from '../core/dom.js';
import { api, imageUrl, ShopError } from '../core/api.js';
import { t, pick, getLanguage, isRtl } from '../core/i18n.js';
import { money, number, priceRange } from '../core/format.js';
import { href, canonicalise } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import { takeProduct } from '../core/boot.js';
import { setPageMeta } from '../core/seo.js';
import { shopName } from '../core/branding.js';
import { freeDeliveryOver, deliverySettings } from '../core/store.js';
import * as cart from '../core/cart.js';
import { availabilityBadge, productPhoto, favoriteButton } from '../ui/cards.js';
import { skeletonProduct, errorState, emptyState, toast } from '../ui/states.js';

/** Breadcrumbs back to the shelf this came from, built from what the card carries. */
function crumbs(product) {
  const parts = [el('a', { href: href('') }, t('home'))];
  if (product.brand_id) {
    parts.push(el('span.crumb-sep', '/'));
    parts.push(el('a', { href: href(routePath('brand', { id: product.brand_id, slug: slugFor(product, 'brand_name') })) }, pick(product, 'brand_name')));
  }
  return el('nav.crumbs', { 'aria-label': t('home') }, parts);
}

/**
 * The gallery. One main photo and a row of thumbnails; the main photo is also
 * driven from outside, because choosing a colour should show that colour.
 */
function gallery(product) {
  const images = product.images || [];
  const name = pick(product, 'name');
  const main = el('div.gallery-main');
  const thumbs = el('div.thumbs');
  let current = null;

  const altFor = (image) => (getLanguage() === 'ar'
    ? (image.alt_ar || image.alt_en) : (image.alt_en || image.alt_ar)) || name;

  function show(imageId, { focus = false } = {}) {
    const image = images.find((entry) => entry.id === imageId) || images[0] || null;
    const id = image ? image.id : product.image_id;
    if (current === id) return;
    current = id;
    fill(main, productPhoto(id, image ? altFor(image) : name, { eager: true }));
    thumbs.querySelectorAll('.thumb').forEach((node) => {
      const active = Number(node.dataset.id) === id;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active && focus) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  if (images.length > 1) {
    thumbs.setAttribute('role', 'tablist');
    thumbs.setAttribute('aria-label', t('moreImages'));
    for (const image of images) {
      thumbs.append(el('button.thumb', {
        type: 'button',
        role: 'tab',
        dataset: { id: image.id },
        'aria-label': altFor(image),
        onClick: () => show(image.id),
      }, el('img', { src: imageUrl(image.id), alt: '', loading: 'lazy', decoding: 'async' })));
    }
  }

  show(images[0]?.id ?? product.image_id);
  return { node: el('div.gallery', main, images.length > 1 && thumbs), show };
}

/**
 * The option picker.
 *
 * Out-of-stock options stay visible — knowing the shop carries that colour is
 * useful even when it is gone today — but they are `disabled`, greyed, struck
 * through and labelled, so they cannot be chosen by mouse, keyboard or script
 * that only checks for a class.
 */
function variantPicker(product, onPick) {
  const variants = product.variants || [];
  if (variants.length <= 1) return { node: null, selected: variants[0] || null };

  const group = el('div.variants', { role: 'radiogroup', 'aria-label': t('chooseVariant') });
  const buttons = new Map();
  let selected = variants.find((variant) => variant.availability !== 'out') || null;

  /**
   * A radiogroup is one tab stop, not one per option, and the arrows move
   * within it. Announcing the role without implementing the keyboard that goes
   * with it would leave a screen-reader user waiting for arrow keys that do
   * nothing — worse than plain buttons.
   */
  function choose(variant, { focus = false } = {}) {
    if (!variant || variant.availability === 'out') return;
    selected = variant;
    buttons.forEach((node, entry) => {
      const active = entry === variant;
      node.setAttribute('aria-checked', active ? 'true' : 'false');
      node.tabIndex = active ? 0 : -1;
      if (active && focus) node.focus();
    });
    onPick(variant);
  }

  const pickable = variants.filter((variant) => variant.availability !== 'out');
  function step(delta) {
    const index = pickable.indexOf(selected);
    const next = pickable[(index + delta + pickable.length) % pickable.length];
    choose(next, { focus: true });
  }

  for (const variant of variants) {
    const out = variant.availability === 'out';
    const button = el('button.variant', {
      type: 'button',
      role: 'radio',
      class: out ? 'is-out' : '',
      disabled: out,
      tabIndex: variant === selected ? 0 : -1,
      'aria-checked': variant === selected ? 'true' : 'false',
      title: out ? t('unavailableVariant') : '',
      onClick: () => choose(variant),
      onKeydown: (event) => {
        // The arrows are written in logical terms so they keep meaning the same
        // thing when the page mirrors: "next" is always the next option.
        const forward = isRtl() ? 'ArrowLeft' : 'ArrowRight';
        const back = isRtl() ? 'ArrowRight' : 'ArrowLeft';
        if (event.key === forward || event.key === 'ArrowDown') { event.preventDefault(); step(1); }
        else if (event.key === back || event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
      },
    },
    el('span.variant-label', variant.label || pick(product, 'name')),
    variant.price !== null && el('span.variant-price', money(variant.price)),
    out && el('span.variant-out', t('outOfStock')));
    buttons.set(variant, button);
    group.append(button);
  }

  return {
    node: el('div.field',
      el('span.field-label', t('chooseVariant')),
      group),
    get selected() { return selected; },
  };
}

/** The most this page will ever offer, whatever the shop is holding. */
const BASKET_MAX = 99;

/**
 * What a variant's `available` means to this page: a number is a hard cap, and
 * null — an untracked product, or an older API that does not send the field —
 * is no cap at all. Written once so the stepper, the add button and the cart
 * hand-off cannot read it three slightly different ways.
 */
function capOf(variant) {
  if (!variant) return 0;
  const value = variant.available;
  if (value === null || value === undefined) return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(n, 0) : null;
}

/**
 * The quantity stepper, which now stops where the stock does.
 *
 * The customer used to find out that seven was all there was after filling in a
 * name, a phone number and an address — `WebOrderService.place()` refuses the
 * order, correctly, but at the worst possible moment. So the cap is shown here
 * instead: + goes dead on the last unit and a line says why.
 *
 * This is courtesy, not security. Nothing here is trusted; the server checks
 * every line again inside the ordering transaction.
 */
function quantityStepper() {
  let cap = null;
  let value = 1;

  const output = el('span.qty-value', { 'aria-live': 'polite' }, '1');
  const note = el('p.stock-note', { role: 'status', 'aria-live': 'polite', hidden: true });
  const minus = el('button.step', { type: 'button', 'aria-label': t('decrease'), onClick: () => set(value - 1) },
    icon(ICONS.minus, { size: 16 }));
  const plus = el('button.step', { type: 'button', 'aria-label': t('increase'), onClick: () => set(value + 1) },
    icon(ICONS.plus, { size: 16 }));

  /** The number the + button may reach — the cap, or the basket limit if none. */
  const limit = () => (cap === null ? BASKET_MAX : Math.min(Math.max(cap, 1), BASKET_MAX));

  function paint() {
    output.textContent = String(value);
    const atCap = value >= limit();
    plus.disabled = atCap;
    plus.classList.toggle('is-disabled', atCap);
    minus.disabled = value <= 1;
    minus.classList.toggle('is-disabled', value <= 1);

    // Only ever said about a real stock cap. An untracked product has nothing
    // to confess, and "only 99 left" is not a sentence anybody needs.
    const say = cap !== null && cap > 0 && value >= cap;
    note.hidden = !say;
    note.textContent = say ? t('onlyNLeft', cap) : '';
  }

  function set(next) {
    value = Math.min(Math.max(next, 1), limit());
    paint();
  }

  paint();
  return {
    node: el('div.qty-field', el('div.stepper', minus, output, plus), note),
    get value() { return value; },
    /** Called whenever the chosen option changes — a different colour, a different shelf. */
    setCap(next) {
      cap = next;
      set(value);
    },
  };
}

/**
 * The delivery line, worded to match what `deliveryFor()` will actually charge:
 * a flat fee is one promise ("delivery 50"), a percentage is another ("delivery
 * 5% of your order") and a percent with a floor or a ceiling is a third — a
 * shopper who reads "5%" and then gets charged the minimum on a small order
 * should not feel misled by the small print that sold them the trip.
 */
function percentDeliveryLine(delivery) {
  const pct = number(delivery.percent);
  if (delivery.min !== null && delivery.max !== null) {
    return t('deliveryPercentMinMax', pct, money(delivery.min), money(delivery.max));
  }
  if (delivery.min !== null) return t('deliveryPercentMin', pct, money(delivery.min));
  if (delivery.max !== null) return t('deliveryPercentMax', pct, money(delivery.max));
  return t('deliveryPercent', pct);
}

/**
 * What delivery costs, in one line, for every shape the setting comes in.
 *
 * The shapes are decided exactly as `deliveryPromise()` in views/home.js
 * decides them for the trust row — same three facts, same settings, so the
 * home page and this page cannot end up telling a customer two different
 * things. Only the wording differs, and both wordings already exist in
 * core/i18n.js: `trustDelivery*` is a promise under a heading, `delivery*` is
 * a term in a list. Nothing new is written here.
 */
function deliveryLine(delivery) {
  if (delivery.mode === 'percent' && delivery.percent > 0) return percentDeliveryLine(delivery);
  // A percentage of zero with a floor under it is a flat fee wearing the wrong
  // setting, and it is charged as one (see `deliveryFor` in core/store.js), so
  // it is said as one.
  const flat = delivery.mode === 'percent' ? (delivery.min || 0) : delivery.fee;
  // A shop that charges nothing says so rather than saying nothing: "Delivery 0
  // anywhere in Egypt" is a price tag on something free, and a missing line is
  // a term the customer never learns. The home page's own free-delivery
  // sentence, because it is the one that reads correctly with no figure in it.
  return flat > 0 ? t('deliveryFlat', money(flat)) : t('trustDeliveryFlat', t('free'));
}

/** The small print that answers "and how much is delivery" without leaving the page. */
function deliveryNote() {
  const threshold = freeDeliveryOver();
  const delivery = deliverySettings();
  return el('div.panel.delivery-note',
    el('h2.panel-title', icon(ICONS.truck, { size: 18 }), t('deliveryTitle')),
    el('ul.note-list',
      el('li', t('codShort')),
      el('li', deliveryLine(delivery)),
      threshold && el('li', t('deliveryFreeOver', money(threshold)))));
}

export default async function productView(root, route) {
  const holder = el('div.wrap.stack', skeletonProduct());
  root.append(holder);

  let product;
  try {
    // The server read this product a moment ago to write the page's title and
    // its Open Graph card, and sent it down with the HTML — see core/boot.js.
    // Only ever for the page the customer landed on; every navigation after
    // that asks the API, exactly as before.
    product = takeProduct(route.params.id) || await api.product(route.params.id);
  } catch (error) {
    // A 404 here is ordinary: the piece sold out and was unpublished, and the
    // link is doing the rounds on WhatsApp. It gets a shop-shaped page, not an
    // error card.
    if (error instanceof ShopError && error.status === 404) {
      fill(holder, emptyState({
        title: t('productGoneTitle'),
        body: t('notFoundBody'),
        action: el('a.btn.btn-primary', { href: href('products') }, t('allProducts')),
      }));
      setPageMeta({ title: t('productGoneTitle'), indexable: false });
      return;
    }
    fill(holder, errorState(error, () => { root.replaceChildren(); productView(root, route); }));
    return;
  }

  const name = pick(product, 'name');
  const description = pick(product, 'description');
  /*
   * One address per product, and it carries the product's own name.
   *
   * A link may arrive without the slug (an old `#/product/12`, a URL somebody
   * trimmed out of a message) or with an out-of-date one after a rename. Both
   * load this exact page — the id is what resolves — and both are told which
   * spelling is canonical. `canonicalise` then puts that spelling in the
   * address bar without adding a history entry, so the link a customer copies
   * from the bar is the one Google is indexing.
   *
   * The fallback sentence is `metaProduct` in core/i18n.js, which is the same
   * sentence the server already wrote into the HTML for this page.
   */
  const canonicalPath = routePath('product', { id: product.id, slug: slugFor(product) });
  canonicalise(href(canonicalPath));
  setPageMeta({
    title: name,
    description: (description || '').slice(0, 180) || t('metaProduct', name, shopName()),
    image: product.image_id ? imageUrl(product.image_id) : null,
    canonicalPath,
  });

  const view = gallery(product);
  const priceNode = el('p.price', priceRange(product.price_from, product.price_to));
  const badgeNode = el('div.availability', availabilityBadge(product.availability));

  const picker = variantPicker(product, (variant) => {
    priceNode.textContent = money(variant.price);
    fill(badgeNode, availabilityBadge(variant.availability));
    // Picking a colour should show that colour: the variant's own photo wins
    // when it has one, and the gallery is left alone when it does not, rather
    // than snapping back to the first frame.
    if (variant.image_id) view.show(variant.image_id, { focus: true });
    syncButton();
  });

  const stepper = quantityStepper();
  const selected = () => (picker.node ? picker.selected : (product.variants || [])[0] || null);

  const addButton = el('button.btn.btn-primary.btn-add', { type: 'button' },
    icon(ICONS.bag, { size: 18 }), el('span', t('addToCart')));

  /*
   * The same heart as the one on every card in the grid — literally the same
   * function, so the two can never disagree about whether this piece is saved.
   * Here it carries its words: a corner of a thumbnail has no room for them and
   * does not need them, but this column has both, and "احفظ في المفضلة" beside
   * "أضف إلى السلة" is one less icon for a shopper to interpret at the moment
   * they are deciding. It is a `.btn.btn-ghost` for the same reason — the
   * sheet already draws a secondary pill, and a second way to draw one is what
   * a design system is for avoiding.
   */
  const favButton = favoriteButton(product.id, {
    className: 'btn btn-ghost btn-fav', label: true, size: 19,
  });

  function syncButton() {
    const variant = selected();
    const cap = capOf(variant);
    // `available === 0` and `availability === 'out'` are the same fact arriving
    // by two routes; either one disables the button.
    const blocked = !variant || variant.availability === 'out' || cap === 0;
    stepper.setCap(blocked ? 0 : cap);
    addButton.disabled = blocked;
    addButton.classList.toggle('is-disabled', blocked);
    addButton.title = blocked ? t('unavailableVariant') : '';
  }

  addButton.addEventListener('click', () => {
    const variant = selected();
    const cap = capOf(variant);
    if (!variant || variant.availability === 'out' || cap === 0) return;

    const wanted = stepper.value;
    const held = cart.add({
      variant_id: variant.id,
      product_id: product.id,
      name_en: product.name_en,
      name_ar: product.name_ar,
      label: variant.label,
      price: variant.price,
      tax_rate: product.tax_rate,
      image_id: variant.image_id || product.image_id,
    }, wanted, cap);

    // The basket may already have held some of this. If the cap swallowed part
    // of what was just asked for, say so rather than pretending it went in.
    const capped = cap !== null && held < wanted;
    toast(capped ? t('onlyNLeft', cap) : t('addedToCart'),
      el('a.toast-link', { href: href('cart') }, t('viewCart')));
  });

  // If a single option was pre-selected, show its price rather than a range of one.
  const initial = selected();
  if (initial && (product.variants || []).length === 1) priceNode.textContent = money(initial.price);
  if (initial && picker.node) {
    priceNode.textContent = money(initial.price);
    fill(badgeNode, availabilityBadge(initial.availability));
    if (initial.image_id) view.show(initial.image_id);
  }
  syncButton();

  fill(holder,
    crumbs(product),
    el('div.product-layout',
      view.node,
      el('div.product-info',
        pick(product, 'brand_name') && el('a.product-brand', { href: href(routePath('brand', { id: product.brand_id, slug: slugFor(product, 'brand_name') })) },
          pick(product, 'brand_name')),
        el('h1.product-name', name),
        priceNode,
        badgeNode,
        picker.node,
        el('div.buy-row',
          el('div.field.field-qty',
            el('span.field-label', t('quantity')),
            stepper.node),
          addButton),
        // Its own line under the buy row rather than a third control inside it:
        // the row is quantity-then-buy, and a wide "Save to favourites" wedged
        // beside a 220px "Add to cart" is what pushes that row over the width of
        // this column on a desktop. Underneath it hugs its own words at every
        // width and never competes with the primary.
        favButton,
        description && el('section.panel',
          el('h2.panel-title', t('aboutThisPiece')),
          el('p.prose', description)),
        deliveryNote())));
}
