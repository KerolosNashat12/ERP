/** Invoice list, invoice detail (with void / collect / return), returns list. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  field, modal, debounce, statusTag, buildForm, printNode, tag, matchNote,
} from '../core/ui.js';
import { t } from '../core/i18n.js';
import { money, number, date, dateTime } from '../core/format.js';
import { can } from '../core/store.js';
import { navigate } from '../core/router.js';
import { showReceiptDialog, buildReceipt } from './pos.js';
import { confirmDelete } from './trash.js';


/**
 * Whether this invoice has had anything back.
 *
 * Drawn from `return_state`, which the server derives from the lines
 * themselves — there is no stored "returned" status to fall out of step with
 * them. Nothing at all is drawn for an untouched invoice: a badge saying "not
 * returned" on every row is noise on a screen that is mostly untouched
 * invoices.
 */
const returnTag = (state) => {
  if (state === 'full') return tag(t('returnedFully'), 'danger');
  if (state === 'partial') return tag(t('returnedPartly'), 'warn');
  return null;
};

export async function salesView(root, route) {
  if (route.segments[1]) return saleDetailView(root, Number(route.segments[1]));

  const state = { search: '', status: '', paymentStatus: '', dateFrom: '', dateTo: '', page: 1, pageSize: 25 };
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const summaryHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/sales', state);
    mount(summaryHost,
      kpi(t('revenue'), money(data.summary.total_sales)),
      kpi(t('profit'), money(data.summary.gross_profit)),
      kpi(t('outstanding'), money(data.summary.outstanding)),
      kpi(t('invoice'), number(data.total)));

    mount(listHost, dataTable({
      columns: [
        {
          key: 'invoice_no',
          label: t('invoiceNo'),
          class: 'mono small',
          // An invoice can now be found by what it sold, so it has to say when
          // that is why it is here — otherwise a barcode search looks like a
          // list of unrelated documents.
          render: (r) => h('div', {}, h('div', {}, r.invoice_no), matchNote(r)),
        },
        { key: 'sale_date', label: t('date'), render: (r) => h('span', { class: 'small' }, dateTime(r.sale_date)) },
        { key: 'customer_name', label: t('customer'), render: (r) => r.customer_name || t('walkIn') },
        { key: 'line_count', label: t('products'), type: 'number' },
        { key: 'total_amount', label: t('total'), type: 'money', render: (r) => h('span', { class: 'strong' }, money(r.total_amount)) },
        { key: 'discount_amount', label: t('discount'), type: 'money', render: (r) => money(r.discount_amount) },
        { key: 'payment_method', label: t('paymentMethod'), render: (r) => tag(t(r.payment_method, r.payment_method)) },
        { key: 'payment_status', label: t('paymentStatus'), render: (r) => statusTag(r.payment_status) },
        {
          key: 'status',
          label: t('status'),
          // Two facts in one cell: what the invoice is, and whether any of it
          // came back. The second is the question the counter actually asks
          // when a customer turns up with a bag and a receipt.
          render: (r) => h('div', { class: 'row nowrap', style: { gap: '4px' } },
            statusTag(r.status),
            returnTag(r.return_state)),
        },
        { key: 'cashier_name', label: t('cashier'), render: (r) => h('span', { class: 'small muted' }, r.cashier_name || '—') },
      ],
      rows: data.rows,
      rowClass: (r) => (r.status === 'void' ? 'muted' : ''),
      onRowClick: (row) => navigate(`sales/${row.id}`),
    }));
    mount(pagerHost, pager({ page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); } }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('sales')), h('p', {}, t('navOperations'))),
      h('span', { class: 'spacer' }),
      can('sales.view') ? h('button', { class: 'btn', onclick: openShiftSummary }, t('shiftSummary')) : null,
      can('sales.view') ? h('button', { class: 'btn', onclick: () => navigate('returns') }, t('returns')) : null,
      can('sales.create') ? h('button', { class: 'btn gold', onclick: () => navigate('pos') }, '＋ ' + t('newSale')) : null),
    summaryHost,
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, textInput({
          placeholder: t('searchNameOrCode'),
          oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
        })),
        h('div', { class: 'field' }, field({
          label: t('from'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateFrom = e.target.value; state.page = 1; load(); } }),
        })),
        h('div', { class: 'field' }, field({
          label: t('to'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateTo = e.target.value; state.page = 1; load(); } }),
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('status'),
          options: [{ value: 'completed', label: t('completed') }, { value: 'void', label: t('void') }],
          onchange: (e) => { state.status = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('paymentStatus'),
          options: ['paid', 'partial', 'unpaid'].map((v) => ({ value: v, label: t(v) })),
          onchange: (e) => { state.paymentStatus = e.target.value; state.page = 1; load(); },
        }))),
      listHost, pagerHost));

  await load();
  return undefined;
}

