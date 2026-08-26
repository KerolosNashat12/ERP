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
 * ── The option picker ────────────────────────────────────────────────────────
 *
 * What was here before: one row of chips, each carrying the variant's own
 * shorthand label and the same price as all the others. Two things wrong with
 * that, and the shop's owner named both.
 *
 * FIRST, the price. Nine options each printing "1,000 ج.م" under a heading that
 * already says 1,000 ج.م in the largest type on the page is the price nine
 * times and the choice once. A price belongs to an option only when it is NOT
 * the same as the others — then it is the whole point.
 *
 * SECOND, and this is the bigger one: the ATTRIBUTE HAD NO NAME. `variant_label`
 * is a shorthand somebody typed — "30ml / Black" — and a customer reading nine
 * of them is reading nine words with no heading over them. The shop has already
 * recorded the real thing in the ERP: an attribute called الحجم, values called
 * ٣٠ مل and ٥٠ مل, sometimes with a colour against them. The storefront simply
 * never read it. It does now, so the page says «الحجم: ٣٠ مل» — the shop's own
 * words, in the shop's own order.
 *
 * A product whose shop never set attributes up still works exactly as before,
 * from `variant_label`. That fallback is not a leftover; it is most shops on
 * the first day.
 */

/**
 * The attributes shared by EVERY variant of this product.
 *
 * "Every" matters: the picker resolves a choice by matching a value in each
 * group, so an attribute only some variants carry would make combinations that
 * cannot be selected. One missing row in the ERP should cost a heading, never
 * the ability to buy.
 */
function attributeGroups(variants) {
  const all = variants.map((variant) => variant.options || []);
  if (all.some((options) => !options.length)) return [];

  const order = [];
  const groups = new Map();
  for (const options of all) {
    for (const option of options) {
      if (!groups.has(option.attribute_id)) {
        order.push(option.attribute_id);
        groups.set(option.attribute_id, {
          id: option.attribute_id,
          name_en: option.attribute_en,
          name_ar: option.attribute_ar,
          input_type: option.input_type,
          values: new Map(),
          seen: 0,
        });
      }
      const group = groups.get(option.attribute_id);
      if (!group.values.has(option.value_id)) {
        group.values.set(option.value_id, {
          id: option.value_id,
          value_en: option.value_en,
          value_ar: option.value_ar,
          color_hex: option.color_hex,
        });
      }
    }
  }
  for (const options of all) {
    for (const id of new Set(options.map((option) => option.attribute_id))) {
      groups.get(id).seen += 1;
    }
  }

  return order
    .map((id) => groups.get(id))
    // Carried by every variant, and actually a choice: an attribute with one
    // value is a fact about the product, not a decision, and belongs in the
    // description rather than as a row of one button.
    .filter((group) => group.seen === variants.length && group.values.size > 1)
    .map((group) => ({ ...group, values: [...group.values.values()] }));
}

/** The value this variant carries for one attribute. */
const valueOf = (variant, attributeId) => (variant.options || [])
  .find((option) => option.attribute_id === attributeId)?.value_id ?? null;

/** A value's own name, in the reader's language, with the other as the fallback. */
const valueName = (value) => (getLanguage() === 'ar'
  ? (value.value_ar || value.value_en) : (value.value_en || value.value_ar));

const groupName = (group) => (getLanguage() === 'ar'
  ? (group.name_ar || group.name_en) : (group.name_en || group.name_ar));


/**
 * The price line on a product page, with an offer on it when there is one.
 *
 * Its own function because it is drawn once and then REDRAWN every time a
 * shopper picks a different option — and both paths have to produce the same
 * thing. The first version of this page updated `textContent`, which quietly
 * threw away the struck-through price the moment somebody chose a size.
 */
function paintPrice(node, { price, listPrice, range }) {
  if (!(listPrice > price)) {
    fill(node, el('span', range || money(price)));
    return;
  }
  const percent = Math.round(((listPrice - price) / listPrice) * 100);
  fill(node,
    el('span.price-now', range || money(price)),
    el('s.price-was', { 'aria-hidden': 'true' }, money(listPrice)),
    el('span.price-off', t('saveOff', percent)));
}

/**
 * Does the price change between options? If every one costs the same, the
 * figure belongs to the product and is printed once, above.
 */
function pricesVary(variants) {
  const prices = variants.map((variant) => variant.price).filter((price) => price !== null);
  return prices.length > 1 && new Set(prices.map(Number)).size > 1;
}

