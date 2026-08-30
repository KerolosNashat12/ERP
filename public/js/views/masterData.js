/** Suppliers, brands, categories, clients and attributes screens. */
import api, { brandLogoUrl } from '../core/api.js';
import { resourceView, toOptions } from './resource.js';
import {
  h, mount, tag, dataTable, modal, toast, toastError, buildForm, confirmDialog, spinner,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, date } from '../core/format.js';
import { lookup, can, invalidate } from '../core/store.js';

const activeTag = (row) => (row.is_active ? tag(t('active'), 'ok') : tag(t('inactive')));

// ------------------------------------------------------------------ suppliers

export const suppliersView = resourceView({
  title: t('suppliers'),
  subtitle: t('navPurchasing'),
  endpoint: '/api/suppliers',
  module: 'suppliers',
  trashType: 'supplier',
  createLabel: t('suppliers'),
  formSize: 'wide',
  /*
   * The question a shop owner has about this screen is not "how many suppliers
   * do I have" - it is "how much do I owe, and to whom". So the money is the
   * first card and the head count is its small print.
   */
  summaryEndpoint: '/api/suppliers/summary',
  summary: (counts) => [
    { label: t('outstanding'), value: money(counts.outstanding), accent: true,
      sub: `${number(counts.suppliers_owed)} ${t('suppliersOwed')}` },
    { label: t('openOrdersValue'), value: number(counts.open_orders), sub: money(counts.open_value) },
    { label: t('purchasedTotal'), value: money(counts.purchased), sub: `${number(counts.orders)} ${t('purchases')}` },
    { label: t('suppliers'), value: number(counts.suppliers),
      sub: `${number(counts.suppliers_used)} ${t('suppliersUsed')}` },
  ],
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('div', {}, h('div', { class: 'strong' }, pick(r, 'name')), r.contact_person ? h('small', { class: 'muted' }, r.contact_person) : null) },
    { key: 'phone', label: t('phone'), class: 'mono small' },
    { key: 'city', label: t('city') },
    { key: 'payment_terms_days', label: t('paymentTerms'), type: 'number', render: (r) => `${r.payment_terms_days} ${t('dayShort')}` },
    { key: 'lead_time_days', label: t('leadTime'), type: 'number', render: (r) => `${r.lead_time_days} ${t('dayShort')}` },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => [
    { name: 'name_en', label: t('nameEn'), required: true },
    { name: 'name_ar', label: t('nameAr') },
    { name: 'code', label: t('code'), hint: t('autoIfBlank') },
    { name: 'contact_person', label: t('contactPerson') },
    { name: 'phone', label: t('phone') },
    { name: 'email', label: t('email') },
    { name: 'city', label: t('city') },
    { name: 'country', label: t('country') },
    { name: 'tax_number', label: t('taxNumber') },
    { name: 'payment_terms_days', label: t('paymentTermsDays'), type: 'number' },
    { name: 'lead_time_days', label: t('leadTimeDays'), type: 'number' },
    { name: 'credit_limit', label: t('creditLimit'), type: 'number' },
    { name: 'address', label: t('address'), type: 'textarea', span: 2 },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 2 },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
  ],
  defaults: { is_active: 1, payment_terms_days: 30, lead_time_days: 7 },
  onRowClick: async (row) => {
    try {
      const supplier = await api.get(`/api/suppliers/${row.id}`);
      modal({
        title: `${supplier.code} — ${pick(supplier, 'name')}`,
        size: 'wide',
        body: h('div', { class: 'stack' },
          h('div', { class: 'kpis' },
            statCard(t('purchases'), number(supplier.statistics.order_count)),
            statCard(t('total'), money(supplier.statistics.total_purchased)),
            statCard(t('outstanding'), money(supplier.statistics.outstanding)),
            statCard(t('products'), number(supplier.productCount))),
          h('h4', {}, t('purchases')),
          dataTable({
            columns: [
              { key: 'po_number', label: t('poNumber'), class: 'mono small' },
              { key: 'order_date', label: t('date'), render: (r) => date(r.order_date) },
              { key: 'status', label: t('status') },
              { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
            ],
            rows: supplier.recentOrders,
          })),
      });
    } catch (error) { toastError(error); }
  },
});


