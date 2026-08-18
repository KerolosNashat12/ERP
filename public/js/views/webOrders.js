/**
 * Web orders — the screen where a promise from the website becomes a sale.
 *
 * The list is deliberately opinionated: pending first, because a pending order
 * is holding stock nobody can sell and is the only status that needs somebody
 * to do something. Everything else is history.
 *
 * Confirm / Cancel / Mark delivered are gated by `can(...)` rather than hidden
 * behind a role name, and Cancel always asks for a reason — an order that
 * vanished with no explanation is the thing the shop argues about later.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  field, modal, statusTag, tag,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, dateTime } from '../core/format.js';
import { can, setBadge } from '../core/store.js';
import { navigate } from '../core/router.js';

const STATUSES = ['pending', 'confirmed', 'delivered', 'cancelled'];

export async function webOrdersView(root, route) {
  if (route.segments[1]) return orderDetailView(root, Number(route.segments[1]));

  const state = { status: route.query.status || '', page: 1 };
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const kpiHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/web-orders', state);

    // The screen has just read the authoritative number, so the nav badge may
    // as well be right rather than waiting for the next shell refresh.
    setBadge('pendingWebOrders', data.counts.pending);

    mount(kpiHost, ...STATUSES.map((status) => kpi(t(status), number(data.counts[status]))));

    mount(listHost, dataTable({
      columns: [
        { key: 'order_no', label: t('orderNo'), class: 'mono small' },
        { key: 'created_at', label: t('placedAt'), render: (r) => h('span', { class: 'small' }, dateTime(r.created_at)) },
        { key: 'customer_name', label: t('customer') },
        { key: 'customer_phone', label: t('phone'), class: 'mono small' },
        { key: 'address_city', label: t('city'), render: (r) => r.address_city || '—' },
        { key: 'line_count', label: t('products'), type: 'number' },
        {
          key: 'total_amount',
          label: t('total'),
          type: 'money',
          render: (r) => h('span', { class: 'strong' }, money(r.total_amount)),
        },
        { key: 'status', label: t('status'), render: (r) => statusTag(r.status) },
        {
          key: 'invoice_no',
          label: t('invoice'),
          render: (r) => (r.invoice_no ? h('span', { class: 'mono small' }, r.invoice_no) : '—'),
        },
      ],
      rows: data.rows,
      rowClass: (r) => (r.status === 'cancelled' ? 'muted' : ''),
      onRowClick: (row) => navigate(`web-orders/${row.id}`),
      emptyMessage: t('noWebOrders'),
    }));

    mount(pagerHost, pager({
      page: data.page,
      pages: data.pages,
      total: data.total,
      onPage: (p) => { state.page = p; load(); },
    }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('webOrders')), h('p', {}, t('webOrdersSubtitle')))),
    kpiHost,
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field' }, field({
          label: t('status'),
          input: selectInput({
            placeholder: t('all'),
            value: state.status,
            options: STATUSES.map((status) => ({ value: status, label: t(status) })),
            onchange: (event) => { state.status = event.target.value; state.page = 1; load(); },
          }),
        })),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => load() }, t('refresh'))),
      listHost, pagerHost));

  await load();
  return undefined;
}

const kpi = (label, value) => h('div', { class: 'kpi' },
  h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

const row = (label, value, cls = '') => h('div', { class: `line ${cls}` },
  h('span', {}, label), h('span', { class: 'mono' }, value));

async function orderDetailView(root, id) {
  const order = await api.get(`/api/web-orders/${id}`);
  const address = [order.address_line, order.address_area, order.address_city]
    .filter(Boolean).join(' — ');

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, `${t('orderNo')} ${order.order_no}`),
        h('p', {}, statusTag(order.status), ' · ', dateTime(order.created_at),
          order.confirmed_by_name ? ` · ${t('confirmedBy')}: ${order.confirmed_by_name}` : '')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('web-orders') }, '‹ ' + t('back')),
      order.sale_id
        ? h('button', { class: 'btn', onclick: () => navigate(`sales/${order.sale_id}`) }, t('viewInvoice'))
        : null,
      order.status === 'pending' && can('weborders.confirm')
        ? h('button', { class: 'btn gold', onclick: () => openConfirm(order) }, t('confirmOrder')) : null,
      order.status === 'confirmed' && can('weborders.confirm')
        ? h('button', { class: 'btn primary', onclick: () => act(order, 'delivered', t('orderDelivered')) }, t('markDelivered')) : null,
      ['pending', 'confirmed'].includes(order.status) && can('weborders.cancel')
        ? h('button', { class: 'btn danger', onclick: () => openCancel(order) }, t('cancelOrder')) : null),

    h('div', { class: 'grid cols-4' },
      kpi(t('total'), money(order.total_amount)),
      kpi(t('deliveryFee'), order.delivery_fee ? money(order.delivery_fee) : t('freeDelivery')),
      kpi(t('customer'), order.customer_name || '—'),
      kpi(t('phone'), order.customer_phone || '—')),

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('orderItems')),
        h('span', { class: 'spacer' }),
        // What this order is still holding off the shelf. Zero once it has been
        // confirmed or cancelled — that is the reservation being given back.
        tag(`${t('reservedUnits')}: ${number(order.lines.reduce((s, l) => s + Number(l.reserved || 0), 0))}`,
          order.lines.some((l) => Number(l.reserved) > 0) ? 'warn' : '')),
      h('div', { class: 'card-body tight' }, dataTable({
        columns: [
          { key: 'sku', label: t('sku'), class: 'mono small' },
          {
            key: 'description',
            label: t('product'),
            render: (line) => pick(line, 'product_name') || line.description,
          },
          { key: 'variant_label', label: t('variant'), render: (line) => line.variant_label || '—' },
          { key: 'quantity', label: t('qty'), type: 'number', render: (line) => number(line.quantity) },
          { key: 'unit_price', label: t('price'), type: 'money', render: (line) => money(line.unit_price) },
          { key: 'tax_amount', label: t('tax'), type: 'money', render: (line) => money(line.tax_amount) },
          {
            key: 'line_total',
            label: t('total'),
            type: 'money',
            render: (line) => h('span', { class: 'strong' }, money(line.line_total)),
          },
        ],
        rows: order.lines,
      }))),

    h('div', { class: 'grid cols-2', style: { marginTop: '14px' } },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('deliveryAddress'))),
        h('div', { class: 'card-body' },
          h('div', { class: 'stack' },
            h('div', { class: 'strong' }, order.customer_name),
            h('div', { class: 'mono small' }, order.customer_phone),
            order.customer_email ? h('div', { class: 'small muted' }, order.customer_email) : null,
            h('div', {}, address || '—'),
            order.address_notes ? h('div', { class: 'small muted' }, order.address_notes) : null,
            order.customer_note
              ? h('div', { class: 'small' }, `${t('customerNote')}: ${order.customer_note}`) : null,
            order.cancelled_reason
              ? h('div', { class: 'small' }, `${t('cancelReason')} ${order.cancelled_reason}`) : null))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('summary'))),
        h('div', { class: 'card-body' },
          h('div', { class: 'totals' },
            row(t('subtotal'), money(order.subtotal)),
            row(t('tax'), money(order.tax_amount)),
            row(t('goodsTotal'), money(order.subtotal + order.tax_amount)),
            row(t('deliveryFee'), order.delivery_fee ? money(order.delivery_fee) : t('freeDelivery')),
            row(t('total'), money(order.total_amount), 'grand'),
            order.invoice_no ? row(t('invoice'), order.invoice_no) : null)))));

  return undefined;
}

/** POST one of the three verbs, tell the user what happened, reload. */
async function act(order, verb, okMessage, body) {
  try {
    const result = await api.post(`/api/web-orders/${order.id}/${verb}`, body || {});
    // The service explains anything the shop still has to do by hand — a sale
    // that needs voiding, most of all — so it is shown, not swallowed.
    toast(result?.message || okMessage, 'ok', result?.message ? 6500 : 3800);
    try {
      const { pending } = await api.get('/api/web-orders/count');
      setBadge('pendingWebOrders', pending);
    } catch { /* the badge is a hint, not the point of the click */ }
    window.location.reload();
  } catch (error) {
    toastError(error);
  }
}

function openConfirm(order) {
  const dialog = modal({
    title: `${t('confirmOrder')} — ${order.order_no}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, t('confirmOrderHint')),
      h('div', { class: 'totals' },
        row(t('customer'), order.customer_name || '—'),
        row(t('products'), number(order.lines.length)),
        row(t('total'), money(order.total_amount), 'grand'))),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn gold',
        onclick: () => { dialog.close(); act(order, 'confirm', t('orderConfirmed')); },
      }, t('confirmOrder')),
    ],
  });
}

function openCancel(order) {
  const reason = textInput({ placeholder: t('cancelReason') });
  const dialog = modal({
    title: `${t('cancelOrder')} — ${order.order_no}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, t('cancelOrderHint')),
      field({ label: t('reason'), input: reason })),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('back')),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          dialog.close();
          act(order, 'cancel', t('orderCancelled'), { reason: reason.value });
        },
      }, t('cancelOrder')),
    ],
  });
}

export default webOrdersView;
