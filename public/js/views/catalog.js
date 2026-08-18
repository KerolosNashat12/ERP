/** Product catalogue: list, and the create/edit screen with the variant matrix. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, confirmDialog, debounce,
  textInput, selectInput, numberInput, field, tag, modal, buildForm,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, fileSize } from '../core/format.js';
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
