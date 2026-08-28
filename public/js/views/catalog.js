/** Product catalogue: list, and the create/edit screen with the variant matrix. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, confirmDialog, debounce,
  textInput, selectInput, numberInput, field, tag, modal, buildForm, summaryCards,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, fileSize } from '../core/format.js';
import { can, lookup, invalidate } from '../core/store.js';
import { onScan } from '../core/scanner.js';
import { navigate } from '../core/router.js';
import { productDetailsView } from './productDetails.js';
import { confirmDelete } from './trash.js';

// ---------------------------------------------------------------- list view

/** `women` → `Women`, so one `t()` key per value instead of a lookup table. */
const genderKey = (value) => {
  const text = String(value || 'unisex');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * The offer, as it reads on a list row: what it sells for now, and by how much.
 *
 * Drawn only when an offer is actually RUNNING today — a rate sitting in a
 * column with next month's start date is not a price and must not look like
 * one. The server sends `offer_price` and `on_offer` already resolved, so this
 * never does date arithmetic of its own.
 */
function offerBadge(row) {
  if (!row.on_offer) return null;
  return h('div', { class: 'row', style: { gap: '4px', alignItems: 'center' } },
    h('span', { class: 'strong ok' }, money(row.offer_price)),
    tag(`−${row.offer_percent}%`, 'gold'));
}

export async function productsView(root, route) {
  const [, second, third] = route.segments;
  // products            → list
  // products/new        → editor
  // products/:id        → details (read-only)
  // products/:id/edit   → editor
  if (second === 'new' || third === 'edit') return productFormView(root, route);
  if (second) return productDetailsView(root, Number(second));

  const state = {
    search: route.query.search || '', brandId: '', categoryId: '', supplierId: '',
    isActive: '', gender: '', onOffer: '', page: 1, pageSize: 25,
  };

  /*
   * What is ticked, as a Map of id → name.
   *
   * A Map and not a Set of ids, because the confirmation has to be able to SAY
   * what is about to change — "212 Sexy Men, Valentino Donna and 18 others" —
   * and a page that has been scrolled past no longer has those rows to look the
   * names up in. It survives paging and filtering on purpose: ticking twenty
   * products across three pages and then applying is the whole point, and a
   * selection that silently emptied itself when the page turned would be worse
   * than none.
   */
  const picked = new Map();
  const bulkBar = h('div');

  const [brands, categories, suppliers] = await Promise.all([
    lookup('brands', '/api/brands/options'),
    lookup('categories', '/api/categories/options'),
    lookup('suppliers', '/api/suppliers/options'),
  ]);

  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const cardsHost = h('div');

  /** The last page fetched, kept so a tick can redraw without a round trip. */
  let current = { rows: [], total: 0, page: 1, pages: 1 };

  async function load() {
    mount(listHost, spinner());
    /*
     * The counters are fetched alongside the page, from the same filters, so
     * they describe the list underneath rather than the whole shop. Both at
     * once: on the hosted database they are two round trips either way, and in
     * series the second one waits for the first for no reason.
     */
    const [page, counts] = await Promise.all([
      api.get('/api/products', state),
      api.get('/api/products/summary', state).catch(() => null),
    ]);
    current = page;
    renderCards(counts, page.total);
    renderTable(current);
    renderBulkBar();
  }

  /**
   * What is in the catalogue, and how much of it is ready to sell.
   *
   * Every card that names a subset is a way into it: tapping «حريمي» filters to
   * those products rather than merely counting them, and the card stays lit
   * while its filter is on, so a screen showing forty products can always
   * explain why.
   */
  function renderCards(counts, total) {
    if (!counts) { mount(cardsHost); return; }
    const toggle = (key, value) => () => {
      state[key] = state[key] === value ? '' : value;
      state.page = 1;
      syncFilterInputs();
      load();
    };
    const share = (n) => (total ? `${Math.round((n / total) * 100)}%` : '');
    mount(cardsHost, summaryCards([
      { label: t('products'), value: number(counts.products), sub: `${number(counts.variants)} ${t('variants')}`, accent: true },
      /*
       * PIECES. Three numbers on this screen answer three different questions -
       * how many products, how many variants of them, and how many things are
       * actually on the shelves - and the third was missing, which is why the
       * products page and the valuation report looked like they disagreed.
       * They never did; only one of them was answering.
       */
      {
        label: t('unitsInStock'),
        value: number(counts.units),
        sub: `${number(counts.stocked_lines)} ${t('stockedLines')}`,
      },
      {
        label: t('genderWomen'),
        value: number(counts.women),
        sub: share(counts.women),
        onClick: toggle('gender', 'women'),
        active: state.gender === 'women',
      },
      {
        label: t('genderMen'),
        value: number(counts.men),
        sub: share(counts.men),
        onClick: toggle('gender', 'men'),
        active: state.gender === 'men',
      },
      {
        label: t('genderUnisex'),
        value: number(counts.unisex),
        sub: share(counts.unisex),
        onClick: toggle('gender', 'unisex'),
        active: state.gender === 'unisex',
      },
      {
        label: t('offerRunning'),
        value: number(counts.on_offer),
        onClick: toggle('onOffer', '1'),
        active: state.onOffer === '1',
      },
      { label: t('publishedOnSite'), value: number(counts.published), sub: share(counts.published) },
      { label: t('outOfStockProducts'), value: number(counts.out_of_stock) },
      {
        label: t('inactive'),
        value: number(counts.stopped),
        onClick: toggle('isActive', '0'),
        active: state.isActive === '0',
      },
      { label: t('withoutPhoto'), value: number(counts.without_photo) },
    ]));
  }

  function renderTable(data) {
    const allOnPage = data.rows.length > 0 && data.rows.every((row) => picked.has(row.id));
    mount(listHost, dataTable({
      columns: [
        {
          key: '__pick',
          // The header box ticks or clears THIS PAGE — never the whole
          // catalogue silently. Selecting everything the filter matches is a
          // separate, explicit action on the bar below, which says the number
          // out loud first.
          label: h('input', {
            type: 'checkbox',
            checked: allOnPage,
            title: t('bulkSelectPage'),
            onchange: (event) => {
              for (const row of data.rows) {
                if (event.target.checked) picked.set(row.id, pick(row, 'name'));
                else picked.delete(row.id);
              }
              // Here the table IS redrawn: every row's box has to move, and
              // the browser has only moved this one.
              renderTable(data);
              renderBulkBar();
            },
          }),
          width: '1%',
          render: (r) => h('input', {
            type: 'checkbox',
            checked: picked.has(r.id),
            'aria-label': pick(r, 'name'),
            onclick: (event) => event.stopPropagation(),
            /*
             * Only the bar is redrawn, never the table.
             *
             * Re-rendering the whole table on every tick throws away the very
             * checkbox that was just clicked — the browser has already moved
             * the tick, and rebuilding the row underneath it costs the focus,
             * the scroll position and any chance of ticking twenty rows
             * quickly. The header box is nudged by hand for the same reason.
             */
            onchange: (event) => {
              if (event.target.checked) picked.set(r.id, pick(r, 'name'));
              else picked.delete(r.id);
              syncHeaderBox(data);
              renderBulkBar();
            },
          }),
        },
        { key: 'sku_prefix', label: t('sku'), class: 'mono small' },
        {
          key: 'name',
          label: t('product'),
          render: (r) => h('div', {},
            h('div', { class: 'strong' }, pick(r, 'name')),
            h('small', { class: 'muted' }, [pick(r, 'brand_name'), pick(r, 'category_name')].filter(Boolean).join(' · ') || '—')),
        },
        { key: 'variant_count', label: t('variants'), type: 'number', render: (r) => tag(`${r.variant_count}`, 'info') },
        {
          key: 'is_published',
          label: t('website'),
          render: (r) => (r.is_published ? tag(t('published'), 'ok') : tag(t('notPublished'))),
        },
        {
          key: 'gender',
          label: t('gender'),
          render: (r) => tag(t(`gender${genderKey(r.gender)}`, r.gender || 'unisex'),
            r.gender === 'unisex' ? '' : 'info'),
        },
        {
          key: 'price',
          label: t('price'),
          type: 'money',
          /*
           * The ticket price, with the offer under it when one is running —
           * `أوفر` is not a state anybody should have to open a product to
           * discover, least of all on the screen used to check what the shop
           * is charging.
           */
          render: (r) => h('div', {},
            h('div', {}, r.min_price === r.max_price
              ? money(r.min_price)
              : `${money(r.min_price)} – ${money(r.max_price)}`),
            offerBadge(r)),
        },
        { key: 'total_stock', label: t('totalStock'), type: 'number', render: (r) => h('span', { class: r.total_stock <= 0 ? 'muted' : '' }, number(r.total_stock)) },
        { key: 'supplier_name_en', label: t('supplier'), render: (r) => r.supplier_name_en || '—' },
        { key: 'is_active', label: t('status'), render: (r) => (r.is_active ? tag(t('active'), 'ok') : tag(t('inactive'))) },
        {
          key: '__a',
          label: '',
          width: '1%',
          render: (r) => h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
            h('button', { class: 'btn sm ghost', title: t('view'), onclick: () => navigate(`products/${r.id}`) }, '👁'),
            can('products.update') ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => navigate(`products/${r.id}/edit`) }, '✎') : null,
            can('products.delete') ? h('button', {
              class: 'btn sm ghost',
              title: t('delete'),
              onclick: () => confirmDelete({
                entityType: 'product', entityId: r.id, onDone: load,
              }),
            }, '🗑') : null),
        },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`products/${row.id}`),
    }));
    mount(pagerHost, pager({
      page: data.page, pages: data.pages, total: data.total,
      onPage: (p) => { state.page = p; load(); },
    }));
  }

  /** Keep the header box honest without rebuilding the rows under it. */
  function syncHeaderBox(data) {
    const box = listHost.querySelector('thead input[type="checkbox"]');
    if (box) box.checked = data.rows.length > 0 && data.rows.every((row) => picked.has(row.id));
  }

  /**
   * The bar that appears once something is ticked.
   *
   * Three things, in the order they are needed: how many are selected, a way to
   * widen that to everything the current filter matches, and the action. It is
   * absent entirely when nothing is ticked — a permanent empty toolbar is
   * furniture, and this screen is used all day by people who are not doing bulk
   * edits.
   */
  function renderBulkBar() {
    if (!picked.size || !can('products.update')) {
      mount(bulkBar);
      return;
    }
    const matching = current.total || 0;
    mount(bulkBar,
      h('div', { class: 'bulk-bar' },
        h('span', { class: 'strong' }, t('bulkSelected').replace('{n}', picked.size)),
        // Offered only when there is genuinely more to take: the whole filtered
        // set, said as a number so nobody applies a change to 300 products
        // thinking they are applying it to 25.
        picked.size < matching
          ? h('button', {
            class: 'btn sm ghost',
            onclick: () => selectAllMatching(),
          }, t('bulkSelectAll').replace('{n}', matching))
          : null,
        h('button', { class: 'btn sm ghost', onclick: () => { picked.clear(); renderTable(current); renderBulkBar(); } },
          t('bulkClear')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm primary', onclick: () => openBulkEdit() }, t('bulkEdit'))));
  }

  /**
   * Tick everything the current filter matches, not merely what is on screen.
   *
   * Fetched as ids rather than assumed: the filter is a server-side query and
   * the only honest way to know what it matches is to ask. Capped at the same
   * 500 the server enforces, and said out loud when the cap bites, because a
   * silent truncation here is a bulk edit that missed half its rows.
   */
  async function selectAllMatching() {
    try {
      const all = await api.get('/api/products', { ...state, page: 1, pageSize: 500 });
      for (const row of all.rows) picked.set(row.id, pick(row, 'name'));
      if (all.total > all.rows.length) {
        toast(t('bulkCapped').replace('{n}', all.rows.length).replace('{total}', all.total), 'warn', 6000);
      }
      renderTable(current);
      renderBulkBar();
    } catch (error) { toastError(error); }
  }

  /**
   * The dialog: what to change, to what, and on how many.
   *
   * One field at a time by design. A dialog that could set four things at once
   * would need four "leave this alone" states, and the difference between "set
   * the brand to nothing" and "do not touch the brand" is exactly the mistake
   * that makes a bulk tool dangerous.
   */
  function openBulkEdit() {
    const FIELDS = [
      { value: 'gender', label: t('gender') },
      { value: 'brand_id', label: t('brand') },
      { value: 'category_id', label: t('category') },
      { value: 'supplier_id', label: t('supplier') },
    ];
    const valuesFor = (name) => {
      if (name === 'gender') {
        return [
          { value: 'women', label: t('genderWomen') },
          { value: 'men', label: t('genderMen') },
          { value: 'unisex', label: t('genderUnisex') },
        ];
      }
      const rows = name === 'brand_id' ? brands : name === 'category_id' ? categories : suppliers;
      // "None" is a real answer: clearing a supplier off a batch is a change
      // somebody genuinely wants, and it has to be distinguishable from
      // "leave it alone", which is what closing this dialog does.
      return [{ value: '', label: `— ${t('none')} —` },
        ...rows.map((row) => ({ value: String(row.id), label: pick(row, 'name') }))];
    };

    const valueHost = h('div');
    let chosenField = 'gender';
    let value = 'women';

    const drawValue = () => {
      const options = valuesFor(chosenField);
      value = options[0].value;
      mount(valueHost, field({ label: t('bulkNewValue'), input: selectInput({
        value,
        options,
        onchange: (event) => { value = event.target.value; },
      }) }));
    };

    const dialog = modal({
      title: t('bulkEdit'),
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, t('bulkOn').replace('{n}', picked.size)),
        // Named, not merely counted. Three names and a number is the difference
        // between "I know what I ticked" and "I hope I ticked the right rows".
        h('p', { class: 'small muted' },
          [...picked.values()].slice(0, 3).join('، ')
          + (picked.size > 3 ? ` ${t('andNMore').replace('{n}', picked.size - 3)}` : '')),
        field({
          label: t('bulkField'),
          input: selectInput({
            value: chosenField,
            options: FIELDS,
            onchange: (event) => { chosenField = event.target.value; drawValue(); },
          }),
        }),
        valueHost),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const label = FIELDS.find((entry) => entry.value === chosenField)?.label || chosenField;
            const chosen = valuesFor(chosenField).find((entry) => String(entry.value) === String(value));
            const ok = await confirmDialog({
              title: t('bulkEdit'),
              message: t('bulkConfirm')
                .replace('{n}', picked.size)
                .replace('{field}', label)
                .replace('{value}', chosen?.label || String(value)),
              confirmLabel: t('bulkApply'),
              danger: true,
            });
            if (!ok) return;
            try {
              const result = await api.post('/api/products/bulk', {
                ids: [...picked.keys()],
                changes: {
                  [chosenField]: chosenField === 'gender'
                    ? value
                    : (value === '' ? null : Number(value)),
                },
              });
              toast(t('bulkApplied')
                .replace('{changed}', result.changed)
                .replace('{same}', result.unchanged));
              dialog.close();
              picked.clear();
              invalidate();
              await load();
            } catch (error) { toastError(error); }
          },
        }, t('bulkApply'))),
    });
    drawValue();
  }

  const searchBox = textInput({
    placeholder: t('searchNameOrCode'),
    value: state.search,
    oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
  });

  /*
   * The dropdowns, kept by key so a card can move one. A card that changes the
   * filter without moving the select leaves the screen contradicting itself -
   * the list narrowed, the dropdown still says «الكل», and there is no way to
   * put it back.
   */
  const filterInputs = new Map();
  const filterSelect = (key, placeholder, options) => {
    const input = selectInput({
      placeholder, options, value: state[key] || '',
      onchange: (e) => { state[key] = e.target.value; state.page = 1; load(); },
    });
    filterInputs.set(key, input);
    return input;
  };
  const syncFilterInputs = () => {
    for (const [key, input] of filterInputs) input.value = state[key] || '';
  };

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('products')), h('p', {}, t('navCatalogue'))),
      h('span', { class: 'spacer' }),
      can('products.update') ? h('button', { class: 'btn', onclick: () => openGenderReview(load) }, t('genderReview')) : null,
      can('products.update') ? h('button', { class: 'btn', onclick: () => openBulkPrice(load) }, t('bulkPrice')) : null,
      can('products.create') ? h('button', { class: 'btn primary', onclick: () => navigate('products/new') }, '＋ ' + t('newProduct')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, searchBox),
        h('div', { class: 'field' }, filterSelect('brandId', t('brand'), brands.map((b) => ({ value: b.id, label: pick(b, 'name') })))),
        h('div', { class: 'field' }, filterSelect('categoryId', t('category'), categories.map((c) => ({ value: c.id, label: pick(c, 'name') })))),
        h('div', { class: 'field' }, filterSelect('supplierId', t('supplier'), suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })))),
        h('div', { class: 'field' }, filterSelect('gender', t('gender'), [
          { value: 'women', label: t('genderWomen') },
          { value: 'men', label: t('genderMen') },
          { value: 'unisex', label: t('genderUnisex') },
        ])),
        h('div', { class: 'field' }, filterSelect('onOffer', t('offer'), [
          { value: '1', label: t('offerRunning') },
        ])),
        h('div', { class: 'field' }, filterSelect('isActive', t('status'), [{ value: '1', label: t('active') }, { value: '0', label: t('inactive') }]))),
      bulkBar, cardsHost, listHost, pagerHost));

  await load();
  return undefined;
}