/**
 * A brand's logo, uploaded from the brands screen.
 *
 * The storefront's brands rail shows a picture where the shop has one and the
 * brand's first letter where it does not — and until this dialog existed, no
 * shop had one, because the only way to fill `logo_url` was to type a link to
 * somebody else's website into a text field. This puts the file itself in the
 * shop's own database, next to the banner and the shop's own logo, through the
 * same service.
 *
 * ── Why the picture is NOT re-encoded to JPEG ────────────────────────────────
 * A product photo is compressed to JPEG on the way out of the browser, which is
 * right for a photograph and wrong for a logo: JPEG has no transparency, so a
 * cut-out mark would arrive with a white rectangle behind it and wear that
 * rectangle on every dark band of the site. A small file is sent exactly as it
 * was chosen; only an oversized one is redrawn, and then to PNG, which keeps
 * the alpha channel.
 */
const LOGO_MAX_BYTES = 250 * 1024;
const LOGO_MAX_EDGE = 512;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t('photoUnreadable')));
    reader.readAsDataURL(file);
  });
}

async function prepareLogo(file) {
  const asIs = await readAsDataUrl(file);
  // Roughly the decoded size: base64 is a third larger than the bytes it carries.
  if (asIs.length * 0.75 <= LOGO_MAX_BYTES) return asIs;

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const longest = Math.max(image.naturalWidth, image.naturalHeight) || 1;
      const scale = Math.min(1, LOGO_MAX_EDGE / longest);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      // No white fill and no JPEG: a logo keeps whatever it was drawn on, which
      // for most of them is nothing at all.
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(t('photoUnreadable'))); };
    image.src = objectUrl;
  });
}

function openBrandLogo(row, refresh) {
  const preview = h('div', { class: 'brand-logo-preview' });
  const input = h('input', {
    type: 'file', accept: 'image/*', style: { display: 'none' },
    onchange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        mount(preview, spinner());
        await api.put(`/api/brands/${row.id}/logo`, { dataUrl: await prepareLogo(file) });
        toast(t('saved'));
        await load();
        refresh();
      } catch (error) { toastError(error); await load(); }
    },
  });

  let current = null;
  const host = h('div', { class: 'stack' }, input, preview);
  const dialog = modal({ title: `${t('logo')} — ${pick(row, 'name')}`, body: host });

  async function load() {
    try { current = await api.get(`/api/brands/${row.id}/logo`); } catch { current = null; }
    mount(preview,
      current?.hasImage
        // A cache-buster: the address has no id in it, so a replaced logo would
        // otherwise be answered from the browser's own copy of the old one.
        ? h('img', { class: 'brand-logo-shot', src: brandLogoUrl(row.id, current.updatedAt || ''), alt: '' })
        : h('div', { class: 'empty' }, h('span', { class: 'ico' }, '◍'), h('div', {}, t('noPhotosYet'))),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '10px' } },
        h('button', { class: 'btn sm', type: 'button', onclick: () => input.click() },
          current?.hasImage ? t('replace') : t('addPhoto')),
        current?.hasImage
          ? h('button', {
            class: 'btn sm ghost danger', type: 'button',
            onclick: async () => {
              try {
                await api.del(`/api/brands/${row.id}/logo`);
                toast(t('saved'));
                await load();
                refresh();
              } catch (error) { toastError(error); }
            },
          }, t('removePhoto'))
          : null),
      h('p', { class: 'muted small' }, t('brandLogoHint')));
  }

  load();
  return dialog;
}

// --------------------------------------------------------------------- brands

