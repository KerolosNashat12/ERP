/**
 * Returns.
 *
 * The flow mirrors what actually happens at the counter: the customer arrives
 * with a receipt (or without one), the cashier scans it, ticks the items coming
 * back, says what condition they are in and why, and chooses how the money goes
 * back. Everything else — stock, loyalty, store credit — is the system's job.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  numberInput, field, modal, debounce, tag, printNode,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money, number, date, dateTime } from '../core/format.js';
import { session, can } from '../core/store.js';
import { navigate } from '../core/router.js';
import { onScan } from '../core/scanner.js';

let policyCache = null;
const policy = async () => {
  if (!policyCache) policyCache = await api.get('/api/returns/policy');
  return policyCache;
};

const reasonLabel = (code, reasons) => {
  const found = (reasons || []).find((r) => r.code === code);
  if (!found) return code;
  return getLanguage() === 'ar' ? found.ar : found.en;
};

// ------------------------------------------------------------------- list

export async function returnsView(root, route) {
  if (route.segments[1] === 'new') return newReturnView(root);
  if (route.segments[1]) return returnDetailView(root, Number(route.segments[1]));

  const rules = await policy();
  const state = { search: '', reasonCode: '', refundMethod: '', dateFrom: '', dateTo: '', page: 1 };
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const summaryHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/returns', state);
    mount(summaryHost,
      kpi(t('returns'), number(data.total)),
      kpi(t('refunded'), money(data.summary.refunded)),
      kpi(t('restocked'), number(data.summary.restocked)),
      kpi(t('writtenOff'), number(data.summary.written_off)));

    mount(listHost, dataTable({
      columns: [
        { key: 'return_no', label: t('document'), class: 'mono small' },
        { key: 'return_date', label: t('date'), render: (r) => h('span', { class: 'small' }, dateTime(r.return_date)) },
        {
          key: 'invoice_no',
          label: t('invoice'),
          render: (r) => (r.invoice_no
            ? h('span', { class: 'mono small' }, r.invoice_no)
            : tag(t('noReceipt'), 'warn')),
        },
        { key: 'customer_name', label: t('customer'), render: (r) => r.customer_name || t('walkIn') },
        { key: 'reason_code', label: t('reason'), render: (r) => tag(reasonLabel(r.reason_code, rules.reasons)) },
        { key: 'total_qty', label: t('qty'), type: 'number', render: (r) => number(r.total_qty) },
        {
          key: 'condition',
          label: t('condition'),
          render: (r) => h('span', { class: 'row', style: { gap: '4px' } },
            r.items_restocked > 0 ? tag(`${number(r.items_restocked)} ${t('resellable')}`, 'ok') : null,
            r.items_written_off > 0 ? tag(`${number(r.items_written_off)} ${t('damaged')}`, 'danger') : null),
        },
        { key: 'total_amount', label: t('refunded'), type: 'money', render: (r) => h('span', { class: 'strong' }, money(r.total_amount)) },
        {
          key: 'refund_method',
          label: t('refundMethod'),
          render: (r) => (r.store_credit_code
            ? tag(r.store_credit_code, 'gold')
            : tag(t(camel(r.refund_method), r.refund_method))),
        },
        { key: 'created_by_name', label: t('user'), render: (r) => h('span', { class: 'small muted' }, r.created_by_name || '—') },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`returns/${row.id}`),
    }));
    mount(pagerHost, pager({
      page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); },
    }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('returns')),
        h('p', {}, `${t('returnWindow')}: ${rules.windowDays} ${t('days')}${rules.allowWithoutReceipt ? ` · ${t('noReceiptAllowed')}` : ''}`)),
      h('span', { class: 'spacer' }),
      can('reports.export') ? h('button', {
        class: 'btn',
        onclick: () => api.download('/api/reports/returns_report', { format: 'csv', ...state }, 'returns.csv'),
      }, t('export')) : null,
      can('sales.return') ? h('button', { class: 'btn primary', onclick: () => navigate('returns/new') }, '＋ ' + t('newReturn')) : null),
    summaryHost,
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, textInput({
          placeholder: `${t('search')} — ${t('document')}, ${t('invoice')}, ${t('customer')}`,
          oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('reason'),
          options: rules.reasons.map((r) => ({ value: r.code, label: getLanguage() === 'ar' ? r.ar : r.en })),
          onchange: (e) => { state.reasonCode = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('refundMethod'),
          options: ['cash', 'card', 'transfer', 'wallet', 'store_credit', 'account']
            .map((v) => ({ value: v, label: t(camel(v), v) })),
          onchange: (e) => { state.refundMethod = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, field({
          label: t('from'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateFrom = e.target.value; load(); } }),
        })),
        h('div', { class: 'field' }, field({
          label: t('to'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateTo = e.target.value; load(); } }),
        }))),
      listHost, pagerHost));

  await load();
  return undefined;
}

const camel = (v) => String(v).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const kpi = (label, value) => h('div', { class: 'kpi' },
  h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));

// -------------------------------------------------------------- new return

async function newReturnView(root) {
  const rules = await policy();

  const state = {
    mode: 'with_receipt',
    invoice: null,       // the looked-up sale + its returnable lines
    lines: [],           // what the cashier has ticked
    reasonCode: '',
    reasonNote: '',
    refundMethod: 'cash',
    restockingFee: 0,
  };

  const lookupHost = h('div');
  const linesHost = h('div');
  const settleHost = h('div', { class: 'card-body stack' });

  // --- receipt lookup ------------------------------------------------------

  const invoiceInput = textInput({
    placeholder: t('scanReceiptPrompt'),
    dataset: { scanTarget: 'true' },
    autocomplete: 'off',
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      findInvoice(invoiceInput.value);
    },
  });

  async function findInvoice(reference) {
    if (!reference?.trim()) return;
    try {
      const result = await api.get('/api/returns/lookup', { reference });
      state.invoice = result;
      state.lines = result.lines
        .filter((l) => l.returnable_quantity > 0)
        .map((l) => ({ ...l, quantity: 0, condition: 'resellable' }));
      if (!state.lines.length) toast(t('everythingReturned'), 'warn');
      if (result.outsideWindow) {
        toast(`${t('outsideWindow')} — ${result.ageDays} ${t('days')}`, 'warn', 6000);
      }
      invoiceInput.value = '';
      render();
    } catch (error) {
      toastError(error);
    }
  }

  // --- no-receipt item lookup ---------------------------------------------

  const itemInput = textInput({
    placeholder: t('scanPrompt'),
    dataset: { scanTarget: 'true' },
    autocomplete: 'off',
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addItemByCode(itemInput.value);
    },
  });

  async function addItemByCode(code) {
    if (!code?.trim()) return;
    try {
      const item = await api.get(`/api/returns/item/${encodeURIComponent(code)}`);
      const existing = state.lines.find((l) => l.variant_id === item.variant_id);
      if (existing) existing.quantity += 1;
      else state.lines.push({ ...item, quantity: 1, condition: 'resellable', returnable_quantity: Infinity });
      itemInput.value = '';
      render();
    } catch (error) { toastError(error); }
  }

  const unsubscribe = onScan((code) => {
    if (state.mode === 'with_receipt' && !state.invoice) findInvoice(code);
    else if (state.mode === 'no_receipt') addItemByCode(code);
    else addQuantityByScan(code);
  });

  /** Scanning an item while a receipt is open ticks that line. */
  function addQuantityByScan(code) {
    const line = state.lines.find((l) => l.sku === code || String(l.sku).toUpperCase() === String(code).toUpperCase());
    if (!line) { toast(`${t('notOnThisInvoice')}: ${code}`, 'warn'); return; }
    line.quantity = Math.min(line.quantity + 1, line.returnable_quantity);
    render();
  }

  // --- totals --------------------------------------------------------------

  function totals() {
    const gross = state.lines.reduce((s, l) => s + l.quantity * (l.refund_per_unit || 0), 0);
    const shopFault = ['defective', 'wrong_item', 'not_as_described', 'damaged_in_transit'].includes(state.reasonCode);
    const fee = shopFault ? 0 : Math.min(Number(state.restockingFee || 0), gross);
    return {
      gross: Math.round(gross * 100) / 100,
      fee: Math.round(fee * 100) / 100,
      refund: Math.round((gross - fee) * 100) / 100,
      units: state.lines.reduce((s, l) => s + Number(l.quantity || 0), 0),
      shopFault,
    };
  }

  // --- submit --------------------------------------------------------------

  async function submit() {
    const selected = state.lines.filter((l) => Number(l.quantity) > 0);
    if (!selected.length) { toast(t('selectItemsToReturn'), 'warn'); return; }
    if (rules.requireReason && !state.reasonCode) { toast(t('reasonRequired'), 'warn'); return; }

    try {
      const created = await api.post('/api/returns', {
        return_type: state.mode,
        sale_id: state.invoice?.sale?.id || null,
        invoice_no: state.invoice?.sale?.invoice_no || null,
        reason_code: state.reasonCode || 'other',
        reason_note: state.reasonNote || null,
        refund_method: state.mode === 'no_receipt' ? 'store_credit' : state.refundMethod,
        restocking_fee: totals().fee,
        lines: selected.map((l) => ({
          sale_line_id: l.sale_line_id || null,
          variant_id: l.variant_id,
          quantity: l.quantity,
          condition: l.condition,
        })),
      });
      toast(`${t('returnCreated')} — ${created.return_no}`);
      showCreditNote(created);
      navigate(`returns/${created.id}`);
    } catch (error) { toastError(error); }
  }

  // --- rendering -----------------------------------------------------------

  function renderLookup() {
    if (state.mode === 'no_receipt') {
      mount(lookupHost,
        h('div', { class: 'alert-item medium' },
          h('div', {},
            h('div', { class: 'strong small' }, t('noReceiptMode')),
            h('div', { class: 'muted small' }, t('noReceiptExplain')))),
        field({ label: `${t('search')} / ${t('barcode')}`, input: itemInput, hint: t('scanPrompt') }));
      return;
    }

    if (!state.invoice) {
      mount(lookupHost,
        field({
          label: t('invoiceLookup'),
          input: invoiceInput,
          hint: t('scanReceiptHint'),
        }),
        h('button', { class: 'btn primary', onclick: () => findInvoice(invoiceInput.value) }, t('findInvoice')));
      return;
    }

    const sale = state.invoice.sale;
    mount(lookupHost,
      h('div', { class: 'row between' },
        h('div', {},
          h('div', { class: 'strong' }, `${t('invoice')} ${sale.invoice_no}`),
          h('div', { class: 'muted small' },
            `${dateTime(sale.sale_date)} · ${sale.customer_name || t('walkIn')} · ${money(sale.total_amount)}`),
          sale.promotion_code ? h('div', { class: 'small' }, tag(`${t('promoCode')} ${sale.promotion_code}`, 'info')) : null),
        h('div', { class: 'row' },
          state.invoice.outsideWindow
            ? tag(`${t('outsideWindow')} (${state.invoice.ageDays} ${t('days')})`, 'danger')
            : tag(`${state.invoice.ageDays} ${t('daysOld')}`, 'ok'),
          h('button', {
            class: 'btn sm ghost',
            onclick: () => { state.invoice = null; state.lines = []; render(); },
          }, '✕ ' + t('changeInvoice')))),
      state.invoice.priorReturns?.length
        ? h('div', { class: 'muted small' }, `${t('priorReturns')}: ${state.invoice.priorReturns.map((r) => r.return_no).join(', ')}`)
        : null);
  }

  function renderLines() {
    if (!state.lines.length) {
      mount(linesHost, h('div', { class: 'empty' },
        state.mode === 'no_receipt' ? t('scanPrompt') : t('findInvoiceFirst')));
      return;
    }

    mount(linesHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        {
          key: 'item',
          label: t('product'),
          render: (l) => h('div', {},
            h('div', { class: 'strong small' }, l.description || `${pick(l, 'product_name')} — ${l.variant_label || ''}`),
            l.sold_quantity !== undefined
              ? h('small', { class: 'muted' }, `${t('sold')}: ${number(l.sold_quantity)} · ${t('alreadyReturned')}: ${number(l.returned_quantity)}`)
              : null),
        },
        {
          key: 'available',
          label: t('returnable'),
          type: 'number',
          render: (l) => (Number.isFinite(l.returnable_quantity) ? number(l.returnable_quantity) : '—'),
        },
        {
          key: 'quantity',
          label: t('returnQty'),
          align: 'end',
          render: (l) => h('div', { class: 'qty-box' },
            h('button', { onclick: () => { l.quantity = Math.max(0, l.quantity - 1); render(); } }, '−'),
            h('input', {
              value: l.quantity,
              onchange: (e) => {
                const wanted = Math.max(0, Number(e.target.value) || 0);
                l.quantity = Math.min(wanted, l.returnable_quantity);
                render();
              },
            }),
            h('button', {
              onclick: () => { l.quantity = Math.min(l.quantity + 1, l.returnable_quantity); render(); },
            }, '+')),
        },
        {
          key: 'condition',
          label: t('condition'),
          render: (l) => selectInput({
            value: l.condition,
            style: { minWidth: '150px' },
            options: [
              { value: 'resellable', label: t('resellableBack') },
              { value: 'damaged', label: t('damagedWriteOff') },
            ],
            onchange: (e) => { l.condition = e.target.value; render(); },
          }),
        },
        {
          key: 'refund_per_unit',
          label: t('refundPerUnit'),
          type: 'money',
          render: (l) => money(l.refund_per_unit),
        },
        {
          key: 'total',
          label: t('total'),
          type: 'money',
          render: (l) => h('span', { class: l.quantity ? 'strong' : 'muted' },
            money(l.quantity * l.refund_per_unit)),
        },
        ...(state.mode === 'no_receipt' ? [{
          key: '__x',
          label: '',
          render: (l, index) => h('button', {
            class: 'btn sm ghost',
            onclick: () => { state.lines.splice(index, 1); render(); },
          }, '✕'),
        }] : []),
      ],
      rows: state.lines,
      rowClass: (l) => (l.quantity > 0 ? '' : 'muted'),
    }));
  }

  function renderSettle() {
    const sums = totals();
    const line = (label, value, cls = '') => h('div', { class: `line ${cls}` },
      h('span', {}, label), h('span', { class: 'mono' }, value));

    const refundOptions = state.mode === 'no_receipt'
      ? [{ value: 'store_credit', label: t('storeCredit') }]
      : [
        { value: 'cash', label: t('cash') },
        { value: 'card', label: t('card') },
        { value: 'transfer', label: t('transfer') },
        { value: 'wallet', label: t('wallet') },
        { value: 'store_credit', label: t('storeCredit') },
        ...(state.invoice?.sale?.customer_id ? [{ value: 'account', label: t('creditToAccount') }] : []),
      ];

    mount(settleHost,
      field({
        label: t('reason') + (rules.requireReason ? ' *' : ''),
        input: selectInput({
          value: state.reasonCode,
          placeholder: '—',
          options: rules.reasons.map((r) => ({ value: r.code, label: getLanguage() === 'ar' ? r.ar : r.en })),
          onchange: (e) => { state.reasonCode = e.target.value; render(); },
        }),
      }),
      field({
        label: t('notes'),
        input: textInput({
          value: state.reasonNote,
          oninput: (e) => { state.reasonNote = e.target.value; },
        }),
      }),
      field({
        label: t('refundMethod'),
        input: selectInput({
          value: state.mode === 'no_receipt' ? 'store_credit' : state.refundMethod,
          options: refundOptions,
          disabled: state.mode === 'no_receipt',
          onchange: (e) => { state.refundMethod = e.target.value; render(); },
        }),
        hint: state.refundMethod === 'store_credit' || state.mode === 'no_receipt'
          ? t('storeCreditHint') : null,
      }),
      rules.restockingFeePercent > 0 || state.restockingFee > 0 || !sums.shopFault
        ? field({
          label: t('restockingFee'),
          input: numberInput({
            value: state.restockingFee,
            min: 0,
            disabled: sums.shopFault,
            oninput: (e) => { state.restockingFee = Number(e.target.value) || 0; render(); },
          }),
          hint: sums.shopFault ? t('noFeeShopFault') : t('restockingFeeHint'),
        })
        : null,

      h('div', { class: 'totals' },
        line(t('itemsReturning'), number(sums.units)),
        line(t('grossRefund'), money(sums.gross)),
        sums.fee ? line(t('restockingFee'), `− ${money(sums.fee)}`, 'discount') : null,
        line(t('refundTotal'), money(sums.refund), 'grand')),

      h('button', {
        class: 'btn gold lg block',
        disabled: sums.units <= 0,
        onclick: submit,
      }, `${t('processReturn')} · ${money(sums.refund)}`));
  }

  function render() {
    renderLookup();
    renderLines();
    renderSettle();
  }

  const modeSwitch = () => h('div', { class: 'row' },
    h('button', {
      class: `btn ${state.mode === 'with_receipt' ? 'primary' : ''}`,
      onclick: () => { state.mode = 'with_receipt'; state.lines = []; render(); },
    }, t('withReceipt')),
    rules.allowWithoutReceipt && can('sales.return_no_receipt') ? h('button', {
      class: `btn ${state.mode === 'no_receipt' ? 'primary' : ''}`,
      onclick: () => { state.mode = 'no_receipt'; state.invoice = null; state.lines = []; state.refundMethod = 'store_credit'; render(); },
    }, t('withoutReceipt')) : null);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('newReturn')), h('p', {}, t('returnsSubtitle'))),
      h('span', { class: 'spacer' }),
      modeSwitch(),
      h('button', { class: 'btn', onclick: () => navigate('returns') }, '‹ ' + t('back'))),

    h('div', { class: 'pos' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('step1FindItems'))),
          h('div', { class: 'card-body stack' }, lookupHost)),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('step2WhatComesBack'))),
          linesHost)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('step3Refund'))),
        settleHost)));

  render();
  setTimeout(() => invoiceInput.focus(), 60);
  return () => unsubscribe();
}

