/** Promotions & vouchers: list, editor with targets, voucher batch generator. */
import api from '../core/api.js';
import { resourceView } from './resource.js';
import {
  h, mount, tag, toast, toastError, modal, buildForm, dataTable,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, date } from '../core/format.js';
import { lookup, can } from '../core/store.js';

const promotionState = (row) => {
  const today = new Date().toISOString().slice(0, 10);
  if (!row.is_active) return tag(t('inactive'));
  if (row.ends_at && row.ends_at < today) return tag(t('expired'), 'danger');
  if (row.starts_at && row.starts_at > today) return tag(t('scheduled'), 'info');
  if (row.usage_limit > 0 && row.usage_count >= row.usage_limit) return tag(t('usageLimit'), 'warn');
  return tag(t('live'), 'ok');
};

export const promotionsView = resourceView({
  title: t('promotions'),
  subtitle: t('promotionsSubtitle'),
  endpoint: '/api/promotions',
  module: 'promotions',
  trashType: 'promotion',
  createLabel: t('newPromotion'),
  formSize: 'wide',
  label: (row) => row.code,
  columns: () => [
    { key: 'code', label: t('promotionCode'), render: (r) => h('span', { class: 'mono strong' }, r.code) },
    { key: 'name', label: t('name'), render: (r) => pick(r, 'name') },
    { key: 'kind', label: t('promotionKind'), render: (r) => tag(r.kind === 'voucher' ? t('voucher') : t('discountCode'), r.kind === 'voucher' ? 'gold' : 'info') },
    {
      key: 'value',
      label: t('value'),
      render: (r) => (r.discount_type === 'percentage' ? `${number(r.value)}%` : money(r.value)),
    },
    { key: 'scope', label: t('scope'), render: (r) => t(r.scope === 'order' ? 'wholeOrder' : r.scope) },
    { key: 'min_order_amount', label: t('minOrder'), type: 'money', render: (r) => (r.min_order_amount ? money(r.min_order_amount) : '—') },
    {
      key: 'usage',
      label: t('usageCount'),
      type: 'number',
      render: (r) => `${number(r.usage_count)}${r.usage_limit ? ` / ${number(r.usage_limit)}` : ''}`,
    },
    { key: 'ends_at', label: t('endsAt'), render: (r) => (r.ends_at ? date(r.ends_at) : '—') },
    { key: 'state', label: t('status'), render: promotionState },
  ],
  headerActions: (refresh) => (can('promotions.create') ? [
    h('button', { class: 'btn', onclick: () => openVoucherBatch(refresh) }, t('generateVouchers')),
  ] : []),
  fields: async () => [
    { name: 'code', label: t('promotionCode'), required: true, hint: t('promoCodeHint') },
    { name: 'name_en', label: t('nameEn'), required: true },
    { name: 'name_ar', label: t('nameAr') },
    {
      name: 'kind',
      label: t('promotionKind'),
      type: 'select',
      required: true,
      options: [{ value: 'discount', label: t('discountCode') }, { value: 'voucher', label: t('voucher') }],
    },
    {
      name: 'discount_type',
      label: t('type'),
      type: 'select',
      required: true,
      options: [{ value: 'percentage', label: t('percentage') }, { value: 'fixed', label: t('fixedAmount') }],
    },
    { name: 'value', label: t('value'), type: 'number', required: true },
    {
      name: 'scope',
      label: t('scope'),
      type: 'select',
      required: true,
      options: [
        { value: 'order', label: t('wholeOrder') },
        { value: 'product', label: t('product') },
        { value: 'category', label: t('category') },
        { value: 'brand', label: t('brand') },
      ],
    },
    { name: 'min_order_amount', label: t('minOrder'), type: 'number' },
    { name: 'max_discount_amount', label: t('maxDiscount'), type: 'number' },
    { name: 'starts_at', label: t('startsAt'), type: 'date' },
    { name: 'ends_at', label: t('endsAt'), type: 'date' },
    { name: 'usage_limit', label: t('usageLimit'), type: 'number' },
    { name: 'per_customer_limit', label: t('perCustomerLimit'), type: 'number' },
    {
      name: 'customer_group',
      label: t('customerGroup'),
      type: 'select',
      placeholder: t('all'),
      options: [
        { value: 'retail', label: t('retail') },
        { value: 'wholesale', label: t('wholesale') },
        { value: 'vip', label: t('vip') },
      ],
    },
    { name: 'voucher_balance', label: t('voucherBalance'), type: 'number', hint: t('vouchersOnly') },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
  ],
  defaults: {
    is_active: 1, kind: 'discount', discount_type: 'percentage', scope: 'order',
    value: 10, min_order_amount: 0, max_discount_amount: 0, usage_limit: 0, per_customer_limit: 0,
  },
  formColumns: 3,
  /** Target picker shown under the form when the scope is not "whole order". */
  formExtra: async (record, form) => {
    const [products, categories, brands] = await Promise.all([
      api.get('/api/products', { pageSize: 300 }).then((d) => d.rows),
      lookup('categories', '/api/categories/options'),
      lookup('brands', '/api/brands/options'),
    ]);
    const selected = new Set((record?.targets || []).map((x) => `${x.target_type}:${x.target_id}`));
    const host = h('div');

    const render = () => {
      const scope = form.inputs.get('scope').input.value;
      if (scope === 'order') { mount(host, h('div', { class: 'muted small' }, t('wholeOrder'))); return; }
      const source = { product: products, category: categories, brand: brands }[scope] || [];
      mount(host,
        h('label', { class: 'small strong' }, t('targets')),
        h('div', { class: 'attr-picker', style: { maxHeight: '190px', overflowY: 'auto' } },
          source.map((item) => {
            const key = `${scope}:${item.id}`;
            return h('button', {
              type: 'button',
              class: `attr-chip${selected.has(key) ? ' on' : ''}`,
              onclick: (event) => {
                if (selected.has(key)) selected.delete(key); else selected.add(key);
                event.currentTarget.classList.toggle('on');
              },
            }, pick(item, 'name'));
          })));
    };

    form.inputs.get('scope').input.addEventListener('change', render);
    render();
    // Expose the chosen targets to beforeSubmit.
    host.dataset.targets = '';
    host.getTargets = () => [...selected].map((key) => {
      const [target_type, target_id] = key.split(':');
      return { target_type, target_id: Number(target_id) };
    });
    promotionsView.targetHost = host;
    return host;
  },
  beforeSubmit: (payload) => {
    const host = promotionsView.targetHost;
    const targets = host?.getTargets ? host.getTargets() : [];
    return {
      ...payload,
      customer_group: payload.customer_group || null,
      targets: payload.scope === 'order' ? [] : targets,
    };
  },
  onRowClick: async (row) => {
    try {
      const promotion = await api.get(`/api/promotions/${row.id}`);
      modal({
        title: `${promotion.code} — ${pick(promotion, 'name')}`,
        size: 'wide',
        body: h('div', { class: 'stack' },
          h('div', { class: 'kpis' },
            h('div', { class: 'kpi' }, h('div', { class: 'label' }, t('usageCount')), h('div', { class: 'value' }, number(promotion.usage_count))),
            h('div', { class: 'kpi' }, h('div', { class: 'label' }, t('value')),
              h('div', { class: 'value' }, promotion.discount_type === 'percentage' ? `${promotion.value}%` : money(promotion.value))),
            promotion.kind === 'voucher'
              ? h('div', { class: 'kpi' }, h('div', { class: 'label' }, t('voucherBalance')), h('div', { class: 'value' }, money(promotion.voucher_balance)))
              : null),
          h('h4', {}, t('sales')),
          dataTable({
            columns: [
              { key: 'redeemed_at', label: t('date'), render: (r) => date(r.redeemed_at) },
              { key: 'invoice_no', label: t('invoice'), class: 'mono small' },
              { key: 'customer_name', label: t('customer'), render: (r) => r.customer_name || '—' },
              { key: 'discount_amount', label: t('discount'), type: 'money', render: (r) => money(r.discount_amount) },
            ],
            rows: promotion.redemptions,
          })),
      });
    } catch (error) { toastError(error); }
  },
});

