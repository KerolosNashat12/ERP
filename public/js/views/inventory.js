/** Stock on hand, the movement ledger and stock counts. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  checkboxInput, field, modal, debounce, tag, statusTag, buildForm,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, dateTime } from '../core/format.js';
import { can, lookup } from '../core/store.js';
import { navigate } from '../core/router.js';
import { variantPicker, lineNumber, requireLines } from './pickers.js';

// -------------------------------------------------------------- stock grid

export async function inventoryView(root, route) {
  const state = {
    search: '', brandId: '', categoryId: '',
    lowStockOnly: route.query.low === '1', zeroStock: 'all', page: 1, pageSize: 50,
  };
  const brands = await lookup('brands', '/api/brands/options');
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const summaryHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/inventory/stock', {
      ...state, lowStockOnly: state.lowStockOnly ? '1' : '',
    });
    mount(summaryHost,
      kpi(t('results'), number(data.total)),
      kpi(t('onHand'), number(data.totals.total_qty)),
      kpi(t('stockValue'), money(data.totals.total_value)));

    mount(listHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        {
          key: 'product',
          label: t('product'),
          render: (r) => h('div', {},
            h('div', { class: 'strong small' }, pick(r, 'product_name')),
            h('small', { class: 'muted' }, `${r.variant_label || ''} ${r.brand_name_en ? `· ${r.brand_name_en}` : ''}`)),
        },
        {
          key: 'quantity',
          label: t('onHand'),
          type: 'number',
          render: (r) => h('span', { class: 'strong' }, number(r.quantity)),
        },
        { key: 'reorder_level', label: t('reorderLevel'), type: 'number', render: (r) => number(r.reorder_level) },
        { key: 'average_cost', label: t('avgCost'), type: 'money', render: (r) => money(r.average_cost) },
        { key: 'stock_value', label: t('value'), type: 'money', render: (r) => money(r.stock_value) },
        {
          key: 'flag',
          label: '',
          render: (r) => {
            if (r.quantity <= 0) return tag(t('outOfStock'), 'danger');
            if (r.reorder_level > 0 && r.quantity <= r.reorder_level) return tag(t('lowStockItems'), 'warn');
            return tag('OK', 'ok');
          },
        },
        {
          key: '__a',
          label: '',
          width: '1%',
          render: (r) => h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
            can('inventory.adjust') ? h('button', {
              class: 'btn sm ghost', title: t('adjustStock'),
              onclick: () => openQuickAdjust(r, load),
            }, '⇅') : null,
            can('inventory.view') ? h('button', {
              class: 'btn sm ghost', title: t('movements'),
              onclick: () => navigate(`movements?variantId=${r.variant_id}`),
            }, '≡') : null),
        },
      ],
      rows: data.rows,
    }));
    mount(pagerHost, pager({
      page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); },
    }));
  }

  const searchBox = textInput({
    placeholder: t('search'),
    oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
  });

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('stockOnHand')), h('p', {}, t('stockSubtitle'))),
      h('span', { class: 'spacer' }),
      can('inventory.count') ? h('button', { class: 'btn', onclick: () => navigate('adjustments/new') }, t('newCount')) : null,
      can('reports.export') ? h('button', {
        class: 'btn primary',
        onclick: () => api.download('/api/reports/inventory_valuation', { format: 'csv' }, 'inventory.csv'),
      }, t('export')) : null),
    summaryHost,
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, searchBox),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('brand'), options: brands.map((b) => ({ value: b.id, label: pick(b, 'name') })),
          onchange: (e) => { state.brandId = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, selectInput({
          value: state.zeroStock,
          options: [
            { value: 'all', label: t('all') },
            { value: 'hide', label: t('hideZero') },
            { value: 'only', label: t('outOfStock') },
          ],
          onchange: (e) => { state.zeroStock = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, checkboxInput({
          label: t('lowStockOnly'), checked: state.lowStockOnly,
          onchange: (e) => { state.lowStockOnly = e.target.checked; state.page = 1; load(); },
        }))),
      listHost, pagerHost));

  await load();
}

function kpi(label, value) {
  return h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}

function openQuickAdjust(row, refresh) {
  const form = buildForm([
    { name: 'newQuantity', label: t('newQuantity'), type: 'number', required: true, value: row.quantity },
    {
      name: 'reason',
      label: t('reason'),
      type: 'select',
      required: true,
      options: ['correction', 'damage', 'loss', 'theft', 'expiry', 'other'].map((v) => ({ value: v, label: t(v) })),
    },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 2 },
  ], { reason: 'correction' }, { columns: 2 });

  const dialog = modal({
    title: `${t('adjustStock')} — ${row.sku}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${pick(row, 'product_name')} · ${row.variant_label || ''}`),
      h('div', { class: 'muted small' }, `${t('onHand')}: ${number(row.quantity)}`),
      form.node),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            await api.post('/api/inventory/quick-adjust', {
              ...form.values(), variantId: row.variant_id, warehouseId: row.warehouse_id,
            });
            toast(t('saved'));
            dialog.close();
            refresh();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

// ----------------------------------------------------------------- ledger

export async function movementsView(root, route) {
  const state = {
    variantId: route.query.variantId || '', movementType: '',
    dateFrom: '', dateTo: '', page: 1, pageSize: 50,
  };
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/inventory/movements', state);
    mount(listHost, dataTable({
      columns: [
        { key: 'created_at', label: t('date'), render: (r) => h('span', { class: 'small' }, dateTime(r.created_at)) },
        { key: 'reference_no', label: t('document'), class: 'mono small', render: (r) => r.reference_no || '—' },
        { key: 'movement_type', label: t('movementType'), render: (r) => tag(r.movement_type.replace(/_/g, ' '), r.quantity > 0 ? 'ok' : 'warn') },
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'product', label: t('product'), render: (r) => `${pick(r, 'product_name')} — ${r.variant_label || ''}` },
        { key: 'quantity', label: t('qty'), type: 'number', render: (r) => h('span', { class: r.quantity > 0 ? 'strong' : '' }, `${r.quantity > 0 ? '+' : ''}${number(r.quantity)}`) },
        { key: 'balance_after', label: t('balanceAfter'), type: 'number', render: (r) => number(r.balance_after) },
        { key: 'user_name', label: t('user'), render: (r) => h('span', { class: 'small muted' }, r.user_name || '—') },
      ],
      rows: data.rows,
    }));
    mount(pagerHost, pager({ page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); } }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('movements')), h('p', {}, t('movementsSubtitle'))),
      h('span', { class: 'spacer' }),
      can('reports.export') ? h('button', {
        class: 'btn',
        onclick: () => api.download('/api/reports/stock_movements', { format: 'csv', ...state }, 'movements.csv'),
      }, t('export')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field' }, selectInput({
          placeholder: t('movementType'),
          options: ['purchase_receipt', 'sale', 'sale_return', 'adjustment', 'opening_balance', 'write_off']
            .map((v) => ({ value: v, label: v.replace(/_/g, ' ') })),
          onchange: (e) => { state.movementType = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, field({ label: t('from'), input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateFrom = e.target.value; load(); } }) })),
        h('div', { class: 'field' }, field({ label: t('to'), input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateTo = e.target.value; load(); } }) }))),
      listHost, pagerHost));

  await load();
}

// -------------------------------------------------------------- stock count

export async function adjustmentsView(root, route) {
  if (route.segments[1]) return adjustmentFormView(root, route);

  const listHost = h('div', { class: 'card-body tight' }, spinner());
  async function load() {
    const data = await api.get('/api/inventory/adjustments', { pageSize: 50 });
    mount(listHost, dataTable({
      columns: [
        { key: 'adjustment_no', label: t('document'), class: 'mono small' },
        { key: 'created_at', label: t('date'), render: (r) => dateTime(r.created_at) },
        { key: 'reason', label: t('reason'), render: (r) => tag(t(camel(r.reason), r.reason)) },
        { key: 'line_count', label: t('products'), type: 'number' },
        { key: 'value_impact', label: t('value'), type: 'money', render: (r) => money(r.value_impact) },
        { key: 'status', label: t('status'), render: (r) => statusTag(r.status) },
        { key: 'created_by_name', label: t('user'), render: (r) => h('span', { class: 'small muted' }, r.created_by_name || '—') },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`adjustments/${row.id}`),
    }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('adjustments')), h('p', {}, t('countsSubtitle'))),
      h('span', { class: 'spacer' }),
      can('inventory.count') ? h('button', { class: 'btn primary', onclick: () => navigate('adjustments/new') }, '＋ ' + t('newCount')) : null),
    h('div', { class: 'card' }, listHost));
  await load();
  return undefined;
}

const camel = (v) => String(v).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

async function adjustmentFormView(root, route) {
  const id = route.segments[1] === 'new' ? null : Number(route.segments[1]);
  const existing = id ? await api.get(`/api/inventory/adjustments/${id}`) : null;
  const readOnly = existing && existing.status !== 'draft';
  let lines = existing ? existing.lines.map((l) => ({ ...l })) : [];

  const header = buildForm([
    {
      name: 'reason',
      label: t('reason'),
      type: 'select',
      required: true,
      disabled: readOnly,
      options: ['stock_take', 'damage', 'loss', 'theft', 'correction', 'expiry', 'other']
        .map((v) => ({ value: v, label: t(camel(v)) })),
    },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 2, disabled: readOnly },
  ], existing || { reason: 'stock_take' }, { columns: 2 });

  const linesHost = h('div');
  const picker = variantPicker({
    onPick: async (variant) => {
      if (lines.some((l) => l.variant_id === variant.variant_id)) return;
      const details = await api.get(`/api/products/variants/${variant.variant_id}`);
      const level = details.stock[0];
      lines.push({
        variant_id: variant.variant_id,
        sku: variant.sku,
        product_name_en: variant.product_name_en,
        product_name_ar: variant.product_name_ar,
        variant_label: variant.variant_label,
        system_qty: level?.quantity || 0,
        counted_qty: level?.quantity || 0,
        unit_cost: level?.average_cost || variant.cost_price || 0,
      });
      renderLines();
    },
  });

  function renderLines() {
    mount(linesHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'product', label: t('product'), render: (l) => `${pick(l, 'product_name')} — ${l.variant_label || ''}` },
        { key: 'system_qty', label: t('systemQty'), type: 'number', render: (l) => number(l.system_qty) },
        {
          key: 'counted_qty',
          label: t('countedQty'),
          align: 'end',
          render: (l) => (readOnly ? number(l.counted_qty) : lineNumber(l, 'counted_qty', renderLines)),
        },
        {
          key: 'difference',
          label: t('difference'),
          type: 'number',
          render: (l) => {
            const diff = Number(l.counted_qty) - Number(l.system_qty);
            return h('span', { class: diff === 0 ? 'muted' : 'strong' }, `${diff > 0 ? '+' : ''}${number(diff)}`);
          },
        },
        { key: 'unit_cost', label: t('unitCost'), type: 'money', render: (l) => money(l.unit_cost) },
        {
          key: 'impact',
          label: t('value'),
          type: 'money',
          render: (l) => money((Number(l.counted_qty) - Number(l.system_qty)) * Number(l.unit_cost)),
        },
        {
          key: '__x',
          label: '',
          render: (l, index) => (readOnly ? '' : h('button', {
            class: 'btn sm ghost', onclick: () => { lines.splice(index, 1); renderLines(); },
          }, '✕')),
        },
      ],
      rows: lines,
      emptyMessage: t('loadCountSheet'),
    }));
  }

  async function loadCountSheet() {
    const { rows } = await api.get('/api/inventory/count-sheet');
    lines = rows;
    renderLines();
    toast(`${rows.length} ${t('products')}`);
  }

  async function save(thenPost = false) {
    if (!header.validate() || !requireLines(lines)) return;
    try {
      const payload = {
        ...header.values(),
        lines: lines.map((l) => ({
          variant_id: l.variant_id,
          system_qty: Number(l.system_qty),
          counted_qty: Number(l.counted_qty),
          unit_cost: Number(l.unit_cost || 0),
        })),
      };
      const saved = id
        ? await api.put(`/api/inventory/adjustments/${id}`, payload)
        : await api.post('/api/inventory/adjustments', payload);
      if (thenPost) {
        await api.post(`/api/inventory/adjustments/${saved.id}/post`, {});
        toast(t('countPosted'));
      } else toast(t('saved'));
      navigate('adjustments');
    } catch (error) { toastError(error); }
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, existing ? existing.adjustment_no : t('newCount')),
        existing ? h('p', {}, statusTag(existing.status)) : null),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('adjustments') }, '‹ ' + t('back')),
      !readOnly ? h('button', { class: 'btn', onclick: loadCountSheet }, t('loadCountSheet')) : null,
      !readOnly ? h('button', { class: 'btn', onclick: () => save(false) }, t('save')) : null,
      !readOnly ? h('button', { class: 'btn primary', onclick: () => save(true) }, t('postCount')) : null),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, header.node)),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('products'))),
      readOnly ? null : h('div', { class: 'card-body' }, picker.node),
      linesHost));

  renderLines();
  return () => picker.destroy();
}