export const brandsView = resourceView({
  title: t('brands'),
  endpoint: '/api/brands',
  module: 'brands',
  trashType: 'brand',
  createLabel: t('brands'),
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    {
      key: 'name',
      label: t('name'),
      render: (r) => h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        // The mark first, because on this screen it is the thing being checked:
        // "which of my brands still has no picture on the website".
        r.has_logo
          ? h('img', { class: 'brand-logo-chip', src: brandLogoUrl(r.id), alt: '', loading: 'lazy' })
          : h('span', { class: 'brand-logo-chip is-empty' }, String(pick(r, 'name') || '?').trim().charAt(0)),
        h('span', { class: 'strong' }, pick(r, 'name'))),
    },
    { key: 'country', label: t('country') },
    { key: 'description', label: t('description'), render: (r) => h('span', { class: 'muted small' }, r.description || '—') },
    /*
     * Whether the WEBSITE shows this brand, and when it does not, which of the
     * two reasons it is. The owner uploaded logos and asked where they had gone
     * on the site; nothing was broken - the storefront shows a brand only when
     * the brand is published and at least one of its products is - but the ERP
     * said nothing, so the only way to find out was to guess.
     */
    {
      key: '__web',
      label: t('website'),
      render: (r) => {
        if (!r.is_published) return tag(t('brandHiddenUnpublished'), 'warn');
        if (!Number(r.published_product_count)) return tag(t('brandHiddenNoProducts'), 'warn');
        return tag(t('onTheWebsite'), 'ok');
      },
    },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => {
    const suppliers = await lookup('suppliers', '/api/suppliers/options');
    return [
      { name: 'name_en', label: t('nameEn'), required: true },
      { name: 'name_ar', label: t('nameAr') },
      { name: 'code', label: t('code'), hint: t('autoIfBlank') },
      { name: 'country', label: t('country') },
      { name: 'supplier_id', label: t('supplier'), type: 'select', options: toOptions(suppliers, (s) => pick(s, 'name')) },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
      {
        name: 'is_published',
        label: t('showOnWebsite'),
        type: 'checkbox',
        value: 1,
        hint: t('brandWebsiteHint'),
      },
      { name: 'description', label: t('description'), type: 'textarea', span: 2 },
    ];
  },
  defaults: { is_active: 1, is_published: 1 },
  rowActions: (row, refresh) => (can('brands.update')
    ? [h('button', {
      class: 'btn sm ghost', title: t('logo'), onclick: () => openBrandLogo(row, refresh),
    }, '◍')]
    : []),
});

// ----------------------------------------------------------------- categories

export const categoriesView = resourceView({
  title: t('categories'),
  endpoint: '/api/categories',
  module: 'categories',
  trashType: 'category',
  createLabel: t('categories'),
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('span', { class: 'strong' }, pick(r, 'name')) },
    { key: 'parent', label: t('parent'), render: (r) => r.parent_name || '—' },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => {
    const categories = await lookup('categories', '/api/categories/options');
    return [
      { name: 'name_en', label: t('nameEn'), required: true },
      { name: 'name_ar', label: t('nameAr') },
      { name: 'code', label: t('code'), hint: t('autoIfBlank') },
      { name: 'parent_id', label: t('parentCategory'), type: 'select', options: toOptions(categories, (c) => pick(c, 'name')) },
      { name: 'description', label: t('description'), type: 'textarea', span: 2 },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    ];
  },
  defaults: { is_active: 1 },
});

// -------------------------------------------------------------------- clients

