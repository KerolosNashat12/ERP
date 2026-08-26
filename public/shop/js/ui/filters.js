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

/**
 * A group that cannot narrow anything is not drawn.
 *
 * The case that made this a rule: a shop whose 163 products are all still
 * «للجنسين» drew a gender group with one box reading 163 — a filter that, when
 * ticked, returns exactly what was already on screen. A shopper who ticks it
 * and sees nothing happen learns to distrust the whole panel.
 *
 * So: at least two options, or one that leaves something out.
 */
const canNarrow = (rows, total) => {
  const useful = rows.filter((row) => Number(row.product_count) > 0);
  if (!useful.length) return false;
  if (useful.length > 1) return true;
  return Number(useful[0].product_count) < total;
};

/**
 * A labelled group, collapsible when it is long.
 *
 * `<details>` and not a click handler on a heading: it opens on a keyboard, it
 * is announced as a disclosure, it survives having no JavaScript at all, and
 * the browser remembers nothing between renders — which is why `open` is passed
 * in rather than left to the element.
 *
 * A group with a choice made inside it always opens, whatever its length. A
 * collapsed section hiding a filter that is currently ON is how a shopper ends
 * up staring at four products and no explanation.
 */
function group(title, children, { open = true, chosen = 0 } = {}) {
  if (!children.length) return null;
  return el('details.filter-group', { open: open || chosen > 0 ? 'open' : null },
    el('summary.filter-title',
      el('span', title),
      chosen > 0 ? el('span.filter-chosen', String(chosen)) : null,
      el('span.filter-caret', { 'aria-hidden': 'true' })),
    el('div.filter-options', children));
}

/**
 * A row of chips — for a short list of choices that are one idea.
 *
 * Gender is three mutually understandable words, and three checkboxes stacked
 * with counts beside them reads like a form. Three chips read like a choice,
 * which is what it is, and they are a thumb's width on a phone.
 */