// ------------------------------------------------------------------ detail

async function returnDetailView(root, id) {
  const [record, rules] = await Promise.all([api.get(`/api/returns/${id}`), policy()]);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, `${t('returns')} ${record.return_no}`),
        h('p', {},
          dateTime(record.return_date), ' · ',
          record.invoice_no ? `${t('invoice')} ${record.invoice_no}` : t('noReceipt'),
          ' · ', record.created_by_name || '')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('returns') }, '‹ ' + t('back')),
      h('button', { class: 'btn primary', onclick: () => printNode(creditNote(record)) }, '🖨 ' + t('printCreditNote'))),

    h('div', { class: 'kpis' },
      kpi(t('refunded'), money(record.total_amount)),
      kpi(t('reason'), reasonLabel(record.reason_code, rules.reasons)),
      kpi(t('refundMethod'), record.store_credit_code || t(camel(record.refund_method), record.refund_method)),
      kpi(t('restocked'), number(record.items_restocked)),
      kpi(t('writtenOff'), number(record.items_written_off)),
      record.loyalty_reversed ? kpi(t('loyaltyReversed'), number(record.loyalty_reversed)) : null),

    record.store_credit_code ? h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-body row between' },
        h('div', {},
          h('div', { class: 'strong' }, t('storeCreditIssued')),
          h('div', { class: 'muted small' }, t('storeCreditHint'))),
        h('div', { class: 'mono', style: { fontSize: '22px', fontWeight: 700 } }, record.store_credit_code))) : null,

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('returnItems'))),
      h('div', { class: 'card-body tight' }, dataTable({
        columns: [
          { key: 'sku', label: t('sku'), class: 'mono small' },
          { key: 'description', label: t('product') },
          { key: 'quantity', label: t('qty'), type: 'number', render: (r) => number(r.quantity) },
          {
            key: 'condition',
            label: t('condition'),
            render: (r) => (r.condition === 'damaged'
              ? tag(t('damagedWriteOff'), 'danger')
              : tag(t('resellableBack'), 'ok')),
          },
          { key: 'unit_price', label: t('refundPerUnit'), type: 'money', render: (r) => money(r.unit_price) },
          { key: 'tax_amount', label: t('tax'), type: 'money', render: (r) => money(r.tax_amount) },
          { key: 'line_total', label: t('total'), type: 'money', render: (r) => h('span', { class: 'strong' }, money(r.line_total)) },
        ],
        rows: record.lines,
      }))),

    record.reason_note ? h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-body' },
        h('div', { class: 'strong small' }, t('notes')),
        h('div', { class: 'muted' }, record.reason_note))) : null);

  return undefined;
}