// ---------------------------------------------------------------- form view

async function productFormView(root, route) {
  const id = route.segments[1] === 'new' ? null : Number(route.segments[1]);
  mount(root, spinner());

  const [brands, categories, suppliers, attributeData, existing] = await Promise.all([
    lookup('brands', '/api/brands/options'),
    lookup('categories', '/api/categories/options'),
    lookup('suppliers', '/api/suppliers/options'),
    api.get('/api/attributes/with-values'),
    id ? api.get(`/api/products/${id}`) : Promise.resolve(null),
  ]);

  const attributes = attributeData.rows.filter((a) => a.is_active);
  const selectedAttributeIds = new Set(existing?.attributes?.map((a) => a.id) || []);
  /** Working variant list — rebuilt when the matrix is regenerated. */
  let variants = (existing?.variants || []).map((v) => ({
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    variant_label: v.variant_label,
    cost_price: v.cost_price,
    selling_price: v.selling_price,
    wholesale_price: v.wholesale_price,
    reorder_level: v.reorder_level,
    reorder_quantity: v.reorder_quantity,
    is_active: v.is_active,
    options: v.options.map((o) => ({ attribute_id: o.attribute_id, attribute_value_id: o.attribute_value_id })),
    label: v.variant_label,
    stock: v.total_stock,
  }));

  const header = buildForm([
    { name: 'sku_prefix', label: t('skuPrefix'), required: true, hint: t('skuPrefixHint'), placeholder: t('scanOrType') },
    { name: 'name_en', label: t('nameEn'), required: true },
    { name: 'name_ar', label: t('nameAr') },
    { name: 'brand_id', label: t('brand'), type: 'select', options: brands.map((b) => ({ value: b.id, label: pick(b, 'name') })) },
    { name: 'category_id', label: t('category'), type: 'select', options: categories.map((c) => ({ value: c.id, label: pick(c, 'name') })) },
    { name: 'supplier_id', label: t('supplier'), type: 'select', options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })) },
    { name: 'unit', label: t('unit') },
    { name: 'tax_rate', label: t('taxRate'), type: 'number' },
    { name: 'base_cost', label: t('costPrice'), type: 'number', hint: t('defaultForNewVariants') },
    { name: 'base_price', label: t('sellingPrice'), type: 'number', hint: t('defaultForNewVariants') },
    /*
     * Who the piece is for. A real column and a real filter on the website, so
     * it sits with the product's identity — beside its brand and its category —
     * rather than down with the web copy. Every product has a value, so the
     * field is never blank: a product nobody has classified reads «للجنسين»,
     * which shows it to everybody instead of hiding it from half the shop.
     */
    {
      name: 'gender',
      label: t('gender'),
      type: 'select',
      hint: t('genderHint'),
      options: [
        { value: 'women', label: t('genderWomen') },
        { value: 'men', label: t('genderMen') },
        { value: 'unisex', label: t('genderUnisex') },
      ],
    },
    { name: 'tags', label: t('tags'), span: 2 },
    { name: 'description_en', label: t('description'), type: 'textarea', span: 2 },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    { name: 'track_inventory', label: t('trackInventory'), type: 'checkbox', value: 1 },
    // Hidden until somebody deliberately publishes. Placed with the web copy so
    // it reads as one decision: "this is what the shop shows, and here is what
    // it says".
    { name: 'is_published', label: t('showOnWebsite'), type: 'checkbox', hint: t('showOnWebsiteHint') },
    { name: 'web_description_en', label: t('webDescriptionEn'), type: 'textarea', span: 2, hint: t('webDescriptionHint') },
    { name: 'web_description_ar', label: t('webDescriptionAr'), type: 'textarea', span: 3 },

    /*
     * The offer.
     *
     * Four fields, and a live preview under them that spells out the result in
     * money — because "20" in a box beside a word is not a price, and the
     * question anybody actually has is "so what does it sell for". The preview
     * is built below, right after this form, and reads these four inputs.
     *
     * While an offer runs it is the price EVERYWHERE: the website, an online
     * order, and this shop's own till. That sentence is in the hint, in both
     * languages, because it is the one thing about this feature that can
     * surprise somebody.
     */
    {
      name: 'discount_type',
      label: t('offer'),
      type: 'select',
      // Full width, so the three fields that qualify it — how much, from when,
      // until when — land together on the row beneath instead of being split
      // across a row boundary by whatever came before them.
      span: 3,
      hint: t('offerHint'),
      options: [
        { value: 'none', label: t('offerNone') },
        { value: 'percent', label: t('offerPercent') },
        { value: 'amount', label: t('offerAmount') },
      ],
    },
    { name: 'discount_value', label: t('offerValue'), type: 'number' },
    { name: 'discount_starts_on', label: t('offerStarts'), type: 'date', hint: t('offerStartsHint') },
    { name: 'discount_ends_on', label: t('offerEnds'), type: 'date', hint: t('offerEndsHint') },
  ], existing || {
    is_active: 1, track_inventory: 1, unit: 'piece', tax_rate: 14, base_cost: 0, base_price: 0,
    gender: 'unisex', discount_type: 'none', discount_value: 0,
  }, { columns: 3 });

  /*
   * What the offer actually does, in money, as it is typed.
   *
   * Reads the same four inputs the server will read and applies the same rule —
   * a percent of the price, or an amount off it, floored at zero — to the
   * product's own selling price. It is a preview and nothing more: the price
   * that is charged is always computed on the server, because a browser can be
   * a day out of date about what today is.
   */
  const offerPreview = h('div', { class: 'offer-preview' });
  function refreshOfferPreview() {
    const values = header.values();
    const type = values.discount_type || 'none';
    const rate = Number(values.discount_value || 0);
    const list = Number(variants[0]?.selling_price || values.base_price || 0);
    if (type === 'none' || !(rate > 0) || !(list > 0)) {
      mount(offerPreview, h('span', { class: 'muted small' }, t('offerNoneNote')));
      return;
    }
    const off = type === 'percent'
      ? Math.round(list * (Math.min(Math.max(rate, 0), 100) / 100) * 100) / 100
      : Math.min(Math.max(rate, 0), list);
    const now = Math.round(Math.max(list - off, 0) * 100) / 100;
    const percent = list > 0 ? Math.round(((list - now) / list) * 100) : 0;
    mount(offerPreview,
      h('span', { class: 'offer-was' }, money(list)),
      h('span', { class: 'offer-now' }, money(now)),
      h('span', { class: 'offer-off' }, `−${percent}%`),
      h('span', { class: 'muted small' }, t('offerPreviewNote')));
  }
  for (const name of ['discount_type', 'discount_value', 'base_price']) {
    const entry = header.inputs.get(name);
    if (!entry) continue;
    entry.input.addEventListener('input', refreshOfferPreview);
    entry.input.addEventListener('change', refreshOfferPreview);
  }
  refreshOfferPreview();

  // ------------------------------------------------------------- scanning
  // On this screen a scan is not a lookup: it fills whichever code box the
  // user is working in, so a new product can be created by scanning its tag.
  let scanTarget = null;

  /** Marks an input as a scan box and remembers it while it has the focus. */
  const scannable = (input) => {
    input.dataset.scanTarget = 'true';
    input.addEventListener('focus', () => { scanTarget = input; });
    return input;
  };

  const skuPrefixInput = scannable(header.inputs.get('sku_prefix').input);

  const unsubscribeScan = onScan((code) => {
    // Rows come and go as the matrix is regenerated, so a remembered input is
    // only usable while it is still on screen. With nothing focused the prefix
    // box is the obvious target — but only while it is empty, since silently
    // overwriting a code the user typed would be worse than doing nothing.
    const target = scanTarget?.isConnected
      ? scanTarget
      : (skuPrefixInput.value ? null : skuPrefixInput);
    if (!target) return;
    target.value = code;
    // Matrix rows keep their model in sync through 'input', not assignment.
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    scanTarget = target;
    toast(t('scannedIntoField'));
  });

  const attributePicker = h('div', { class: 'attr-picker' });
  const matrixHost = h('div');

  function renderAttributePicker() {
    mount(attributePicker, ...attributes.map((attribute) => h('button', {
      type: 'button',
      class: `attr-chip${selectedAttributeIds.has(attribute.id) ? ' on' : ''}`,
      onclick: () => {
        if (selectedAttributeIds.has(attribute.id)) selectedAttributeIds.delete(attribute.id);
        else selectedAttributeIds.add(attribute.id);
        renderAttributePicker();
        renderMatrix();
      },
    }, `${pick(attribute, 'name')} (${attribute.values.length})`)),
    h('span', { class: 'spacer' }),
    h('button', {
      type: 'button', class: 'btn sm primary', onclick: generateMatrix,
    }, t('generateVariants')),
    h('button', {
      type: 'button', class: 'btn sm', onclick: addSingleVariant,
    }, '＋ ' + t('addVariant')));
  }

  const valueLabel = (attributeId, valueId) => {
    const attribute = attributes.find((a) => a.id === attributeId);
    const value = attribute?.values.find((v) => v.id === valueId);
    return value ? pick(value, 'value') : '';
  };

  async function generateMatrix() {
    const ids = [...selectedAttributeIds];
    if (!ids.length) { toast(t('noVariantsYet'), 'warn'); return; }
    try {
      const { rows: combos } = await api.post('/api/products/combinations', { attribute_ids: ids });
      const base = header.values();
      const previous = new Map(variants.map((v) => [signature(v.options), v]));
      variants = combos.map((options) => {
        const key = signature(options);
        const existingVariant = previous.get(key);
        return existingVariant || {
          id: null,
          sku: '',
          barcode: '',
          cost_price: Number(base.base_cost || 0),
          selling_price: Number(base.base_price || 0),
          wholesale_price: Number(base.base_price || 0),
          reorder_level: 5,
          reorder_quantity: 20,
          is_active: 1,
          options: options.map((o) => ({ attribute_id: o.attribute_id, attribute_value_id: o.attribute_value_id })),
          label: options.map((o) => pick(o, 'value')).join(' / '),
        };
      });
      renderMatrix();
    } catch (error) { toastError(error); }
  }

  function addSingleVariant() {
    const base = header.values();
    variants.push({
      id: null, sku: '', barcode: '', label: t('defaultVariant'),
      cost_price: Number(base.base_cost || 0),
      selling_price: Number(base.base_price || 0),
      wholesale_price: Number(base.base_price || 0),
      reorder_level: 5, reorder_quantity: 20, is_active: 1, options: [],
    });
    renderMatrix();
  }

  const signature = (options) => (options || [])
    .map((o) => `${o.attribute_id}:${o.attribute_value_id}`).sort().join('|');

  function renderMatrix() {
    if (!variants.length) {
      // Without attributes there is nothing to generate: the product is saved
      // with its single code, and the server gives it its one variant.
      mount(matrixHost, h('div', { class: 'empty' },
        selectedAttributeIds.size ? t('noVariantsYet') : t('singleVariantNote')));
      return;
    }
    const numeric = (variant, key, step = '0.01') => numberInput({
      value: variant[key], step,
      style: { width: '95px' },
      oninput: (e) => { variant[key] = e.target.value === '' ? 0 : Number(e.target.value); },
    });

    mount(matrixHost, dataTable({
      columns: [
        {
          key: 'label',
          label: t('variant'),
          render: (v) => h('div', {},
            h('div', { class: 'strong small' },
              v.options?.length
                ? v.options.map((o) => valueLabel(o.attribute_id, o.attribute_value_id)).join(' / ')
                : (v.label || t('defaultVariant'))),
            v.id ? h('small', { class: 'muted mono' }, v.sku) : null),
        },
        {
          key: 'sku',
          label: t('sku'),
          render: (v) => scannable(textInput({
            value: v.sku, placeholder: t('scanOrType'), style: { width: '150px' },
            oninput: (e) => { v.sku = e.target.value; },
          })),
        },
        { key: 'cost_price', label: t('costPrice'), align: 'end', render: (v) => numeric(v, 'cost_price') },
        { key: 'selling_price', label: t('sellingPrice'), align: 'end', render: (v) => numeric(v, 'selling_price') },
        { key: 'wholesale_price', label: t('wholesalePrice'), align: 'end', render: (v) => numeric(v, 'wholesale_price') },
        { key: 'reorder_level', label: t('reorderLevel'), align: 'end', render: (v) => numeric(v, 'reorder_level', '1') },
        { key: 'stock', label: t('onHand'), align: 'end', render: (v) => (v.id ? number(v.stock || 0) : '—') },
        {
          key: '__a',
          label: '',
          render: (v, index) => h('button', {
            class: 'btn sm ghost', type: 'button', title: t('removeVariant'),
            onclick: () => { variants.splice(index, 1); renderMatrix(); },
          }, '✕'),
        },
      ],
      rows: variants,
    }));
  }

  async function save() {
    if (!header.validate()) return;
    const values = header.values();
    const payload = {
      ...values,
      is_active: Boolean(values.is_active),
      track_inventory: Boolean(values.track_inventory),
      attribute_ids: [...selectedAttributeIds],
      variants: variants.map((v) => ({
        id: v.id || undefined,
        sku: v.sku || undefined,
        barcode: v.barcode || undefined,
        cost_price: Number(v.cost_price || 0),
        selling_price: Number(v.selling_price || 0),
        wholesale_price: Number(v.wholesale_price || 0),
        reorder_level: Number(v.reorder_level || 0),
        reorder_quantity: Number(v.reorder_quantity || 0),
        is_active: Boolean(v.is_active),
        options: v.options || [],
      })),
    };
    try {
      const saved = id
        ? await api.put(`/api/products/${id}`, payload)
        : await api.post('/api/products', payload);
      toast(t('productSaved'));
      invalidate();
      // Land on the details page so the result of the save is visible.
      navigate(`products/${saved.id}`);
    } catch (error) {
      if (error.details?.length) header.setErrors(error.details);
      toastError(error);
    }
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, id ? t('editProduct') : t('newProduct')),
        h('p', {}, existing ? `${existing.sku_prefix} · ${existing.variants.length} ${t('variantCount')}` : t('navCatalogue'))),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn',
        onclick: () => navigate(id ? `products/${id}` : 'products'),
      }, '‹ ' + t('back')),
      can('products.create', 'products.update')
        ? h('button', { class: 'btn primary', onclick: save }, t('save'))
        : null),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, t('details'))),
      h('div', { class: 'card-body' }, header.node, offerPreview)),

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('variantMatrix')),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, t('productAttributes'))),
      h('div', { class: 'card-body' },
        attributePicker,
        h('div', { class: 'muted small', style: { marginTop: '8px' } }, t('noAttributesNeeded'))),
      matrixHost),

    // Below the matrix, because a photo can be pinned to one of its variants.
    // Saved variants only: an unsaved row has no id to attach anything to.
    photosCard(id, existing?.variants || []));

  renderAttributePicker();
  renderMatrix();
  // A leaked subscription would swallow scans on every other screen.
  return () => unsubscribeScan();
}