/** One chip: a swatch where there is something to show, a name, sometimes a price. */
function optionChip({
  label, price, out, swatchColour, swatchImage, checked, onChoose, onStep,
}) {
  const swatch = swatchColour
    ? el('span.variant-swatch.is-colour', { style: `background:${swatchColour}` })
    : (swatchImage
      // Decorative: the option is named beside it, so a screen reader that also
      // read the picture would hear the same thing twice.
      ? el('span.variant-swatch', el('img', {
        src: imageUrl(swatchImage), alt: '', loading: 'lazy', decoding: 'async',
      }))
      : null);

  return el('button.variant', {
    type: 'button',
    role: 'radio',
    class: [out ? 'is-out' : '', swatch ? 'has-swatch' : ''].filter(Boolean).join(' '),
    disabled: out,
    tabIndex: checked ? 0 : -1,
    'aria-checked': checked ? 'true' : 'false',
    title: out ? t('unavailableVariant') : '',
    onClick: onChoose,
    onKeydown: (event) => {
      // Written in logical terms so the arrows keep meaning the same thing when
      // the page mirrors: "next" is always the next option.
      const forward = isRtl() ? 'ArrowLeft' : 'ArrowRight';
      const back = isRtl() ? 'ArrowRight' : 'ArrowLeft';
      if (event.key === forward || event.key === 'ArrowDown') { event.preventDefault(); onStep(1); }
      else if (event.key === back || event.key === 'ArrowUp') { event.preventDefault(); onStep(-1); }
    },
  },
  swatch,
  el('span.variant-text',
    el('span.variant-label', label),
    price !== null && price !== undefined && el('span.variant-price', money(price)),
    out && el('span.variant-out', t('outOfStock'))));
}

/**
 * The picker for a shop that HAS named its attributes: one row per attribute,
 * each headed with the attribute's own name and the chosen value.
 *
 * Choosing a value keeps as much of the rest of the selection as the shop
 * actually stocks: pick a different size and the colour you had stays if that
 * combination exists, and moves to one that does if it does not. Silently
 * landing on a combination nobody sells is the failure mode this avoids.
 */
function groupedPicker(product, variants, groups, onPick) {
  const showPrice = pricesVary(variants);
  const inStock = (variant) => variant.availability !== 'out';
  let selected = variants.find(inStock) || variants[0];

  const rows = groups.map((group) => ({ group, chosen: el('span.field-chosen'), host: el('div.variants', { role: 'radiogroup', 'aria-label': groupName(group) }) }));

  /** Every variant that carries this value, best-stocked first. */
  const carrying = (group, value) => variants
    .filter((variant) => valueOf(variant, group.id) === value.id)
    .sort((a, b) => Number(inStock(b)) - Number(inStock(a)));

  /**
   * The variant to move to when `value` is picked: the one that agrees with the
   * current selection on the most OTHER attributes, preferring one in stock.
   */
  function resolve(group, value) {
    const candidates = carrying(group, value);
    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      let score = groups.reduce((total, other) => (
        other.id !== group.id && valueOf(candidate, other.id) === valueOf(selected, other.id)
          ? total + 1 : total), 0);
      if (inStock(candidate)) score += groups.length; // stocked beats similar
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }

  function paint({ focus = null } = {}) {
    for (const row of rows) {
      const chosenId = valueOf(selected, row.group.id);
      const chosenValue = row.group.values.find((value) => value.id === chosenId);
      row.chosen.textContent = chosenValue ? valueName(chosenValue) : '';

      const chips = row.group.values.map((value, index) => {
        const candidates = carrying(row.group, value);
        const out = candidates.length > 0 && !candidates.some(inStock);
        const representative = candidates[0] || null;
        const checked = value.id === chosenId;
        return optionChip({
          label: valueName(value),
          // A price under an option only where the options differ, and only in
          // a shop with ONE attribute — with two, the price belongs to the
          // combination and putting it on one half of it would be a lie.
          price: showPrice && groups.length === 1 && representative ? representative.price : null,
          out,
          swatchColour: row.group.input_type === 'color' ? value.color_hex : null,
          swatchImage: groups.length === 1 ? representative?.image_id : null,
          checked,
          onChoose: () => choose(row.group, value),
          onStep: (delta) => {
            const pickable = row.group.values.filter((entry) => {
              const list = carrying(row.group, entry);
              return list.length === 0 || list.some(inStock);
            });
            const at = pickable.findIndex((entry) => entry.id === chosenId);
            const next = pickable[((at === -1 ? index : at) + delta + pickable.length) % pickable.length];
            choose(row.group, next, { focus: true });
          },
        });
      });
      fill(row.host, chips);
      if (focus === row.group.id) {
        row.host.querySelector('[aria-checked="true"]')?.focus();
      }
    }
  }

  function choose(group, value, { focus = false } = {}) {
    const next = resolve(group, value);
    if (!next) return;
    selected = next;
    paint({ focus: focus ? group.id : null });
    onPick(selected);
  }

  paint();

  return {
    node: el('div.field-groups', rows.map((row) => el('div.field.field-variants',
      el('span.field-label', groupName(row.group), row.chosen),
      row.host))),
    get selected() { return selected; },
  };
}