export const customersView = resourceView({
  title: t('customers'),
  endpoint: '/api/customers',
  module: 'customers',
  trashType: 'customer',
  createLabel: t('newCustomer'),
  formSize: 'wide',
  label: (row) => row.name,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('span', { class: 'strong' }, r.name) },
    { key: 'phone', label: t('phone'), class: 'mono small' },
    { key: 'customer_group', label: t('customerGroup'), render: (r) => tag(t(r.customer_group), r.customer_group === 'vip' ? 'gold' : (r.customer_group === 'wholesale' ? 'info' : '')) },
    { key: 'balance', label: t('balance'), type: 'money', render: (r) => h('span', { class: r.balance > 0 ? 'strong' : 'muted' }, money(r.balance)) },
    { key: 'loyalty_points', label: t('loyaltyPoints'), type: 'number', render: (r) => number(r.loyalty_points) },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => [
    { name: 'name', label: t('name'), required: true, span: 2 },
    { name: 'code', label: t('code'), hint: t('autoIfBlank') },
    { name: 'phone', label: t('phone') },
    { name: 'email', label: t('email') },
    {
      name: 'customer_group',
      label: t('customerGroup'),
      type: 'select',
      required: true,
      options: [
        { value: 'retail', label: t('retail') },
        { value: 'wholesale', label: t('wholesale') },
        { value: 'vip', label: t('vip') },
      ],
    },
    { name: 'city', label: t('city') },
    { name: 'tax_number', label: t('taxNumber') },
    { name: 'credit_limit', label: t('creditLimit'), type: 'number', hint: t('creditLimitHint') },
    { name: 'address', label: t('address'), type: 'textarea', span: 2 },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 2 },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
  ],
  defaults: { is_active: 1, customer_group: 'retail', credit_limit: 0 },
  rowActions: (row, refresh) => (row.balance > 0 && can('customers.update') ? [
    h('button', {
      class: 'btn sm',
      onclick: () => openSettle(row, refresh),
    }, t('settleBalance')),
  ] : []),
  onRowClick: async (row) => {
    try {
      const customer = await api.get(`/api/customers/${row.id}`);
      modal({
        title: `${customer.code} — ${customer.name}`,
        size: 'wide',
        body: h('div', { class: 'stack' },
          h('div', { class: 'kpis' },
            statCard(t('totalSpent'), money(customer.statistics.total_spent)),
            statCard(t('invoice'), number(customer.statistics.invoice_count)),
            statCard(t('averageBasket'), money(customer.statistics.average_basket)),
            statCard(t('balance'), money(customer.balance)),
            statCard(t('loyaltyPoints'), number(customer.loyalty_points))),
          h('h4', {}, t('purchaseHistory')),
          dataTable({
            columns: [
              { key: 'invoice_no', label: t('invoiceNo'), class: 'mono small' },
              { key: 'sale_date', label: t('date'), render: (r) => date(r.sale_date) },
              { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
              { key: 'payment_status', label: t('paymentStatus') },
            ],
            rows: customer.recentSales,
          }),
          customer.topProducts.length ? h('div', {}, h('h4', {}, t('topProducts')), dataTable({
            columns: [
              { key: 'sku', label: t('sku'), class: 'mono small' },
              { key: 'description', label: t('product') },
              { key: 'qty', label: t('qty'), type: 'number', render: (r) => number(r.qty) },
              { key: 'value', label: t('total'), type: 'money', render: (r) => money(r.value) },
            ],
            rows: customer.topProducts,
          })) : null),
      });
    } catch (error) { toastError(error); }
  },
});

