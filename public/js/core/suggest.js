/**
 * THE SUGGESTION LIST — attached to a search box, not replacing it.
 *
 * `attachSuggest(input, …)` decorates an input that already exists and already
 * works. That is the whole design decision: this ERP has fourteen search boxes
 * across a dozen screens, each wired to its own screen's filtering, and
 * rewriting them into one component would have meant re-testing every list in
 * the product. A decorator gives all of them suggestions and changes none of
 * their existing behaviour — what the box did on Enter, on input, on blur, it
 * still does.
 *
 * ── The scanner must not notice this exists ─────────────────────────────────
 * The topbar box is where a barcode is scanned. A scanner types a whole code in
 * under 80ms and presses Enter; a person types at maybe 200ms a character. So
 * the request is debounced past the speed of a scan, and Enter closes the list
 * and yields to whatever the input already did. A dropdown that swallowed Enter
 * would break every scan in the shop, which is a worse bug than no suggestions
 * at all.
 *
 * ── Why the dropdown is a sibling and not a child ───────────────────────────
 * It is appended next to the input inside a positioned wrapper. Appending it to
 * `body` would need scroll and resize listeners to follow the input around, and
 * one of them would eventually leak and leave a menu floating over an unrelated
 * screen. As a sibling it moves with the box for free and dies when the screen
 * that owns it is unmounted.
 */
import api from './api.js';
import { h, mount, debounce } from './ui.js';
import { t, pick } from './i18n.js';
import { money } from './format.js';
import { navigate } from './router.js';

/**
 * Slower than a scanner, faster than a thought. A scan is finished and the box
 * cleared long before this fires, so scanning never opens a menu.
 */
const DEBOUNCE_MS = 220;

/** Below this a term matches most of a catalogue and the list is just noise. */
const MIN_CHARS = 2;

/** What each group is called, and where clicking one of its rows goes. */
const GROUPS = {
  product: { label: 'products', href: (row) => `products/${row.id}` },
  brand: { label: 'brands', href: (row) => `products?brandId=${row.id}` },
  category: { label: 'categories', href: (row) => `products?categoryId=${row.id}` },
  supplier: { label: 'suppliers', href: (row) => `suppliers/${row.id}` },
  customer: { label: 'customers', href: (row) => `customers/${row.id}` },
  sale: { label: 'sales', href: (row) => `sales/${row.id}` },
  purchase: { label: 'purchases', href: (row) => `purchases/${row.id}` },
};

/**
 * The one-line explanation above the list, when there IS one worth giving.
 *
 * Only for the readings a person did not knowingly ask for. Telling somebody
 * "this matched because it starts with what you typed" is noise; telling them
 * "your keyboard was on English" is the answer to why the box looked broken.
 */
const TIER_NOTE = {
  layout: 'suggestLayoutNote',
  skeleton: 'suggestScriptNote',
  typo: 'suggestTypoNote',
};