function chipRow(entries) {
  return el('div.filter-chips', entries.map(({ label, count, active, onChoose }) => {
    const button = el('button.filter-chip', {
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      onClick: onChoose,
    }, el('span', label), typeof count === 'number' ? el('span.chip-count', String(count)) : null);
    if (active) button.classList.add('is-on');
    return button;
  }));
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
 * What is switched on, as removable chips above the results.
 *
 * The panel says what COULD be chosen; this says what IS, in the place a
 * shopper is actually looking — at the products. On a phone the panel is behind
 * a button, so without this row there is nothing on screen explaining why a
 * shelf of 163 is showing 4, and the answer is two taps away.
 *
 * Every chip removes exactly its own filter. "Clear everything" is separate and
 * last, because undoing one choice is the common case and undoing all of them
 * is the giving-up case.
 */
export function activeChips(options, state, onChange) {
  const next = (changes) => onChange({ ...state, ...changes, page: 1 });
  const chips = [];

  for (const value of state.gender) {
    const entry = GENDERS.find(([name]) => name === value);
    if (!entry) continue;
    chips.push({
      label: t(entry[1]),
      clear: () => next({ gender: state.gender.filter((name) => name !== value) }),
    });
  }

  if (state.onSale) chips.push({ label: t('filterOnSale'), clear: () => next({ onSale: false }) });
  if (state.inStock) chips.push({ label: t('filterInStock'), clear: () => next({ inStock: false }) });

  if (state.min || state.max) {
    const label = state.min && state.max
      ? `${money(state.min)} – ${money(state.max)}`
      : (state.min ? t('priceOver', money(state.min)) : t('priceUnder', money(state.max)));
    chips.push({ label, clear: () => next({ min: null, max: null }) });
  }

  for (const id of state.attr) {
    // The id came out of a URL; its NAME has to be looked up in the facets, and
    // a value the shop has since retired simply has no chip rather than an
    // empty one.
    let found = null;
    for (const attribute of options.attributes || []) {
      const value = attribute.values.find((entry) => String(entry.id) === String(id));
      if (value) { found = value; break; }
    }
    if (!found) continue;
    chips.push({
      label: pick(found, 'value'),
      clear: () => next({ attr: state.attr.filter((entry) => entry !== id) }),
    });
  }

  if (!chips.length) return null;

  return el('div.active-filters',
    chips.map((chip) => el('button.active-chip', {
      type: 'button',
      onClick: chip.clear,
      'aria-label': `${t('clearFilters')}: ${chip.label}`,
    }, el('span', chip.label), el('span.chip-x', { 'aria-hidden': 'true' }, '✕'))),
    chips.length > 1
      ? el('button.active-clear', {
        type: 'button',
        onClick: () => onChange({
          gender: [], attr: [], onSale: false, inStock: false, min: null, max: null, page: 1,
        }),
      }, t('clearFilters'))
      : null);
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

  const total = options.genders.reduce((sum, row) => sum + Number(row.product_count || 0), 0);

  const genders = canNarrow(options.genders, total)
    ? group(t('filterGender'), [chipRow(GENDERS
      .filter(([value]) => options.genders.some((row) => row.value === value))
      .map(([value, key]) => {
        const row = options.genders.find((entry) => entry.value === value);
        return {
          label: t(key),
          count: row.product_count,
          active: state.gender.includes(value),
          onChoose: () => next({ gender: toggleIn(state.gender, value), page: 1 }),
        };
      }))], { chosen: state.gender.length })
    : null;

  /*
   * The offers switch is a switch, not a checkbox in a list of one. It is the
   * single most-used control on a shop's filter panel and it deserves to look
   * like a decision rather than an item.
   */
  const offers = options.onSale > 0 && options.onSale < total
    ? el('section.filter-group.filter-switch',
      el('label.switch-row', { for: 'f-sale' },
        el('span.switch-label', t('filterOnSale'), el('span.filter-count', String(options.onSale))),
        (() => {
          const box = el('input.switch-input', {
            type: 'checkbox',
            id: 'f-sale',
            onChange: () => next({ onSale: !state.onSale, page: 1 }),
          });
          if (state.onSale) box.checked = true;
          return box;
        })(),
        el('span.switch-track', el('span.switch-knob'))))
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
  /*
   * Three quick bands over the shop's own range, then the two boxes.
   *
   * The bands are where most shopping actually happens — "cheap", "middle",
   * "the good stuff" — and they are computed from this shop's real prices
   * rather than from round numbers that would mean nothing in a perfume shop
   * where the range is 100 to 5,000. Typing an exact figure is still there
   * underneath for somebody who knows what they want to spend.
   */
  const bands = (() => {
    const low = Math.floor(options.price.min);
    const high = Math.ceil(options.price.max);
    if (!(high > low)) return [];
    const step = Math.round((high - low) / 3);
    const first = low + step;
    const second = low + step * 2;
    return [
      { label: t('priceUnder', money(first)), min: null, max: first },
      { label: `${money(first)} – ${money(second)}`, min: first, max: second },
      { label: t('priceOver', money(second)), min: second, max: null },
    ];
  })();

  const price = options.price.max > options.price.min
    ? el('details.filter-group', { open: 'open' },
      el('summary.filter-title',
        el('span', t('filterPrice')),
        (state.min || state.max) ? el('span.filter-chosen', '1') : null,
        el('span.filter-caret', { 'aria-hidden': 'true' })),
      el('div.filter-options',
        el('div.filter-chips', bands.map((band) => {
          const active = Number(state.min || 0) === Number(band.min || 0)
            && Number(state.max || 0) === Number(band.max || 0);
          const button = el('button.filter-chip', {
            type: 'button',
            'aria-pressed': active ? 'true' : 'false',
            onClick: () => next({
              min: active ? null : band.min, max: active ? null : band.max, page: 1,
            }),
          }, el('span', band.label));
          if (active) button.classList.add('is-on');
          return button;
        })),
        el('div.filter-price-row', minInput, el('span.filter-dash', '—'), maxInput),
        el('p.filter-note', t('filterPriceNote', money(options.price.min), money(options.price.max)))))
    : null;

  const stock = el('section.filter-group.filter-switch',
    el('label.switch-row', { for: 'f-stock' },
      el('span.switch-label', t('filterInStock')),
      (() => {
        const box = el('input.switch-input', {
          type: 'checkbox',
          id: 'f-stock',
          onChange: () => next({ inStock: !state.inStock, page: 1 }),
        });
        if (state.inStock) box.checked = true;
        return box;
      })(),
      el('span.switch-track', el('span.switch-knob'))));

  // Whatever the shop actually uses — size, colour, concentration. A shop that
  // has never set an attribute up simply has no such group.
  /*
   * Whatever the shop actually uses — size, colour, concentration. A list
   * longer than six starts closed, because a panel that opens two screens tall
   * is a panel a shopper scrolls past rather than reads.
   */
  const attributes = options.attributes
    .filter((attribute) => canNarrow(attribute.values, total))
    .map((attribute) => {
      const chosen = attribute.values
        .filter((value) => state.attr.includes(String(value.id))).length;
      return group(
        pick(attribute, 'name'),
        attribute.values.map((value) => check({
          id: `f-attr-${value.id}`,
          label: pick(value, 'value'),
          count: value.product_count,
          swatch: attribute.input_type === 'color' ? value.color_hex : null,
          checked: state.attr.includes(String(value.id)),
          onChange: () => next({ attr: toggleIn(state.attr, String(value.id)), page: 1 }),
        })),
        { open: attribute.values.length <= 6, chosen },
      );
    });

  const count = activeCount(state, options);

  return el('div.filter-body',
    el('div.filter-head',
      el('h2.filter-heading', t('filters'),
        count > 0 ? el('span.filter-total', String(count)) : null),
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
export function filterUi(options, state, onChange, { startOpen = false, total = 0 } = {}) {
  const panel = el('aside.filters-panel', { id: 'shop-filters' }, filterPanel(options, state, onChange));

  const close = () => {
    panel.classList.remove('is-open');
    document.body.classList.remove('filters-open');
  };
  const open = ({ focus = true } = {}) => {
    panel.classList.add('is-open');
    document.body.classList.add('filters-open');
    // Focus moves into the sheet when a person opened it, so a keyboard or a
    // screen reader is not left behind on the button. NOT on a re-render: the
    // sheet reopening under a thumb should not also steal what was focused.
    if (focus) panel.querySelector('button, input')?.focus();
  };

  panel.prepend(el('button.filter-close', {
    type: 'button', 'aria-label': t('close'), onClick: close,
  }, '✕'));

  /*
   * The sheet's own way out, and the reason the sheet stays open between
   * choices.
   *
   * Every choice re-renders this whole view — that is what keeps the URL the
   * single source of truth — and the first version of this let the sheet close
   * itself on every tick while leaving the scrim behind: a dark overlay over a
   * page that could not be scrolled, on a phone, with no way back except
   * reloading. Now the sheet is rebuilt already open, so a shopper can tick
   * three things and watch the count change, and ONE button says how many
   * products are waiting and puts them on screen.
   */
  panel.append(el('div.filter-apply',
    el('button.btn.btn-primary.filter-apply-btn', {
      type: 'button', onClick: close,
    }, t('showResults', total))));

  if (startOpen) open({ focus: false });

  const count = activeCount(state, options);
  const toggle = el('button.btn.btn-ghost.filters-toggle', {
    type: 'button',
    'aria-controls': 'shop-filters',
    onClick: () => open(),
  }, t('filters'), count > 0 ? el('span.filters-badge', String(count)) : null);

  const scrim = el('div.filters-scrim', { onClick: close });

  // Escape closes the sheet, because a sheet that can only be dismissed by
  // finding a small ✕ is a trap on a phone and on a keyboard alike.
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  return {
    panel, toggle, scrim, open, close, dispose: () => document.removeEventListener('keydown', onKey),
  };
}