const kpi = (label, value) => h('div', { class: 'kpi' },
  h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

async function saleDetailView(root, id) {
  const sale = await api.get(`/api/sales/${id}`);
  const outstanding = sale.total_amount - sale.paid_amount;

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, `${t('invoice')} ${sale.invoice_no}`),
        h('p', {}, statusTag(sale.status), ' ', statusTag(sale.payment_status), ' ',
          returnTag(sale.return_state), ' · ',
          dateTime(sale.sale_date), ' · ', sale.cashier_name || '')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('sales') }, '‹ ' + t('back')),
      h('button', { class: 'btn', onclick: () => printNode(buildReceipt(sale)) }, '🖨 ' + t('printReceipt')),
      h('button', { class: 'btn', onclick: () => showReceiptDialog(sale) }, t('view')),
      sale.status === 'completed' && outstanding > 0.01 && can('sales.create')
        ? h('button', { class: 'btn primary', onclick: () => openCollect(sale) }, t('collectPayment')) : null,
      sale.status === 'completed' && can('sales.return')
        ? h('button', {
          class: 'btn',
          onclick: () => navigate(`returns/new?invoice=${encodeURIComponent(sale.invoice_no)}`),
        }, t('newReturn')) : null,
      sale.status === 'completed' && can('sales.void')
        ? h('button', { class: 'btn danger', onclick: () => openVoid(sale) }, t('voidSale')) : null,
      /*
       * Void and delete are not the same act, and both belong here.
       *
       * VOID leaves the invoice on the screen, marked, which is what a shop
       * does with a sale that went wrong in front of the customer. DELETE
       * voids it too — the money and the stock are un-done exactly the same
       * way — and then takes it off the screen for thirty days, which is what
       * a shop does with an invoice that should never have existed at all. It
       * can be brought back inside those thirty days, and comes back VOID:
       * restoring undoes the hiding, never the reversal.
       */
      can('sales.void')
        ? h('button', {
          class: 'btn ghost danger',
          title: t('delete'),
          onclick: () => confirmDelete({
            entityType: 'sale',
            entityId: sale.id,
            onDone: () => navigate('sales'),
          }),
        }, '🗑') : null),

    h('div', { class: 'grid cols-4' },
      kpi(t('total'), money(sale.total_amount)),
      kpi(t('paid'), money(sale.paid_amount)),
      kpi(t('outstanding'), money(outstanding)),
      kpi(t('customer'), sale.customer_name || t('walkIn'))),

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('products')),
        h('span', { class: 'spacer' }),
        sale.promotion_code ? tag(`${sale.promotion_code} · −${money(sale.promotion_discount)}`, 'ok') : null),
      h('div', { class: 'card-body tight' }, dataTable({
        columns: [
          { key: 'sku', label: t('sku'), class: 'mono small' },
          { key: 'description', label: t('product') },
          { key: 'quantity', label: t('qty'), type: 'number', render: (r) => number(r.quantity) },
          { key: 'returned_quantity', label: t('returns'), type: 'number', render: (r) => (r.returned_quantity ? number(r.returned_quantity) : '—') },
          {
            key: 'unit_price',
            label: t('price'),
            type: 'money',
            // What was charged, with what it was marked at above it when the
            // line was sold on offer. Answers "why is this 800 when the ticket
            // says 1,000" without anybody having to remember last month.
            render: (r) => h('div', {},
              Number(r.list_price) > Number(r.unit_price)
                ? h('div', { class: 'muted small', style: { textDecoration: 'line-through' } },
                  money(r.list_price))
                : null,
              h('div', {}, money(r.unit_price))),
          },
          { key: 'discount_amount', label: t('discount'), type: 'money', render: (r) => money(r.discount_amount) },
          { key: 'tax_amount', label: t('tax'), type: 'money', render: (r) => money(r.tax_amount) },
          { key: 'line_total', label: t('total'), type: 'money', render: (r) => h('span', { class: 'strong' }, money(r.line_total)) },
        ],
        rows: sale.lines,
      }))),

    h('div', { class: 'grid cols-2', style: { marginTop: '14px' } },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('summary'))),
        h('div', { class: 'card-body' },
          h('div', { class: 'totals' },
            row(t('totalUnits'), number(sale.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0))),
            row(t('subtotal'), money(sale.subtotal)),
            row(t('discount'), `− ${money(sale.discount_amount)}`),
            row(t('tax'), money(sale.tax_amount)),
            row(t('total'), money(sale.total_amount), 'grand'),
            row(t('cost'), money(sale.total_cost)),
            row(t('profit'), money(sale.total_amount - sale.total_cost))))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('paid'))),
        h('div', { class: 'card-body tight' }, dataTable({
          columns: [
            { key: 'paid_at', label: t('date'), render: (r) => dateTime(r.paid_at) },
            { key: 'method', label: t('paymentMethod'), render: (r) => t(r.method, r.method) },
            { key: 'reference', label: t('reference'), render: (r) => r.reference || '—' },
            { key: 'amount', label: t('amount'), type: 'money', render: (r) => money(r.amount) },
          ],
          rows: sale.payments,
        })))),

    sale.returns?.length ? h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('returns'))),
      h('div', { class: 'card-body tight' }, dataTable({
        columns: [
          { key: 'return_no', label: t('document'), class: 'mono small' },
          { key: 'return_date', label: t('date'), render: (r) => dateTime(r.return_date) },
          { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
          { key: 'reason', label: t('reason') },
        ],
        rows: sale.returns,
      }))) : null,

    sale.status === 'void' ? h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-body' },
        h('div', { class: 'strong' }, t('void')),
        h('div', { class: 'muted small' }, `${dateTime(sale.voided_at)} — ${sale.void_reason || ''}`))) : null);

  return undefined;
}