export function attachSuggest(input, {
  onPick = null,
  scope = null,
} = {}) {
  const menu = h('div', { class: 'suggest-menu', hidden: true, role: 'listbox' });
  const wrap = h('div', { class: 'suggest-wrap' });

  // The input keeps its place in the DOM; the wrapper takes that place and the
  // input moves inside it. Doing it this way means a caller can attach to a box
  // that is already mounted and laid out.
  input.parentNode?.insertBefore(wrap, input);
  wrap.append(input, menu);
  input.setAttribute('autocomplete', 'off');

  let rows = [];
  let active = -1;
  let token = 0;
  /*
   * The Enter this list acted on, kept so another listener on the same input
   * can ask whether it was already spoken for. `event.defaultPrevented` cannot
   * answer that question here: the global barcode scanner runs on `document`
   * in the CAPTURE phase and has already prevented the default before any
   * listener on the box is reached, so every Enter looks handled.
   */
  let consumed = null;

  const close = () => {
    menu.hidden = true;
    active = -1;
    rows = [];
  };

  const go = (entry) => {
    close();
    if (onPick && onPick(entry) === true) return;
    navigate(GROUPS[entry.kind].href(entry.row));
  };

  function paint(result) {
    rows = [];
    const children = [];

    const note = TIER_NOTE[result.tier];
    if (note) children.push(h('div', { class: 'suggest-note' }, t(note)));

    for (const group of result.groups) {
      const meta = GROUPS[group.kind];
      if (!meta) continue;
      children.push(h('div', { class: 'suggest-head' }, t(meta.label)));
      for (const row of group.rows) {
        const index = rows.length;
        rows.push({ kind: group.kind, row });
        children.push(h('div', {
          class: 'suggest-row',
          role: 'option',
          dataset: { index: String(index) },
          /*
           * `mousedown`, not `click`: the input loses focus first on a click,
           * the blur handler closes the menu, and the click then lands on
           * nothing. This is the bug every hand-written typeahead has once.
           */
          onmousedown: (event) => { event.preventDefault(); go({ kind: group.kind, row }); },
        }, rowBody(group.kind, row)));
      }
    }

    if (!children.length) {
      children.push(h('div', { class: 'suggest-empty' }, t('suggestNothing')));
    }
    mount(menu, ...children);
    menu.hidden = false;
    active = -1;
  }

  function rowBody(kind, row) {
    if (kind === 'sale' || kind === 'purchase') {
      return h('div', { class: 'suggest-line' },
        h('span', { class: 'mono' }, row.number),
        h('span', { class: 'suggest-side' }, money(row.total)));
    }
    const title = kind === 'customer' ? row.name_en : pick(row, 'name');
    const side = kind === 'product'
      ? row.code
      : (row.phone || '');
    return h('div', { class: 'suggest-line' },
      h('div', { class: 'suggest-main' },
        h('span', {}, title || '—'),
        kind === 'product' && !row.is_active
          ? h('span', { class: 'suggest-flag' }, t('inactive'))
          : null),
      side ? h('span', { class: 'suggest-side mono' }, side) : null);
  }

  const look = debounce(async (term) => {
    const mine = ++token;
    try {
      const result = await api.get('/api/search/suggest', { q: term, ...(scope ? { scope } : {}) });
      // A slower earlier request must never overwrite a newer answer — the
      // classic typeahead race, and the reason every result carries a token.
      if (mine !== token) return;
      if (document.activeElement !== input) return;
      /*
       * AND the box must still say what was asked about.
       *
       * This is the scanner. A scan types thirteen characters in fifty
       * milliseconds, presses Enter, and `triggerScan` empties the box — but
       * the debounced request for the half-typed code is already in flight, and
       * it came back and painted a menu over a screen the cashier had already
       * moved on from. The box was empty and a dropdown was hanging over the
       * till. Only the browser check caught it.
       */
      if (input.value.trim() !== term) return;
      paint(result);
    } catch {
      // A failed suggestion is not worth a toast. The box still works; the
      // person is mid-word and a red banner would be the only thing they see.
      close();
    }
  }, DEBOUNCE_MS);

  input.addEventListener('input', () => {
    const term = input.value.trim();
    if (term.length < MIN_CHARS) { close(); return; }
    look(term);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (menu.hidden || !rows.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active += event.key === 'ArrowDown' ? 1 : -1;
      if (active < 0) active = rows.length - 1;
      if (active >= rows.length) active = 0;
      for (const node of menu.querySelectorAll('.suggest-row')) {
        node.classList.toggle('is-active', Number(node.dataset.index) === active);
      }
      menu.querySelector('.suggest-row.is-active')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter') {
      /*
       * Enter is only taken when a row is actually highlighted. Otherwise it
       * belongs to whatever the box already did with it — submitting a filter,
       * or firing a scan — and stealing it would break every barcode in the
       * shop for the sake of a menu nobody was looking at.
       */
      if (active >= 0) {
        event.preventDefault();
        consumed = event;
        go(rows[active]);
      } else {
        close();
      }
    }
  });

  input.addEventListener('blur', () => {
    // After the mousedown above has had its turn.
    setTimeout(close, 120);
  });

  return {
    close,
    node: wrap,
    /** Did this list act on this exact key press? */
    tookEvent: (event) => event === consumed,
  };
}

export default { attachSuggest };
