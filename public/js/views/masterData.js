/** Suppliers, brands, categories, clients and attributes screens. */
import api from '../core/api.js';
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
  createLabel: t('suppliers'),
  formSize: 'wide',
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('div', {}, h('div', { class: 'strong' }, pick(r, 'name')), r.contact_person ? h('small', { class: 'muted' }, r.contact_person) : null) },
    { key: 'phone', label: t('phone'), class: 'mono small' },
    { key: 'city', label: t('city') },
    { key: 'payment_terms_days', label: 'Terms', type: 'number', render: (r) => `${r.payment_terms_days} d` },
    { key: 'lead_time_days', label: 'Lead', type: 'number', render: (r) => `${r.lead_time_days} d` },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => [
    { name: 'name_en', label: t('nameEn'), required: true },
    { name: 'name_ar', label: t('nameAr') },
    { name: 'code', label: t('code'), hint: 'Leave blank to auto-generate' },
    { name: 'contact_person', label: 'Contact person' },
    { name: 'phone', label: t('phone') },
    { name: 'email', label: t('email') },
    { name: 'city', label: t('city') },
    { name: 'country', label: t('country') },
    { name: 'tax_number', label: 'Tax number' },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
    { name: 'lead_time_days', label: 'Lead time (days)', type: 'number' },
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

// --------------------------------------------------------------------- brands

export const brandsView = resourceView({
  title: t('brands'),
  endpoint: '/api/brands',
  module: 'brands',
  createLabel: t('brands'),
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('span', { class: 'strong' }, pick(r, 'name')) },
    { key: 'country', label: t('country') },
    { key: 'description', label: t('description'), render: (r) => h('span', { class: 'muted small' }, r.description || '—') },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => {
    const suppliers = await lookup('suppliers', '/api/suppliers/options');
    return [
      { name: 'name_en', label: t('nameEn'), required: true },
      { name: 'name_ar', label: t('nameAr') },
      { name: 'code', label: t('code'), hint: 'Auto if blank' },
      { name: 'country', label: t('country') },
      { name: 'supplier_id', label: t('supplier'), type: 'select', options: toOptions(suppliers, (s) => pick(s, 'name')) },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
      { name: 'description', label: t('description'), type: 'textarea', span: 2 },
    ];
  },
  defaults: { is_active: 1 },
});

// ----------------------------------------------------------------- categories

export const categoriesView = resourceView({
  title: t('categories'),
  endpoint: '/api/categories',
  module: 'categories',
  createLabel: t('categories'),
  label: (row) => row.name_en,
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (r) => h('span', { class: 'strong' }, pick(r, 'name')) },
    { key: 'parent', label: 'Parent', render: (r) => r.parent_name || '—' },
    { key: 'is_active', label: t('status'), render: activeTag },
  ],
  fields: async () => {
    const categories = await lookup('categories', '/api/categories/options');
    return [
      { name: 'name_en', label: t('nameEn'), required: true },
      { name: 'name_ar', label: t('nameAr') },
      { name: 'code', label: t('code'), hint: 'Auto if blank' },
      { name: 'parent_id', label: 'Parent category', type: 'select', options: toOptions(categories, (c) => pick(c, 'name')) },
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
    { name: 'code', label: t('code'), hint: 'Auto if blank' },
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
    { name: 'tax_number', label: 'Tax number' },
    { name: 'credit_limit', label: t('creditLimit'), type: 'number', hint: '0 = cash only' },
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
      { name: 'code', label: t('code'), hint: 'Auto if blank' },
      {
        name: 'input_type',
        label: t('type'),
        type: 'select',
        required: true,
        options: [{ value: 'select', label: 'List of values' }, { value: 'color', label: 'Colour swatches' }],
      },
      { name: 'display_order', label: 'Order', type: 'number' },
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
      { name: 'code', label: t('code'), required: true, hint: 'Used in the SKU, e.g. L or RED' },
      { name: 'value_en', label: t('nameEn'), required: true },
      { name: 'value_ar', label: t('nameAr') },
      ...(attribute.input_type === 'color' ? [{ name: 'color_hex', label: 'Colour', type: 'color' }] : []),
      { name: 'display_order', label: 'Order', type: 'number' },
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
        h('p', {}, 'Size, colour and material options that build your product variants')),
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