function openVoucherBatch(refresh) {
  const form = buildForm([
    { name: 'prefix', label: t('codePrefix'), required: true, value: 'MMV' },
    { name: 'count', label: t('voucherCount'), type: 'number', required: true, value: 10 },
    { name: 'value', label: t('voucherValue'), type: 'number', required: true, value: 100 },
    { name: 'expiresAt', label: t('endsAt'), type: 'date' },
  ], {}, { columns: 2 });

  const output = h('div');
  const dialog = modal({
    title: t('generateVouchers'),
    size: '',
    body: h('div', { class: 'stack' }, form.node, output),
    footer: [
      h('button', { class: 'btn', onclick: () => { dialog.close(); refresh(); } }, t('close')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            const { rows } = await api.post('/api/promotions/vouchers/generate', form.values());
            toast(`${rows.length} ${t('voucher')}`);
            mount(output, dataTable({
              columns: [
                { key: 'code', label: t('promotionCode'), class: 'mono strong' },
                { key: 'value', label: t('value'), type: 'money', render: (r) => money(r.value) },
                { key: 'ends_at', label: t('endsAt'), render: (r) => (r.ends_at ? date(r.ends_at) : '—') },
              ],
              rows,
            }));
          } catch (error) { toastError(error); }
        },
      }, t('create')),
    ],
  });
}