const row = (label, value, cls = '') => h('div', { class: `line ${cls}` },
  h('span', {}, label), h('span', { class: 'mono' }, value));

function openVoid(sale) {
  const reason = textInput({ placeholder: t('voidReason') });
  const dialog = modal({
    title: `${t('voidSale')} — ${sale.invoice_no}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Stock will be returned, the promo code released and the customer balance reversed.'),
      field({ label: t('reason'), input: reason })),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn danger',
        onclick: async () => {
          try {
            await api.post(`/api/sales/${sale.id}/void`, { reason: reason.value });
            toast(t('saved'));
            dialog.close();
            window.location.reload();
          } catch (error) { toastError(error); }
        },
      }, t('voidSale')),
    ],
  });
}

function openCollect(sale) {
  const outstanding = sale.total_amount - sale.paid_amount;
  const form = buildForm([
    { name: 'amount', label: t('amount'), type: 'number', required: true, value: outstanding },
    {
      name: 'method',
      label: t('paymentMethod'),
      type: 'select',
      required: true,
      options: ['cash', 'card', 'transfer', 'wallet'].map((v) => ({ value: v, label: t(v) })),
    },
    { name: 'reference', label: t('reference'), span: 2 },
  ], { method: 'cash' }, { columns: 2 });

  const dialog = modal({
    title: `${t('collectPayment')} — ${sale.invoice_no}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${t('outstanding')}: ${money(outstanding)}`),
      form.node),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            await api.post(`/api/sales/${sale.id}/payment`, form.values());
            toast(t('saved'));
            dialog.close();
            window.location.reload();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

async function openShiftSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await api.get('/api/sales/shift-summary', { dateFrom: today, dateTo: today });
  modal({
    title: `${t('shiftSummary')} — ${date(today)}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'kpis' },
        kpi(t('invoice'), number(data.totals.invoices)),
        kpi(t('revenue'), money(data.totals.revenue)),
        kpi(t('discount'), money(data.totals.discounts))),
      dataTable({
        columns: [
          { key: 'method', label: t('paymentMethod'), render: (r) => t(r.method, r.method) },
          { key: 'invoices', label: t('invoice'), type: 'number' },
          { key: 'amount', label: t('amount'), type: 'money', render: (r) => money(r.amount) },
        ],
        rows: data.byMethod,
      })),
  });
}