// ---------------------------------------------------------- photo gallery

/**
 * A phone photo is four or five megabytes and 4000 px wide. Nothing in a shop
 * needs that: it is shown as a thumbnail on the till and at a few hundred
 * pixels on the website, and the bytes live in the database, which is also the
 * backup. So the browser does the work before the upload — draw into a canvas
 * at a sane size, re-encode as JPEG, and send the result as a data URL.
 *
 * 1400 px on the longest edge at quality 0.82 puts a 5 MB photo at roughly
 * 120 KB, which the staff can see for themselves under every thumbnail. The
 * server enforces its own ceiling; this is what keeps uploads under it.
 */
const PHOTO_MAX_EDGE = 1400;
const PHOTO_QUALITY = 0.82;

function compressToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const longest = Math.max(image.naturalWidth, image.naturalHeight) || 1;
      const scale = Math.min(1, PHOTO_MAX_EDGE / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      // JPEG has no transparency: without this, a PNG cut-out is re-encoded
      // onto black, and a product photographed on white comes out on black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(t('photoUnreadable')));
    };
    image.src = objectUrl;
  });
}

/**
 * The Photos card on the product editor.
 *
 * Photos hang off a product row, so on a product that has not been saved yet
 * the card is present but inert, with a line saying why — better than hiding
 * it, which would leave staff wondering where photos are set at all.
 *
 * Unlike the rest of this screen, it saves as it goes: an upload, a reorder or
 * a change of main photo is written immediately rather than waiting for Save.
 * There is nothing to reconcile — the product already exists — and a photo that
 * vanished because somebody navigated away would be a nasty surprise.
 */
