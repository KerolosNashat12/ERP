/** Product catalogue: list, and the create/edit screen with the variant matrix. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, confirmDialog, debounce,
  textInput, selectInput, numberInput, field, tag, modal, buildForm,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number } from '../core/format.js';
import { can, lookup, invalidate } from '../core/store.js';
import { onScan } from '../core/scanner.js';
import { navigate } from '../core/router.js';
import { productDetailsView } from './productDetails.js';

// ---------------------------------------------------------------- list view

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
    isActive: '', page: 1, pageSize: 25,
  };

  const [brands, categories, suppliers] = await Promise.all([
    lookup('brands', '/api/brands/options'),
    lookup('categories', '/api/categories/options'),
    lookup('suppliers', '/api/suppliers/options'),
  ]);

  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/products', state);
    mount(listHost, dataTable({
      columns: [
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
          key: 'price',
          label: t('price'),
          type: 'money',
          render: (r) => (r.min_price === r.max_price
            ? money(r.min_price)
            : `${money(r.min_price)} – ${money(r.max_price)}`),
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
              onclick: async () => {
                if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
                try {
                  const result = await api.del(`/api/products/${r.id}`);
                  toast(result.deactivated ? `${t('saved')} (${t('inactive')})` : t('deleted'));
                  load();
                } catch (error) { toastError(error); }
              },
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

  const searchBox = textInput({
    placeholder: `${t('search')} — ${t('name')}, ${t('sku')}, ${t('barcode')}`,
    value: state.search,
    oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
  });

  const filterSelect = (key, placeholder, options) => selectInput({
    placeholder, options,
    onchange: (e) => { state[key] = e.target.value; state.page = 1; load(); },
  });

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('products')), h('p', {}, t('navCatalogue'))),
      h('span', { class: 'spacer' }),
      can('products.update') ? h('button', { class: 'btn', onclick: () => openBulkPrice(load) }, t('bulkPrice')) : null,
      can('products.create') ? h('button', { class: 'btn primary', onclick: () => navigate('products/new') }, '＋ ' + t('newProduct')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, searchBox),
        h('div', { class: 'field' }, filterSelect('brandId', t('brand'), brands.map((b) => ({ value: b.id, label: pick(b, 'name') })))),
        h('div', { class: 'field' }, filterSelect('categoryId', t('category'), categories.map((c) => ({ value: c.id, label: pick(c, 'name') })))),
        h('div', { class: 'field' }, filterSelect('supplierId', t('supplier'), suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })))),
        h('div', { class: 'field' }, filterSelect('isActive', t('status'), [{ value: '1', label: t('active') }, { value: '0', label: t('inactive') }]))),
      listHost, pagerHost));

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
    { name: 'tags', label: t('tags'), span: 2 },
    { name: 'description_en', label: t('description'), type: 'textarea', span: 2 },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    { name: 'track_inventory', label: t('trackInventory'), type: 'checkbox', value: 1 },
  ], existing || {
    is_active: 1, track_inventory: 1, unit: 'piece', tax_rate: 14, base_cost: 0, base_price: 0,
  }, { columns: 3 });

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
      h('div', { class: 'card-body' }, header.node)),

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('variantMatrix')),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, t('productAttributes'))),
      h('div', { class: 'card-body' },
        attributePicker,
        h('div', { class: 'muted small', style: { marginTop: '8px' } }, t('noAttributesNeeded'))),
      matrixHost));

  renderAttributePicker();
  renderMatrix();
  // A leaked subscription would swallow scans on every other screen.
  return () => unsubscribeScan();
}

// -------------------------------------------------------- bulk price update

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
