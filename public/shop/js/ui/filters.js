/**
 * The filter panel — the shop's own way of narrowing a shelf down.
 *
 * ── What a filter panel has to get right ────────────────────────────────────
 * Three things, and most of the work here is the third:
 *
 *  1. It has to say what the shop actually holds. Every option carries a count
 *     and an option with a count of zero is not drawn at all, so a shopper can
 *     never tick a box and land on an empty page. The counts come from the
 *     server, over the same scope the listing uses.
 *
 *  2. It has to survive being shared. Every choice lives in the URL —
 *     `?gender=men&sale=1&min=200&max=800&attr=3,7` — so a filtered shelf is a
 *     link somebody can send to a friend, reload, or reach with the back
 *     button. Nothing is held in a variable that a refresh would lose.
 *
 *  3. It has to work on a phone held in one hand. On a wide screen it is a
 *     column beside the grid; under 900px the same markup becomes a sheet that
 *     slides up from the bottom, with the number of active filters on the
 *     button that opens it and one clear way out. It is the same DOM in both —
 *     no second implementation to keep in step, and no state lost when a phone
 *     is turned sideways.
 *
 * ── RTL ─────────────────────────────────────────────────────────────────────
 * Nothing in here names left or right. The panel sits at `inset-inline-start`,
 * the sheet slides from the block end, and the price inputs are ordered by the
 * document's own direction — so the Arabic shop gets the mirror image for free
 * and the English one is not a special case.
 */
import { el, fill } from '../core/dom.js';
import { t, pick } from '../core/i18n.js';
import { money } from '../core/format.js';

/** The genders, in the order the ERP lists them, with their labels. */
const GENDERS = [
  ['women', 'genderWomen'],
  ['men', 'genderMen'],
  ['unisex', 'genderUnisex'],
];

/**
 * How many filters are switched on — the number on the phone's button.
 *
 * A price bound only counts when it is actually narrower than the shop's own
 * range, or every listing would open claiming two active filters nobody set.
 */
export function activeCount(state, options) {
  let count = state.gender.length + state.attr.length;
  if (state.onSale) count += 1;
  if (state.inStock) count += 1;
  if (options?.price) {
    if (state.min && state.min > options.price.min) count += 1;
    if (state.max && state.max < options.price.max) count += 1;
  }
  return count;
}

/** A labelled group of checkboxes, drawn only when it has something in it. */
function group(title, children) {
  if (!children.length) return null;
  return el('section.filter-group',
    el('h3.filter-title', title),
    el('div.filter-options', children));
}

/**
 * One checkbox. The whole row is the label, so the tap target is the row and
 * not the 16px box — the single most common complaint about filter panels on
 * phones, and it costs one element to avoid.
 */
function check({ id, label, count, checked, onChange, swatch }) {
  const box = el('input', {
    type: 'checkbox', id, checked: checked ? 'checked' : null, onChange,
  });
  if (checked) box.checked = true;
  return el('label.filter-option', { for: id },
    box,
    swatch ? el('span.filter-swatch', { style: `--swatch: ${swatch}` }) : null,
    el('span.filter-label', label),
    typeof count === 'number' ? el('span.filter-count', String(count)) : null);
}

/**
 * Build the panel.
 *
 * @param {object} options the facets from `/api/shop/filters`
 * @param {object} state   what is currently ticked
 * @param {function} onChange called with the next state; the caller navigates
 *        so that the URL — not this component — remains the source of truth
 */