function photosCard(productId, productVariants = []) {
  const body = h('div', { class: 'card-body' });
  const card = h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-head' },
      h('h3', {}, t('photos')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, t('photosSubtitle'))),
    body);

  if (!productId) {
    mount(body, h('div', { class: 'photo-drop disabled' },
      h('span', { class: 'ico' }, '🖼'),
      h('div', {}, t('savePhotosFirst'))));
    return card;
  }

  const variantOptions = productVariants
    .filter((variant) => variant.id)
    .map((variant) => ({ value: variant.id, label: variant.variant_label || variant.sku }));

  let images = [];
  let dragId = null;
  let working = false;

  const fileInput = h('input', {
    type: 'file',
    // Anything the browser can decode: it is re-encoded as JPEG on the way out,
    // so what the phone happens to have saved does not matter.
    accept: 'image/*',
    multiple: true,
    style: { display: 'none' },
    onchange: (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      addFiles(files);
    },
  });

  const dropZone = h('div', {
    class: 'photo-drop',
    onclick: () => fileInput.click(),
    ondragover: (event) => {
      event.preventDefault();
      dropZone.classList.add('over');
    },
    ondragleave: () => dropZone.classList.remove('over'),
    ondrop: (event) => {
      event.preventDefault();
      dropZone.classList.remove('over');
      // A tile being dragged for reordering also lands here; it carries no
      // files, so this stays a no-op rather than an error.
      addFiles([...(event.dataTransfer?.files || [])]);
    },
  },
  h('span', { class: 'ico' }, '🖼'),
  h('div', {}, t('dropPhotoHere')),
  h('small', { class: 'muted' }, t('photoCompressHint')));

  const gallery = h('div', { class: 'photo-grid' });

  function tile(image, index) {
    return h('div', {
      class: `photo-tile${image.is_primary ? ' primary' : ''}`,
      draggable: 'true',
      ondragstart: (event) => {
        dragId = image.id;
        event.dataTransfer.effectAllowed = 'move';
        // Firefox only starts a drag once something has been written.
        event.dataTransfer.setData('text/plain', String(image.id));
      },
      ondragend: () => { dragId = null; },
      // Always accepted, whether it is another tile being reordered or a file
      // from the desktop: a drop the page does not handle makes the browser
      // navigate away to the dropped image, losing whatever was being edited.
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const files = [...(event.dataTransfer?.files || [])];
        if (files.length) addFiles(files);
        else if (dragId) moveTo(dragId, index);
      },
    },
    h('img', {
      src: `/api/products/${productId}/images/${image.id}/raw`,
      alt: pick(image, 'alt') || '',
      loading: 'lazy',
    }),
    image.is_primary ? h('span', { class: 'photo-badge' }, `★ ${t('mainPhoto')}`) : null,
    h('div', { class: 'photo-info' },
      h('span', {}, fileSize(image.byte_size)),
      image.width ? h('span', {}, `${image.width}×${image.height}`) : null),
    selectInput({
      options: variantOptions,
      value: image.variant_id ?? '',
      placeholder: t('allVariants'),
      onchange: (event) => setVariant(image, event.target.value),
    }),
    h('div', { class: 'photo-actions' },
      // Arrows as well as drag: the till is a touchscreen, where dragging a
      // small tile accurately is a fiddle and a mis-drop is invisible.
      h('button', {
        class: 'btn sm ghost', type: 'button', title: t('movePhotoEarlier'),
        disabled: index === 0, onclick: () => moveTo(image.id, index - 1),
      }, '↑'),
      h('button', {
        class: 'btn sm ghost', type: 'button', title: t('movePhotoLater'),
        disabled: index === images.length - 1, onclick: () => moveTo(image.id, index + 1),
      }, '↓'),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn sm ghost', type: 'button', title: t('makeMainPhoto'),
        disabled: Boolean(image.is_primary), onclick: () => makePrimary(image),
      }, '★'),
      h('button', {
        class: 'btn sm ghost', type: 'button', title: t('removePhoto'),
        onclick: () => removeImage(image),
      }, '🗑')));
  }

  function render() {
    mount(gallery, ...images.map(tile));
    mount(body,
      fileInput,
      dropZone,
      working ? h('div', { class: 'muted small', style: { marginTop: '8px' } }, t('preparingPhoto')) : null,
      images.length
        ? gallery
        : h('div', { class: 'empty' }, h('span', { class: 'ico' }, '◍'), h('div', {}, t('noPhotosYet'))));
  }

  async function load() {
    try {
      const data = await api.get(`/api/products/${productId}/images`);
      images = data.rows;
    } catch (error) {
      toastError(error);
    }
    render();
  }

  async function addFiles(files) {
    const pictures = files.filter((file) => file.type.startsWith('image/'));
    if (!pictures.length) {
      if (files.length) toast(t('photoNotAnImage'), 'warn');
      return;
    }
    working = true;
    render();
    try {
      // One at a time: compression is the expensive part, and uploading four
      // photos at once on a shop's connection is how a request times out.
      for (const file of pictures) {
        const dataUrl = await compressToDataUrl(file);
        await api.post(`/api/products/${productId}/images`, { dataUrl });
      }
      toast(t('photoAdded'));
    } catch (error) {
      toastError(error);
    } finally {
      working = false;
      await load();
    }
  }

  /** Optimistic: the tiles move at once, then the new order is persisted. */
  async function moveTo(imageId, index) {
    const from = images.findIndex((image) => image.id === imageId);
    const to = Math.max(0, Math.min(images.length - 1, index));
    if (from < 0 || from === to) return;
    const next = [...images];
    next.splice(to, 0, ...next.splice(from, 1));
    images = next;
    render();
    try {
      const result = await api.put(`/api/products/${productId}/images/order`, {
        ids: images.map((image) => image.id),
      });
      images = result.rows;
      render();
      toast(t('photoOrderSaved'));
    } catch (error) {
      toastError(error);
      await load();
    }
  }

  async function makePrimary(image) {
    try {
      await api.put(`/api/products/${productId}/images/${image.id}/primary`);
      toast(t('mainPhotoSet'));
    } catch (error) {
      toastError(error);
    }
    await load();
  }

  async function setVariant(image, value) {
    try {
      await api.put(`/api/products/${productId}/images/${image.id}`, {
        variantId: value === '' ? null : Number(value),
      });
      toast(t('saved'));
    } catch (error) {
      toastError(error);
    }
    await load();
  }

  async function removeImage(image) {
    if (!await confirmDialog({
      title: t('removePhoto'), message: t('removePhotoConfirm'), danger: true,
    })) return;
    try {
      await api.del(`/api/products/${productId}/images/${image.id}`);
      toast(t('photoRemoved'));
    } catch (error) {
      toastError(error);
    }
    await load();
  }

  render();
  load();
  return card;
}