function openSettle(customer, refresh) {
  const form = buildForm([
    { name: 'amount', label: t('amount'), type: 'number', required: true, value: customer.balance },
    {
      name: 'method',
      label: t('paymentMethod'),
      type: 'select',
      required: true,
      options: [
        { value: 'cash', label: t('cash') },
        { value: 'card', label: t('card') },
        { value: 'transfer', label: t('transfer') },
        { value: 'wallet', label: t('wallet') },
      ],
    },
    { name: 'reference', label: t('reference'), span: 2 },
  ], { method: 'cash' }, { columns: 2 });

  const dialog = modal({
    title: `${t('settleBalance')} — ${customer.name}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${t('outstanding')}: ${money(customer.balance)}`),
      form.node),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            await api.post(`/api/customers/${customer.id}/settle`, form.values());
            toast(t('saved'));
            dialog.close();
            refresh();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

// ----------------------------------------------------------------- attributes

export async function attributesView(root) {
  const host = h('div', { class: 'stack' }, spinner());

  async function load() {
    const data = await api.get('/api/attributes/with-values');
    mount(host, ...data.rows.map(renderAttribute));
  }

  function renderAttribute(attribute) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', {}, pick(attribute, 'name')),
        h('span', { class: 'tag' }, attribute.code),
        h('span', { class: 'tag info' }, attribute.input_type),
        h('span', { class: 'spacer' }),
        attribute.is_active ? null : tag(t('inactive')),
        can('attributes.create')
          ? h('button', { class: 'btn sm', onclick: () => openValueForm(attribute) }, '＋ ' + t('value'))
          : null,
        can('attributes.update')
          ? h('button', { class: 'btn sm ghost', onclick: () => openAttributeForm(attribute) }, '✎')
          : null,
        can('attributes.delete')
          ? h('button', {
            class: 'btn sm ghost',
            onclick: async () => {
              if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
              try { await api.del(`/api/attributes/${attribute.id}`); toast(t('deleted')); load(); } catch (e) { toastError(e); }
            },
          }, '🗑')
          : null),
      h('div', { class: 'card-body' },
        attribute.values.length
          ? h('div', { class: 'row' }, attribute.values.map((value) => h('span', {
            class: 'attr-chip',
            style: { cursor: can('attributes.update') ? 'pointer' : 'default' },
            onclick: () => can('attributes.update') && openValueForm(attribute, value),
          },
          value.color_hex ? h('span', { class: 'swatch', style: { background: value.color_hex } }) : null,
          ' ' + pick(value, 'value'),
          h('small', { class: 'muted' }, ` (${value.code})`))))
          : h('div', { class: 'muted small' }, t('noResults'))));
  }

  async function openAttributeForm(attribute = null) {
    const form = buildForm([
      { name: 'name_en', label: t('nameEn'), required: true },
      { name: 'name_ar', label: t('nameAr') },
      { name: 'code', label: t('code'), hint: t('autoIfBlank') },
      {
        name: 'input_type',
        label: t('type'),
        type: 'select',
        required: true,
        options: [{ value: 'select', label: t('listOfValues') }, { value: 'color', label: t('colourSwatches') }],
      },
      { name: 'display_order', label: t('displayOrder'), type: 'number' },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    ], attribute || { is_active: 1, input_type: 'select', display_order: 0 });

    const dialog = modal({
      title: attribute ? t('edit') : t('attributes'),
      size: 'narrow',
      body: form.node,
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            try {
              const payload = form.values();
              if (attribute) await api.put(`/api/attributes/${attribute.id}`, payload);
              else await api.post('/api/attributes', payload);
              toast(t('saved'));
              invalidate('attributes');
              dialog.close();
              load();
            } catch (error) { toastError(error); }
          },
        }, t('save')),
      ],
    });
  }

  async function openValueForm(attribute, value = null) {
    const form = buildForm([
      { name: 'code', label: t('code'), required: true, hint: t('attributeCodeHint') },
      { name: 'value_en', label: t('nameEn'), required: true },
      { name: 'value_ar', label: t('nameAr') },
      ...(attribute.input_type === 'color' ? [{ name: 'color_hex', label: t('colour'), type: 'color' }] : []),
      { name: 'display_order', label: t('displayOrder'), type: 'number' },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    ], value || { is_active: 1, display_order: 0, color_hex: '#000000' });

    const dialog = modal({
      title: `${pick(attribute, 'name')} — ${value ? t('edit') : t('add')}`,
      size: 'narrow',
      body: form.node,
      footer: [
        value && can('attributes.delete') ? h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
            try {
              await api.del(`/api/attributes/values/${value.id}`);
              toast(t('deleted')); dialog.close(); load();
            } catch (error) { toastError(error); }
          },
        }, t('delete')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            try {
              const payload = form.values();
              if (value) await api.put(`/api/attributes/values/${value.id}`, payload);
              else await api.post(`/api/attributes/${attribute.id}/values`, payload);
              toast(t('saved'));
              invalidate('attributes');
              dialog.close();
              load();
            } catch (error) { toastError(error); }
          },
        }, t('save')),
      ],
    });
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('attributes')),
        h('p', {}, t('attributesSubtitle'))),
      h('span', { class: 'spacer' }),
      can('attributes.create')
        ? h('button', { class: 'btn primary', onclick: () => openAttributeForm(null) }, '＋ ' + t('attributes'))
        : null),
    host);

  await load();
}

function statCard(label, value) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value', style: { fontSize: '18px' } }, value));
}
