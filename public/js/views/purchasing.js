/** Purchase orders: list, editor, goods receipt, supplier payments. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  numberInput, field, modal, debounce, statusTag, buildForm, confirmDialog, printNode, tag,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, date, isoDate } from '../core/format.js';
import { session, can, lookup } from '../core/store.js';
import { navigate } from '../core/router.js';
import { variantPicker, lineNumber, requireLines } from './pickers.js';

export async function purchasesView(root, route) {
  if (route.segments[1]) return purchaseFormView(root, route);

  const state = { search: '', status: '', supplierId: '', page: 1, pageSize: 25 };
  const suppliers = await lookup('suppliers', '/api/suppliers/options');
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/purchases', state);
    mount(listHost, dataTable({
      columns: [
        { key: 'po_number', label: t('poNumber'), class: 'mono small' },
        { key: 'order_date', label: t('orderDate'), render: (r) => date(r.order_date) },
        { key: 'supplier_name', label: t('supplier'), render: (r) => pick(r, 'supplier_name') },
        { key: 'line_count', label: t('products'), type: 'number' },
        { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
        {
          key: 'paid',
          label: t('paid'),
          type: 'money',
          render: (r) => h('span', { class: r.total_amount - r.paid_amount > 0.01 ? 'strong' : 'muted' },
            money(r.paid_amount)),
        },
        { key: 'status', label: t('status'), render: (r) => statusTag(r.status) },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`purchases/${row.id}`),
    }));
    mount(pagerHost, pager({ page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); } }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('purchases')), h('p', {}, t('navPurchasing'))),
      h('span', { class: 'spacer' }),
      can('purchases.create') ? h('button', { class: 'btn', onclick: openReorderSuggestions }, t('reorderSuggestions')) : null,
      can('purchases.create') ? h('button', { class: 'btn primary', onclick: () => navigate('purchases/new') }, '＋ ' + t('newPurchaseOrder')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, textInput({
          placeholder: t('search'),
          oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('status'),
          options: ['draft', 'ordered', 'partially_received', 'received', 'cancelled']
            .map((v) => ({ value: v, label: v.replace(/_/g, ' ') })),
          onchange: (e) => { state.status = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('supplier'),
          options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })),
          onchange: (e) => { state.supplierId = e.target.value; state.page = 1; load(); },
        }))),
      listHost, pagerHost));

  await load();
  return undefined;
}

async function openReorderSuggestions() {
  const { rows } = await api.get('/api/purchases/reorder-suggestions');
  const dialog = modal({
    title: t('reorderSuggestions'),
    size: 'wide',
    body: rows.length
      ? h('div', { class: 'stack' }, rows.map((group) => h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', {}, group.supplier_name),
          h('span', { class: 'spacer' }),
          group.supplier_id ? h('button', {
            class: 'btn sm primary',
            onclick: () => {
              sessionStorage.setItem('mm.reorder', JSON.stringify(group));
              dialog.close();
              navigate('purchases/new');
            },
          }, t('buildFromSuggestions')) : tag('No supplier assigned', 'warn')),
        h('div', { class: 'card-body tight' }, dataTable({
          columns: [
            { key: 'sku', label: t('sku'), class: 'mono small' },
            { key: 'product_name_en', label: t('product') },
            { key: 'on_hand', label: t('onHand'), type: 'number', render: (r) => number(r.on_hand) },
            { key: 'reorder_level', label: t('reorderLevel'), type: 'number', render: (r) => number(r.reorder_level) },
            { key: 'quantity_ordered', label: t('qty'), type: 'number', render: (r) => number(r.quantity_ordered) },
            { key: 'unit_cost', label: t('unitCost'), type: 'money', render: (r) => money(r.unit_cost) },
          ],
          rows: group.lines,
        })))))
      : h('div', { class: 'empty' }, t('allClear')),
  });
}

async function purchaseFormView(root, route) {
  const id = route.segments[1] === 'new' ? null : Number(route.segments[1]);
  const [suppliers, existing] = await Promise.all([
    lookup('suppliers', '/api/suppliers/options'),
    id ? api.get(`/api/purchases/${id}`) : Promise.resolve(null),
  ]);

  const editable = !existing || ['draft', 'ordered'].includes(existing.status);
  const lines = existing ? existing.lines.map((l) => ({ ...l })) : [];

  // Pre-fill from the reorder suggestion screen if one was queued.
  const queued = !id && sessionStorage.getItem('mm.reorder');
  let queuedSupplierId = null;
  if (queued) {
    const group = JSON.parse(queued);
    sessionStorage.removeItem('mm.reorder');
    queuedSupplierId = group.supplier_id;
    for (const line of group.lines) {
      lines.push({
        variant_id: line.variant_id, sku: line.sku, product_name_en: line.product_name_en,
        variant_label: line.variant_label, quantity_ordered: line.quantity_ordered,
        quantity_received: 0, unit_cost: line.unit_cost, discount_percent: 0, tax_rate: 14,
      });
    }
  }

  const header = buildForm([
    { name: 'supplier_id', label: t('supplier'), type: 'select', required: true, options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })), disabled: !editable },
    { name: 'order_date', label: t('orderDate'), type: 'date', required: true, disabled: !editable },
    { name: 'expected_date', label: t('expectedDate'), type: 'date', disabled: !editable },
    { name: 'discount_amount', label: t('discount'), type: 'number', disabled: !editable },
    { name: 'shipping_amount', label: t('shipping'), type: 'number', disabled: !editable },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 3, disabled: !editable },
  ], existing || {
    order_date: isoDate(), discount_amount: 0, shipping_amount: 0, supplier_id: queuedSupplierId,
  }, { columns: 3 });

  const linesHost = h('div');
  const totalsHost = h('div', { class: 'card-body' });

  const picker = variantPicker({
    onPick: (variant) => {
      const found = lines.find((l) => l.variant_id === variant.variant_id);
      if (found) found.quantity_ordered = Number(found.quantity_ordered) + 1;
      else {
        lines.push({
          variant_id: variant.variant_id, sku: variant.sku,
          product_name_en: variant.product_name_en, product_name_ar: variant.product_name_ar,
          variant_label: variant.variant_label,
          quantity_ordered: 1, quantity_received: 0,
          unit_cost: variant.cost_price || 0, discount_percent: 0, tax_rate: variant.tax_rate || 0,
        });
      }
      renderLines();
    },
  });

  function computeTotals() {
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const gross = Number(line.quantity_ordered) * Number(line.unit_cost);
      const net = gross - gross * (Number(line.discount_percent || 0) / 100);
      subtotal += net;
      tax += net * (Number(line.tax_rate || 0) / 100);
    }
    const values = header.values();
    const discount = Number(values.discount_amount || 0);
    const shipping = Number(values.shipping_amount || 0);
    return { subtotal, tax, discount, shipping, total: subtotal + tax + shipping - discount };
  }

  function renderTotals() {
    const totals = computeTotals();
    const line = (label, value, cls = '') => h('div', { class: `line ${cls}` }, h('span', {}, label), h('span', { class: 'mono' }, value));
    mount(totalsHost, h('div', { class: 'totals', style: { maxWidth: '320px', marginInlineStart: 'auto' } },
      line(t('subtotal'), money(totals.subtotal)),
      line(t('discount'), `− ${money(totals.discount)}`),
      line(t('shipping'), money(totals.shipping)),
      line(t('tax'), money(totals.tax)),
      line(t('total'), money(totals.total), 'grand'),
      existing ? line(t('paid'), money(existing.paid_amount)) : null,
      existing ? line(t('outstanding'), money(existing.total_amount - existing.paid_amount)) : null));
  }

  function renderLines() {
    mount(linesHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'product', label: t('product'), render: (l) => `${pick(l, 'product_name')} — ${l.variant_label || ''}` },
        { key: 'quantity_ordered', label: t('ordered'), align: 'end', render: (l) => (editable ? lineNumber(l, 'quantity_ordered', renderAll, '80px') : number(l.quantity_ordered)) },
        { key: 'quantity_received', label: t('received'), type: 'number', render: (l) => number(l.quantity_received || 0) },
        { key: 'unit_cost', label: t('unitCost'), align: 'end', render: (l) => (editable ? lineNumber(l, 'unit_cost', renderAll) : money(l.unit_cost)) },
        { key: 'discount_percent', label: '%', align: 'end', render: (l) => (editable ? lineNumber(l, 'discount_percent', renderAll, '64px') : `${l.discount_percent}%`) },
        { key: 'tax_rate', label: t('tax') + ' %', align: 'end', render: (l) => (editable ? lineNumber(l, 'tax_rate', renderAll, '64px') : `${l.tax_rate}%`) },
        {
          key: 'total',
          label: t('total'),
          type: 'money',
          render: (l) => {
            const gross = Number(l.quantity_ordered) * Number(l.unit_cost);
            const net = gross - gross * (Number(l.discount_percent || 0) / 100);
            return money(net + net * (Number(l.tax_rate || 0) / 100));
          },
        },
        {
          key: '__x',
          label: '',
          render: (l, index) => (editable ? h('button', {
            class: 'btn sm ghost',
            onclick: () => { lines.splice(index, 1); renderAll(); },
          }, '✕') : ''),
        },
      ],
      rows: lines,
      emptyMessage: t('addLine'),
    }));
  }

  const renderAll = () => { renderLines(); renderTotals(); };

  async function save(thenApprove = false) {
    if (!header.validate() || !requireLines(lines)) return;
    try {
      const payload = {
        ...header.values(),
        lines: lines.map((l) => ({
          variant_id: l.variant_id,
          quantity_ordered: Number(l.quantity_ordered),
          unit_cost: Number(l.unit_cost),
          discount_percent: Number(l.discount_percent || 0),
          tax_rate: Number(l.tax_rate || 0),
        })),
      };
      const saved = id
        ? await api.put(`/api/purchases/${id}`, payload)
        : await api.post('/api/purchases', payload);
      if (thenApprove) await api.post(`/api/purchases/${saved.id}/approve`, {});
      toast(t('saved'));
      navigate(`purchases/${saved.id}`);
      window.location.reload();
    } catch (error) { toastError(error); }
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, existing ? existing.po_number : t('newPurchaseOrder')),
        existing ? h('p', {}, statusTag(existing.status), ' ', existing.supplier_name) : null),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('purchases') }, '‹ ' + t('back')),
      existing ? h('button', { class: 'btn', onclick: () => printNode(purchaseDocument(existing)) }, '🖨 ' + t('print')) : null,
      editable && can('purchases.create', 'purchases.update') ? h('button', { class: 'btn', onclick: () => save(false) }, t('save')) : null,
      !existing && can('purchases.approve') ? h('button', { class: 'btn primary', onclick: () => save(true) }, t('sendToSupplier')) : null,
      existing?.status === 'draft' && can('purchases.approve') ? h('button', {
        class: 'btn primary',
        onclick: async () => { await api.post(`/api/purchases/${id}/approve`, {}); toast(t('saved')); window.location.reload(); },
      }, t('sendToSupplier')) : null,
      existing && ['ordered', 'partially_received'].includes(existing.status) && can('purchases.receive')
        ? h('button', { class: 'btn gold', onclick: () => openReceive(existing) }, t('receiveGoods')) : null,
      existing && can('purchases.update') ? h('button', { class: 'btn', onclick: () => openPayment(existing) }, t('registerPayment')) : null,
      existing?.status === 'draft' && can('purchases.delete') ? h('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
          await api.del(`/api/purchases/${id}`);
          toast(t('deleted'));
          navigate('purchases');
        },
      }, t('delete')) : null),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, header.node)),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('products'))),
      editable ? h('div', { class: 'card-body' }, picker.node) : null,
      linesHost,
      totalsHost));

  renderAll();
  return () => picker.destroy();
}

function openReceive(order) {
  const receipts = order.lines.map((line) => ({
    line_id: line.id,
    sku: line.sku,
    name: `${line.product_name_en} — ${line.variant_label || ''}`,
    ordered: line.quantity_ordered,
    already: line.quantity_received,
    outstanding: line.quantity_ordered - line.quantity_received,
    quantity: line.quantity_ordered - line.quantity_received,
  }));

  const host = h('div');
  const render = () => mount(host, dataTable({
    columns: [
      { key: 'sku', label: t('sku'), class: 'mono small' },
      { key: 'name', label: t('product') },
      { key: 'ordered', label: t('ordered'), type: 'number', render: (r) => number(r.ordered) },
      { key: 'already', label: t('received'), type: 'number', render: (r) => number(r.already) },
      { key: 'outstanding', label: t('outstandingQty'), type: 'number', render: (r) => number(r.outstanding) },
      {
        key: 'quantity',
        label: t('receiveQty'),
        align: 'end',
        render: (r) => numberInput({
          value: r.quantity, min: 0, max: r.outstanding, style: { width: '92px' },
          onchange: (e) => { r.quantity = Math.min(Number(e.target.value) || 0, r.outstanding); render(); },
        }),
      },
    ],
    rows: receipts,
  }));

  const notes = textInput({ placeholder: t('notes') });
  const dialog = modal({
    title: `${t('receiveGoods')} — ${order.po_number}`,
    size: 'wide',
    body: h('div', { class: 'stack' }, host, field({ label: t('notes'), input: notes })),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await api.post(`/api/purchases/${order.id}/receive`, {
              receipts: receipts.filter((r) => r.quantity > 0).map((r) => ({ line_id: r.line_id, quantity: r.quantity })),
              notes: notes.value || null,
            });
            toast(t('goodsReceived'));
            dialog.close();
            window.location.reload();
          } catch (error) { toastError(error); }
        },
      }, t('receiveGoods')),
    ],
  });
  render();
}

function openPayment(order) {
  const outstanding = order.total_amount - order.paid_amount;
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
  ], { method: 'transfer' }, { columns: 2 });

  const dialog = modal({
    title: `${t('registerPayment')} — ${order.po_number}`,
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
            await api.post(`/api/purchases/${order.id}/payment`, form.values());
            toast(t('saved'));
            dialog.close();
            window.location.reload();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

/** Printable purchase order to send to the supplier. */
export function purchaseDocument(order) {
  return h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', {},
        h('div', { class: 'doc-title' }, session.settings['company.name'] || 'M&M Accessories'),
        h('div', { class: 'doc-meta' }, session.settings['company.address'] || ''),
        h('div', { class: 'doc-meta' }, session.settings['company.phone'] || '')),
      h('div', { class: 'right' },
        h('h2', {}, t('newPurchaseOrder')),
        h('div', { class: 'doc-meta' }, order.po_number),
        h('div', { class: 'doc-meta' }, `${t('orderDate')}: ${date(order.order_date)}`),
        h('div', { class: 'doc-meta' }, order.expected_date ? `${t('expectedDate')}: ${date(order.expected_date)}` : ''))),
    h('div', { style: { marginTop: '14px' } },
      h('strong', {}, t('supplier')), h('br'),
      order.supplier_name, h('br'),
      order.supplier_phone || '', h('br'),
      order.supplier_address || ''),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '#'), h('th', {}, t('sku')), h('th', {}, t('product')),
        h('th', {}, t('qty')), h('th', {}, t('unitCost')), h('th', {}, t('total')))),
      h('tbody', {}, order.lines.map((line, index) => h('tr', {},
        h('td', {}, index + 1),
        h('td', { class: 'mono' }, line.sku),
        h('td', {}, `${line.product_name_en} — ${line.variant_label || ''}`),
        h('td', {}, number(line.quantity_ordered)),
        h('td', {}, money(line.unit_cost)),
        h('td', {}, money(line.line_total)))))),
    h('div', { class: 'doc-totals' },
      h('div', { class: 'line' }, h('span', {}, t('subtotal')), h('span', {}, money(order.subtotal))),
      h('div', { class: 'line' }, h('span', {}, t('discount')), h('span', {}, money(order.discount_amount))),
      h('div', { class: 'line' }, h('span', {}, t('shipping')), h('span', {}, money(order.shipping_amount))),
      h('div', { class: 'line' }, h('span', {}, t('tax')), h('span', {}, money(order.tax_amount))),
      h('div', { class: 'line grand' }, h('span', {}, t('total')), h('span', {}, money(order.total_amount)))),
    order.notes ? h('p', { class: 'small' }, order.notes) : null);
}