// -------------------------------------------------------- bulk price update


/**
 * تصنيف النوع — every product, its suggested gender, and one button.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * The gender field arrived on a shop that already had hundreds of products, and
 * a field nobody fills in is worse than no field at all: the website's filter
 * would show every piece under «للجنسين» and a shopper looking for a men's
 * fragrance would be told the shop has none.
 *
 * Opening three hundred products one at a time is not a plan anybody carries
 * out. So the whole catalogue is on one screen with a suggestion already
 * chosen, read from each product's own name by the server — «212 سيكسي مان»
 * proposes رجالي, «فلانتينو ابيض» proposes nothing and keeps what it has. The
 * work becomes reading a column and correcting the few that are wrong.
 *
 * ── Why the suggestion is never applied on its own ──────────────────────────
 * Because it is a guess about words. A gift set with two bottles in it, a name
 * transliterated three ways, a brand whose name contains "HOMME" as part of the
 * house name rather than the fragrance — all of them fool it, and the cost of
 * being wrong lands on the live website where the owner cannot see it. So the
 * screen suggests, a person confirms, and the difference between those two
 * verbs is the whole design.
 */
async function openGenderReview(refresh) {
  const state = { rows: [], filter: 'suggested' };
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const summary = h('div', { class: 'muted small' });
  // What each row will be saved as. Seeded from the suggestion where there is
  // one, and from what the product already holds where there is not.
  const chosen = new Map();

  const dialog = modal({
    title: t('genderReview'),
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, t('genderReviewHint')),
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', onclick: () => setFilter('suggested') }, t('genderOnlySuggested')),
        h('button', { class: 'btn sm ghost', onclick: () => setFilter('all') }, t('genderShowAll')),
        h('span', { class: 'spacer' }),
        summary),
      h('div', { class: 'card' }, listHost)),
    footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn ghost', onclick: () => dialog.close() }, t('cancel')),
      h('button', { class: 'btn primary', onclick: () => apply() }, t('genderApply'))),
  });

  function setFilter(value) {
    state.filter = value;
    render();
  }

  async function load() {
    try {
      const data = await api.get('/api/products/gender-review');
      state.rows = data.rows;
      for (const row of data.rows) chosen.set(row.id, row.suggested || row.gender);
      /*
       * Open on the short list when there IS one, and on the whole catalogue
       * when there is not.
       *
       * The screen defaulted to "only what I suggest changing", which is right
       * on the day a shop first classifies three hundred products — and reads
       * as a broken screen for a shop whose names carry no signal at all, where
       * it opens empty. An empty first screen is not a filter working, it is a
       * person closing the dialog.
       */
      if (!data.suggestions) state.filter = 'all';
      mount(summary, h('span', {},
        t('genderReviewSummary')
          .replace('{total}', data.total)
          .replace('{suggested}', data.suggestions)));
      render();
    } catch (error) {
      toastError(error);
      mount(listHost, h('div', { class: 'empty' }, error.message));
    }
  }

  function render() {
    const rows = state.filter === 'suggested'
      ? state.rows.filter((row) => row.differs)
      : state.rows;
    mount(listHost, dataTable({
      columns: [
        {
          key: 'name',
          label: t('product'),
          render: (r) => h('div', {},
            h('div', { class: 'strong' }, pick(r, 'name')),
            h('small', { class: 'muted' },
              [r.sku_prefix, pick(r, 'brand_name')].filter(Boolean).join(' · '))),
        },
        {
          key: 'current',
          label: t('genderCurrent'),
          render: (r) => tag(t(`gender${genderKey(r.gender)}`), r.gender === 'unisex' ? '' : 'info'),
        },
        {
          key: 'suggested',
          label: t('genderSuggested'),
          // Said plainly when there is nothing to say. A dash is the honest
          // answer for a name that carries no signal, and for a gift set that
          // carries both.
          render: (r) => (r.suggested
            ? tag(t(`gender${genderKey(r.suggested)}`), 'gold')
            : h('span', { class: 'muted' }, '—')),
        },
        {
          key: 'choice',
          label: t('genderSetTo'),
          width: '1%',
          render: (r) => selectInput({
            value: chosen.get(r.id) || r.gender,
            options: [
              { value: 'women', label: t('genderWomen') },
              { value: 'men', label: t('genderMen') },
              { value: 'unisex', label: t('genderUnisex') },
            ],
            onchange: (event) => chosen.set(r.id, event.target.value),
          }),
        },
      ],
      rows,
      empty: t('genderNothingToReview'),
    }));
  }

  async function apply() {
    /*
     * Only what actually MOVES is sent. A catalogue of three hundred where
     * eleven need changing is eleven assignments, eleven audit rows and one
     * short transaction — not three hundred writes that mostly say nothing.
     */
    const assignments = state.rows
      .filter((row) => chosen.get(row.id) && chosen.get(row.id) !== row.gender)
      .map((row) => ({ id: row.id, gender: chosen.get(row.id) }));

    if (!assignments.length) {
      toast(t('genderNothingChanged'), 'warn');
      return;
    }
    try {
      const result = await api.post('/api/products/gender', { assignments });
      toast(t('genderApplied').replace('{n}', result.changed));
      dialog.close();
      invalidate();
      if (refresh) await refresh();
    } catch (error) { toastError(error); }
  }

  await load();
}