/**
 * The picker for a shop that has not named anything yet: the variants' own
 * labels, in one row. What this file did before, kept because it is what most
 * shops have on their first day.
 */
function labelPicker(product, variants, onPick) {
  const showPrice = pricesVary(variants);
  const chosen = el('span.field-chosen');
  const host = el('div.variants', { role: 'radiogroup', 'aria-label': t('chooseVariant') });
  let selected = variants.find((variant) => variant.availability !== 'out') || null;

  const pickable = variants.filter((variant) => variant.availability !== 'out');

  function paint({ focus = false } = {}) {
    chosen.textContent = selected?.label || '';
    fill(host, variants.map((variant) => optionChip({
      label: variant.label || pick(product, 'name'),
      price: showPrice ? variant.price : null,
      out: variant.availability === 'out',
      swatchColour: null,
      swatchImage: variant.image_id,
      checked: variant === selected,
      onChoose: () => choose(variant),
      onStep: (delta) => {
        const at = pickable.indexOf(selected);
        choose(pickable[(at + delta + pickable.length) % pickable.length], { focus: true });
      },
    })));
    if (focus) host.querySelector('[aria-checked="true"]')?.focus();
  }

  function choose(variant, { focus = false } = {}) {
    if (!variant || variant.availability === 'out') return;
    selected = variant;
    paint({ focus });
    onPick(variant);
  }

  paint();

  return {
    node: el('div.field.field-variants',
      el('span.field-label', t('chooseVariant'), chosen),
      host),
    get selected() { return selected; },
  };
}

function variantPicker(product, onPick) {
  const variants = product.variants || [];
  if (variants.length <= 1) return { node: null, selected: variants[0] || null };
  const groups = attributeGroups(variants);
  return groups.length
    ? groupedPicker(product, variants, groups, onPick)
    : labelPicker(product, variants, onPick);
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
  const priceNode = el('p.price', { class: product.on_sale ? 'is-sale' : '' });
  paintPrice(priceNode, {
    price: product.price_from,
    listPrice: product.on_sale ? product.list_price_from : 0,
    range: priceRange(product.price_from, product.price_to),
  });
  const badgeNode = el('div.availability', availabilityBadge(product.availability));

  const picker = variantPicker(product, (variant) => {
    // The chosen variant's own offer, not the product's range: picking 50ml on
    // a product that is 20% off shows the 50ml pair of prices.
    priceNode.classList.toggle('is-sale', Boolean(variant.list_price));
    paintPrice(priceNode, { price: variant.price, listPrice: variant.list_price || 0 });
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
  if (initial && (product.variants || []).length === 1) {
    priceNode.classList.toggle('is-sale', Boolean(initial.list_price));
    paintPrice(priceNode, { price: initial.price, listPrice: initial.list_price || 0 });
  }
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
        /*
         * The buy box: quantity, then buy, then save — one column, one width.
         *
         * They used to be laid out separately: the add button stretched to
         * whatever was left of the row while the heart underneath hugged its own
         * words, so no two edges in the most important part of the page lined up
         * with each other. Three controls that belong to one decision are one
         * block now, and the block has a maximum width so that a wide desktop
         * gives the column air rather than a button a metre long.
         */
        el('div.buy-box',
          el('div.field.field-qty',
            el('span.field-label', t('quantity')),
            stepper.node),
          el('div.buy-actions', addButton, favButton)),
        description && el('section.panel',
          el('h2.panel-title', t('aboutThisPiece')),
          el('p.prose', description)),
        deliveryNote())));
}