export function filterPanel(options, state, onChange) {
  const next = (changes) => onChange({ ...state, ...changes });

  const toggleIn = (list, value) => (list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value]);

  const genders = group(t('filterGender'), GENDERS
    .filter(([value]) => options.genders.some((row) => row.value === value))
    .map(([value, key]) => {
      const row = options.genders.find((entry) => entry.value === value);
      return check({
        id: `f-gender-${value}`,
        label: t(key),
        count: row.product_count,
        checked: state.gender.includes(value),
        onChange: () => next({ gender: toggleIn(state.gender, value), page: 1 }),
      });
    }));

  const offers = options.onSale > 0
    ? group(t('filterOffers'), [
      check({
        id: 'f-sale',
        label: t('filterOnSale'),
        count: options.onSale,
        checked: state.onSale,
        onChange: () => next({ onSale: !state.onSale, page: 1 }),
      }),
    ])
    : null;

  /*
   * Price. Two number boxes rather than a two-handle slider: a slider is
   * charming with a mouse and miserable with a thumb, and it cannot be typed
   * into by somebody who knows exactly what they want to spend. The bounds are
   * the shop's real cheapest and dearest — after offers — so the placeholders
   * teach the range without anybody having to drag anything to find it.
   */
  const minInput = el('input.input.filter-price', {
    type: 'number', inputmode: 'numeric', min: options.price.min, max: options.price.max,
    value: state.min || '', placeholder: String(options.price.min),
    'aria-label': t('filterMinPrice'),
  });
  const maxInput = el('input.input.filter-price', {
    type: 'number', inputmode: 'numeric', min: options.price.min, max: options.price.max,
    value: state.max || '', placeholder: String(options.price.max),
    'aria-label': t('filterMaxPrice'),
  });
  const applyPrice = () => next({
    min: Number(minInput.value) || null,
    max: Number(maxInput.value) || null,
    page: 1,
  });
  for (const input of [minInput, maxInput]) {
    input.addEventListener('change', applyPrice);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); applyPrice(); }
    });
  }
  const price = options.price.max > options.price.min
    ? el('section.filter-group',
      el('h3.filter-title', t('filterPrice')),
      el('div.filter-price-row',
        minInput,
        el('span.filter-dash', '—'),
        maxInput),
      el('p.filter-note', t('filterPriceNote', money(options.price.min), money(options.price.max))))
    : null;

  const stock = group(t('filterAvailability'), [
    check({
      id: 'f-stock',
      label: t('filterInStock'),
      checked: state.inStock,
      onChange: () => next({ inStock: !state.inStock, page: 1 }),
    }),
  ]);

  // Whatever the shop actually uses — size, colour, concentration. A shop that
  // has never set an attribute up simply has no such group.
  const attributes = options.attributes.map((attribute) => group(
    pick(attribute, 'name'),
    attribute.values.map((value) => check({
      id: `f-attr-${value.id}`,
      label: pick(value, 'value'),
      count: value.product_count,
      swatch: attribute.input_type === 'color' ? value.color_hex : null,
      checked: state.attr.includes(String(value.id)),
      onChange: () => next({ attr: toggleIn(state.attr, String(value.id)), page: 1 }),
    })),
  ));

  const count = activeCount(state, options);

  return el('div.filter-body',
    el('div.filter-head',
      el('h2.filter-heading', t('filters')),
      count > 0
        ? el('button.btn.btn-ghost.btn-sm', {
          type: 'button',
          onClick: () => onChange({
            gender: [], attr: [], onSale: false, inStock: false, min: null, max: null, page: 1,
          }),
        }, t('clearFilters'))
        : null),
    genders,
    offers,
    price,
    stock,
    ...attributes);
}

/**
 * The whole thing, wired: a sidebar on a wide screen, a sheet on a phone.
 *
 * Returns the elements rather than mounting them, so the listing decides where
 * they go — and so this file never has to know what a listing looks like.
 */
export function filterUi(options, state, onChange) {
  const panel = el('aside.filters-panel', { id: 'shop-filters' }, filterPanel(options, state, onChange));
  const count = activeCount(state, options);

  const close = () => {
    panel.classList.remove('is-open');
    document.body.classList.remove('filters-open');
  };
  const open = () => {
    panel.classList.add('is-open');
    document.body.classList.add('filters-open');
    // Focus moves into the sheet, so a keyboard or a screen reader is not left
    // behind on the button that opened it.
    panel.querySelector('input, button')?.focus();
  };

  panel.prepend(el('button.filter-close', {
    type: 'button', 'aria-label': t('close'), onClick: close,
  }, '✕'));

  const toggle = el('button.btn.btn-ghost.filters-toggle', {
    type: 'button',
    'aria-controls': 'shop-filters',
    onClick: open,
  }, t('filters'), count > 0 ? el('span.filters-badge', String(count)) : null);

  const scrim = el('div.filters-scrim', { onClick: close });

  // Escape closes the sheet, because a sheet that can only be dismissed by
  // finding a small ✕ is a trap on a phone and on a keyboard alike.
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  panel.dataset.cleanup = 'filters';

  return { panel, toggle, scrim, dispose: () => document.removeEventListener('keydown', onKey) };
}