async function openBulkPrice(refresh) {
  const results = h('div');
  const chosen = new Set();
  const searchBox = textInput({
    placeholder: t('search'),
    oninput: debounce(async (e) => {
      const rows = e.target.value.length > 1
        ? (await api.get('/api/products/lookup', { q: e.target.value })).rows
        : [];
      mount(results, dataTable({
        columns: [
          {
            key: 'pick',
            label: '',
            width: '1%',
            render: (r) => h('input', {
              type: 'checkbox',
              checked: chosen.has(r.variant_id),
              onchange: (ev) => (ev.target.checked ? chosen.add(r.variant_id) : chosen.delete(r.variant_id)),
            }),
          },
          { key: 'sku', label: t('sku'), class: 'mono small' },
          { key: 'name', label: t('product'), render: (r) => `${pick(r, 'product_name')} — ${r.variant_label || ''}` },
          { key: 'selling_price', label: t('price'), type: 'money', render: (r) => money(r.selling_price) },
        ],
        rows,
      }));
    }, 300),
  });

  const form = buildForm([
    {
      name: 'field',
      label: t('price'),
      type: 'select',
      required: true,
      options: [
        { value: 'selling_price', label: t('sellingPrice') },
        { value: 'cost_price', label: t('costPrice') },
        { value: 'wholesale_price', label: t('wholesalePrice') },
      ],
    },
    {
      name: 'mode',
      label: t('type'),
      type: 'select',
      required: true,
      options: [
        { value: 'percent', label: t('percentChange') },
        { value: 'amount', label: t('addSubtractAmount') },
        { value: 'set', label: t('setToValue') },
      ],
    },
    { name: 'value', label: t('value'), type: 'number', required: true },
  ], { field: 'selling_price', mode: 'percent', value: 0 }, { columns: 3 });

  const dialog = modal({
    title: t('bulkPrice'),
    size: 'wide',
    body: h('div', { class: 'stack' },
      form.node,
      field({ label: t('search'), input: searchBox }),
      results),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!chosen.size) { toast(t('selectAll'), 'warn'); return; }
          try {
            const result = await api.post('/api/products/bulk-price', {
              ...form.values(), variantIds: [...chosen],
            });
            toast(`${result.updated} ${t('variantCount')} ${t('saved')}`);
            dialog.close();
            refresh();
          } catch (error) { toastError(error); }
        },
      }, t('apply')),
    ],
  });
}