// ------------------------------------------------------------- credit note

export function creditNote(record) {
  const ar = getLanguage() === 'ar';
  return h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', {},
        h('div', { class: 'doc-title' },
          ar ? (session.settings['company.name_ar'] || t('appName')) : (session.settings['company.name'] || t('appName'))),
        h('div', { class: 'doc-meta' }, session.settings['company.address'] || ''),
        h('div', { class: 'doc-meta' }, session.settings['company.phone'] || '')),
      h('div', { class: 'right' },
        h('h2', {}, t('creditNote')),
        h('div', { class: 'doc-meta' }, record.return_no),
        h('div', { class: 'doc-meta' }, dateTime(record.return_date)),
        record.invoice_no ? h('div', { class: 'doc-meta' }, `${t('invoice')}: ${record.invoice_no}`) : null)),

    h('div', { style: { marginTop: '14px' } },
      h('strong', {}, t('customer')), ': ', record.customer_name || t('walkIn'), h('br'),
      h('strong', {}, t('reason')), ': ', record.reason_code,
      record.reason_note ? ` — ${record.reason_note}` : ''),

    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, t('sku')), h('th', {}, t('product')), h('th', {}, t('qty')),
        h('th', {}, t('condition')), h('th', {}, t('total')))),
      h('tbody', {}, record.lines.map((line) => h('tr', {},
        h('td', { class: 'mono' }, line.sku),
        h('td', {}, line.description),
        h('td', {}, number(line.quantity)),
        h('td', {}, line.condition === 'damaged' ? t('damaged') : t('resellable')),
        h('td', {}, money(line.line_total)))))),

    h('div', { class: 'doc-totals' },
      h('div', { class: 'line' }, h('span', {}, t('subtotal')), h('span', {}, money(record.subtotal))),
      h('div', { class: 'line' }, h('span', {}, t('tax')), h('span', {}, money(record.tax_amount))),
      record.restocking_fee
        ? h('div', { class: 'line' }, h('span', {}, t('restockingFee')), h('span', {}, `− ${money(record.restocking_fee)}`))
        : null,
      h('div', { class: 'line grand' }, h('span', {}, t('refundTotal')), h('span', {}, money(record.total_amount)))),

    record.store_credit_code
      ? h('p', { class: 'center', style: { marginTop: '18px', fontSize: '15px' } },
        h('strong', {}, `${t('storeCredit')}: `),
        h('span', { class: 'mono', style: { fontSize: '19px' } }, record.store_credit_code))
      : null,

    h('p', { class: 'small muted', style: { marginTop: '22px' } },
      `${t('signature')}: ______________________`));
}

function showCreditNote(record) {
  const dialog = modal({
    title: `${t('returnCreated')} — ${record.return_no}`,
    size: 'wide',
    body: h('div', {}, creditNote(record)),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('close')),
      h('button', { class: 'btn primary', onclick: () => printNode(creditNote(record)) }, '🖨 ' + t('printCreditNote')),
    ],
  });
}
