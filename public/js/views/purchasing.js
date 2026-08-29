/** Purchase orders: list, editor, goods receipt, supplier payments. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  numberInput, field, modal, debounce, statusTag, buildForm, printNode, tag,
  matchNote,
} from '../core/ui.js';
import { t, pick, tError } from '../core/i18n.js';
import { money, number, date, isoDate } from '../core/format.js';
import { session, can, lookup } from '../core/store.js';
import { navigate } from '../core/router.js';
import { variantPicker, lineNumber, requireLines } from './pickers.js';
// One photograph mechanism, one browser-side implementation of it: the cost
// and salary screens use the very same three helpers. See core/proof.js.
import { proofUrl, openProof, proofPicker } from '../core/proof.js';
import { confirmDelete } from './trash.js';

/**
 * What an order will not let you do, and why.
 *
 * The rule itself is the server's (`draft` or `ordered` may be edited, only a
 * `draft` may be deleted) and is enforced there. This is the sentence a person
 * reads instead of hunting for a button that was never drawn — the owner could
 * not find edit and delete at all, and a button that quietly is not there is
 * indistinguishable from a broken screen.
 */
const editRefusal = (order) => {
  if (['draft', 'ordered'].includes(order.status)) return null;
  if (order.status === 'cancelled') return t('cannotEditCancelled');
  return t('cannotEditReceived');
};

const deleteRefusal = (order) => {
  if (order.status === 'draft') {
    // A draft can have taken a deposit; the server refuses to delete it and
    // this says so before the click rather than after it.
    return Number(order.paid_amount) > 0 ? t('cannotDeletePaid') : null;
  }
  if (order.status === 'ordered') return t('cannotDeleteOrdered');
  if (order.status === 'cancelled') return t('cannotDeleteCancelled');
  return t('cannotDeleteReceived');
};

/**
 * An action button that explains itself when it cannot act.
 *
 * `disabled` would be honest and silent — a grey button tells nobody why. This
 * stays pressable and answers the question when pressed, which is the whole
 * point of the refusal text existing.
 */
function actionButton({ label, title, refusal, danger = false, onclick }) {
  if (refusal) {
    // Deliberately NOT `disabled` and NOT `aria-disabled`: both are promises
    // that the control does nothing, and this one does something — it answers
    // the question. It is greyed so it does not look like the live action, and
    // it carries the reason as its title for a hover and for a screen reader.
    return h('button', {
      class: 'btn sm ghost muted',
      type: 'button',
      title: refusal,
      dataset: { refused: 'true' },
      onclick: (event) => { event.stopPropagation(); toast(refusal, 'warn', 6000); },
    }, label);
  }
  return h('button', {
    class: `btn sm ${danger ? 'danger' : ''}`,
    type: 'button',
    title: title || label,
    onclick: (event) => { event.stopPropagation(); onclick(); },
  }, label);
}

/**
 * Every batch of goods that has gone back to a supplier.
 *
 * A list rather than a screen for making one: a return is made from the ORDER
 * it came in on, where the person has the order in front of them. This is the
 * record - what went back, on which order, worth how much, and whether anybody
 * has since undone it.
 */
export async function supplierReturnsView(root, route) {
  const listHost = h('div', { class: 'card-body tight' }, spinner());

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/purchase-returns', {});
    mount(listHost, dataTable({
      columns: [
        { key: 'return_no', label: t('returnNo'), class: 'mono small' },
        { key: 'return_date', label: t('date'), render: (r) => date(r.return_date) },
        { key: 'po_number', label: t('poNumber'), class: 'mono small' },
        { key: 'supplier', label: t('supplier'), render: (r) => pick(r, 'supplier_name') },
        {
          key: 'settlement',
          label: t('settlement'),
          render: (r) => tag(t({
            credit: 'settlementCredit', refund: 'settlementRefund', replace: 'settlementReplace',
          }[r.settlement] || 'settlementCredit')),
        },
        { key: 'line_count', label: t('products'), type: 'number' },
        { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
        {
          key: 'status',
          label: t('status'),
          render: (r) => (r.status === 'reversed'
            ? tag(t('reverseReturn'), 'warn')
            : statusTag('completed')),
        },
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (r) => (r.status === 'completed' && can('purchases.return')
            ? h('button', {
              class: 'btn sm ghost',
              onclick: () => undoReturn(r, load),
            }, t('reverseReturn'))
            : null),
        },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`purchases/${row.purchase_order_id}`),
      emptyMessage: t('noResults'),
    }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('supplierReturns')), h('p', {}, t('navPurchasing')))),
    h('div', { class: 'card' }, listHost));

  await load();
  return undefined;
}

/**
 * Undoing one. Asks for a reason and says it will put the stock back, because
 * that is what it does and a person pressing it should know before, not after.
 */
async function undoReturn(record, refresh) {
  const reason = textInput({ placeholder: t('reverseReturnReason') });
  const dialog = modal({
    title: `${t('reverseReturn')} — ${record.return_no}`,
    body: h('div', { class: 'stack' },
      h('p', {}, t('reverseReturnReason')),
      reason),
    footer: h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api.post(`/api/purchase-returns/${record.id}/reverse`, { reason: reason.value || null });
          toast(t('saved'));
          dialog.close();
          await refresh();
        } catch (error) { toastError(error); }
      },
    }, t('reverseReturn')),
  });
}

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
        {
          key: 'po_number',
          label: t('poNumber'),
          class: 'mono small',
          // "Have we ever ordered this?" is answered by the orders that have a
          // line for it, so a row says which line brought it back.
          render: (r) => h('div', {}, h('div', {}, r.po_number), matchNote(r)),
        },
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
        // The owner's complaint was that he could not find editing and
        // deleting at all: they existed only inside the editor, which is one
        // click past the list where he was looking for them. They live here
        // now, and where an order will not allow one, the button says why
        // rather than not being drawn.
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (r) => h('div', { class: 'row-actions' },
            can('purchases.update') ? actionButton({
              label: `✎ ${t('editOrder')}`,
              refusal: editRefusal(r),
              onclick: () => navigate(`purchases/${r.id}`),
            }) : null,
            can('purchases.delete') ? actionButton({
              label: `🗑 ${t('deleteOrder')}`,
              danger: true,
              refusal: deleteRefusal(r),
              onclick: () => removeOrder(r, load),
            }) : null),
        },
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
          placeholder: t('searchNameOrCode'),
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

/**
 * Delete an order, with the refusal in front of it.
 *
 * The local refusal above is a courtesy — it answers instantly, from the row
 * already on screen. The real answer comes from the bin's own preview, which
 * re-reads the order on the server and refuses on goods received or money
 * paid; that is the one that decides. Both say the same thing, and the second
 * one cannot be out of date.
 */
async function removeOrder(order, afterwards) {
  const refusal = deleteRefusal(order);
  if (refusal) { toast(refusal, 'warn', 6000); return; }
  await confirmDelete({
    entityType: 'purchase_order', entityId: order.id, onDone: afterwards,
  });
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

  /**
   * What rate to show for an order that was saved before the field was one.
   *
   * Its discount is an amount and its percent is zero, so the field would open
   * empty on an order that plainly has a discount — and saving it would then
   * silently drop that discount to nothing. The rate its own amount works out
   * to is the honest answer, and it is what the amount already was.
   */
  const openingDiscountPercent = (order) => {
    if (Number(order.discount_percent)) return order.discount_percent;
    const amount = Number(order.discount_amount || 0);
    const subtotal = Number(order.subtotal || 0);
    if (!amount || subtotal <= 0) return 0;
    return Math.round((amount / subtotal) * 10000) / 100;
  };

  const header = buildForm([
    { name: 'supplier_id', label: t('supplier'), type: 'select', required: true, options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })), disabled: !editable },
    { name: 'order_date', label: t('orderDate'), type: 'date', required: true, disabled: !editable },
    { name: 'expected_date', label: t('expectedDate'), type: 'date', disabled: !editable },
    /*
     * A rate OR a sum of money, because suppliers give both and the difference
     * is not cosmetic. "Five percent" typed as an amount has to be recomputed by
     * hand the moment a line changes; "five hundred off" typed as a rate became
     * 4.1666…% and came back as 499.99, which is how an order stopped matching
     * the supplier's own invoice. The picker says which one was meant, and the
     * server stores both so nothing downstream has to care.
     */
    {
      name: 'discount_type',
      label: t('discountKind'),
      type: 'select',
      options: [
        { value: 'percent', label: t('discountPercent') },
        { value: 'amount', label: t('discountValue') },
      ],
      disabled: !editable,
    },
    { name: 'discount_percent', label: t('discountPercent'), type: 'number', min: 0, max: 100, step: '0.01', disabled: !editable },
    { name: 'discount_amount', label: t('discountValue'), type: 'number', min: 0, step: '0.01', disabled: !editable },
    { name: 'shipping_amount', label: t('shipping'), type: 'number', disabled: !editable },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 3, disabled: !editable },
  ], existing ? {
    ...existing,
    discount_type: existing.discount_type || 'percent',
    discount_percent: openingDiscountPercent(existing),
    discount_amount: Number(existing.discount_amount || 0),
  } : {
    order_date: isoDate(),
    discount_type: 'percent',
    discount_percent: 0,
    discount_amount: 0,
    shipping_amount: 0,
    supplier_id: queuedSupplierId,
  }, { columns: 3 });

  /*
   * Only the field that is being used is shown. Two discount boxes on screen at
   * once is an invitation to fill in both, and then only one of them counts -
   * which is the kind of thing a shop discovers a month later, from a supplier.
   */
  function syncDiscountFields() {
    const kind = header.values().discount_type || 'percent';
    const show = (name, on) => {
      const entry = header.inputs.get(name);
      if (entry?.holder) entry.holder.style.display = on ? '' : 'none';
    };
    show('discount_percent', kind !== 'amount');
    show('discount_amount', kind === 'amount');
  }
  header.inputs.get('discount_type')?.input.addEventListener('change', () => {
    syncDiscountFields();
    renderTotals();
  });
  // The other two move the totals too, and neither did before this round.
  for (const name of ['discount_percent', 'discount_amount', 'shipping_amount']) {
    header.inputs.get(name)?.input.addEventListener('change', () => renderTotals());
  }
  syncDiscountFields();

  const linesHost = h('div');
  const totalsHost = h('div', { class: 'card-body' });
  const balanceHost = h('div');

  /**
   * What this order still owes, after payments AND after anything sent back.
   *
   * Drawn only when there is something to say - an untouched order does not
   * need a strip telling it so. The one case this exists for is the one the
   * owner asked about by name: an order paid in full and then partly returned,
   * where the supplier is the debtor. That reads as "المورد ليه عندنا" in
   * words, not as a total with a minus sign in front of it.
   */
  async function renderBalance() {
    if (!existing) return;
    try {
      const balance = await api.get(`/api/purchases/${existing.id}/balance`);
      if (!balance.returned_amount && !balance.owed_by_supplier) { mount(balanceHost); return; }
      const cell = (label, value, cls = '') => h('div', { class: `kpi ${cls}` },
        h('div', { class: 'label' }, label),
        h('div', { class: 'value' }, value));
      mount(balanceHost, h('div', { class: 'kpis summary-cards' },
        cell(t('total'), money(balance.total_amount)),
        cell(t('returnedToSupplier'), money(balance.returned_amount)),
        cell(t('orderTotalNet'), money(balance.net_amount)),
        cell(t('paid'), money(balance.paid_amount)),
        balance.owed_by_supplier
          ? cell(t('supplierOwesUs'), money(balance.owed_by_supplier), 'accent')
          : cell(t('weOweSupplier'), money(Math.max(balance.outstanding, 0)), 'accent')));
    } catch { mount(balanceHost); }
  }

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

  /** What one line comes to, with its own discount and its own tax. */
  function lineTotal(line) {
    const gross = Number(line.quantity_ordered) * Number(line.unit_cost);
    const net = gross - gross * (Number(line.discount_percent || 0) / 100);
    return net + net * (Number(line.tax_rate || 0) / 100);
  }

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
    const kind = values.discount_type || 'percent';
    const percent = Number(values.discount_percent || 0);
    // The same sum the server will do when this is saved, so the total on the
    // screen is the total that gets written and never a preview of a different
    // arithmetic.
    /*
     * The same arithmetic the server will do when this is saved - see
     * PurchaseService#computeTotals - so the total on the screen is the total
     * that gets written, whichever kind of discount was entered.
     */
    const discount = kind === 'amount'
      ? Math.min(Math.max(Number(values.discount_amount || 0), 0), subtotal)
      : subtotal * (percent / 100);
    const shipping = Number(values.shipping_amount || 0);
    return {
      subtotal,
      tax,
      discount,
      kind,
      percent: kind === 'amount' && subtotal > 0
        ? Math.round((discount / subtotal) * 10000) / 100
        : percent,
      shipping,
      total: subtotal + tax + shipping - discount,
      /*
       * How many PIECES this order is for, not how many rows it has. An order
       * is checked against what the supplier actually delivered by counting
       * bottles, and nobody should have to add the quantity column up by hand.
       */
      units: lines.reduce((sum, line) => sum + Number(line.quantity_ordered || 0), 0),
    };
  }

  function renderTotals() {
    const totals = computeTotals();
    const line = (label, value, cls = '') => h('div', { class: `line ${cls}` }, h('span', {}, label), h('span', { class: 'mono' }, value));
    mount(totalsHost, h('div', { class: 'totals', style: { maxWidth: '320px', marginInlineStart: 'auto' } },
      line(t('totalUnits'), number(totals.units)),
      line(t('subtotal'), money(totals.subtotal)),
      // Both halves, because the rate is what was agreed and the amount is what
      // will be paid, and an order is checked against a supplier's invoice on
      // the second one.
      line(totals.percent ? `${t('discount')} ${number(totals.percent)}%` : t('discount'),
        `− ${money(totals.discount)}`),
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
        { key: 'quantity_ordered', label: t('ordered'), align: 'end', render: (l) => (editable ? lineNumber(l, 'quantity_ordered', afterLineEdit, '80px') : number(l.quantity_ordered)) },
        { key: 'quantity_received', label: t('received'), type: 'number', render: (l) => number(l.quantity_received || 0) },
        { key: 'unit_cost', label: t('unitCost'), align: 'end', render: (l) => (editable ? lineNumber(l, 'unit_cost', afterLineEdit) : money(l.unit_cost)) },
        { key: 'discount_percent', label: '%', align: 'end', render: (l) => (editable ? lineNumber(l, 'discount_percent', afterLineEdit, '64px') : `${l.discount_percent}%`) },
        { key: 'tax_rate', label: t('tax') + ' %', align: 'end', render: (l) => (editable ? lineNumber(l, 'tax_rate', afterLineEdit, '64px') : `${l.tax_rate}%`) },
        {
          key: 'total',
          label: t('total'),
          type: 'money',
          render: (l) => money(lineTotal(l)),
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

  /*
   * Editing a quantity or a cost re-prices that row and the totals - but it
   * must NOT rebuild the table, because the box being typed into lives inside
   * it. Replacing it mid-edit throws the caret away, and when the rebuild lands
   * during a blur the browser refuses outright: "the node to be removed is no
   * longer a child of this node". So the row's own total is patched in place
   * and only the totals block is redrawn. Adding or deleting a line still goes
   * through renderAll - there the table genuinely changed shape.
   */
  const LINE_TOTAL_CELL = 7;
  function afterLineEdit() {
    const rows = linesHost.querySelectorAll('tbody tr');
    lines.forEach((line, index) => {
      const cell = rows[index] && rows[index].cells[LINE_TOTAL_CELL];
      if (cell) cell.textContent = money(lineTotal(line));
    });
    renderTotals();
  }

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
      existing && can('purchases.pay') && existing.status !== 'cancelled'
        ? h('button', { class: 'btn', onclick: () => openPayment(existing) }, t('registerPayment')) : null,
      /*
       * Sending goods back lives HERE, on the order they came in on, because
       * that is the only place a person has the two facts the screen needs: the
       * order, and the faulty bottle in their hand.
       */
      existing && can('purchases.return')
        && ['partially_received', 'received'].includes(existing.status)
        ? h('button', { class: 'btn', onclick: () => openSupplierReturn(existing) }, '↩ ' + t('returnToSupplier'))
        : null,
      /*
       * Its own button AND its own screen. It began as one dialog with a
       * settlement chooser, which failed twice over: the owner looked for the
       * word «استبدال» three times and never found it, and once it was findable
       * the chooser was still sitting on the plain return screen offering to
       * turn it into something else. Two doors into two rooms — the return
       * screen asks what is going back, the swap screen asks what is going back
       * AND what is coming in, and neither asks the person to classify what
       * they are doing before they can do it.
       */
      existing && can('purchases.return')
        && ['partially_received', 'received'].includes(existing.status)
        ? h('button', {
          class: 'btn',
          onclick: () => openSupplierReturn(existing, { swap: true }),
        }, '⇄ ' + t('swapWithSupplier'))
        : null,
      // Present whatever the status is, and saying why when it cannot act —
      // a delete button that is simply absent is what sent the owner looking.
      existing && can('purchases.delete') ? actionButton({
        label: `🗑 ${t('deleteOrder')}`,
        danger: true,
        refusal: deleteRefusal(existing),
        onclick: () => removeOrder(existing, async () => navigate('purchases')),
      }) : null),
    existing ? balanceHost : null,
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, header.node)),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('products'))),
      editable ? h('div', { class: 'card-body' }, picker.node) : null,
      linesHost,
      totalsHost),
    // "How to see it after upload" — the half of the request most likely to be
    // skipped. Every payment on this order, with the receipt attached to it.
    existing ? paymentsCard(existing) : null);

  renderAll();
  renderBalance();
  return () => picker.destroy();
}

/**
 * Choose the item a supplier is sending instead.
 *
 * Its own cost comes with it, seeded from what the shop last paid for it and
 * editable, because the supplier's paperwork is what decides an uneven swap and
 * the shop's own cost is only ever a good guess at it.
 */
function pickReplacement(line, refresh) {
  const costBox = numberInput({ value: 0, min: 0, step: '0.01', style: { width: '120px' } });
  const chosen = h('div', { class: 'muted small' }, t('nothingPicked'));
  let variant = null;

  const picker = variantPicker({
    placeholder: t('scanPrompt'),
    onPick: (row) => {
      variant = row;
      costBox.value = Number(row.cost_price || 0);
      mount(chosen, h('span', { class: 'strong' }, `${pick(row, 'product_name')} — ${row.sku}`));
    },
  });

  const dialog = modal({
    title: t('replacementItem'),
    body: h('div', { class: 'stack' },
      picker.node,
      chosen,
      field({ label: t('unitCost'), input: costBox, hint: t('replacementCostHint') })),
    onClose: () => picker.destroy(),
    footer: h('button', {
      class: 'btn primary',
      onclick: () => {
        if (!variant) { toast(t('nothingPicked'), 'warn'); return; }
        line.swap = variant;
        line.swapCost = Number(costBox.value) || 0;
        // A different item with no quantity is a mistake the server refuses;
        // defaulting it to what is going back means the screen never sets that
        // trap in the first place.
        if (!line.replacement) line.replacement = line.quantity;
        dialog.close();
        refresh();
      },
    }, t('save')),
  });
}

/**
 * Goods going back to the supplier, from the order they arrived on.
 *
 * Three things a person has to see per line before they can honestly type a
 * number: how many came in, how many have already gone back, and how many are
 * ACTUALLY on the shelf. The third is the one that stops the mistake - a line
 * can be returnable on paper and impossible in fact, because the pieces were
 * sold last week - so the box is capped at it and the row says so.
 */
function openSupplierReturn(order, { swap = false } = {}) {
  /*
   * Two screens, one function — and `swap` is not a setting the person can
   * change, it is which button they pressed.
   *
   * Underneath, a swap IS a return: goods out and goods in, one document, one
   * transaction, so there is no second implementation here. What there is no
   * longer is a «التسوية» chooser sitting on the return screen, because once
   * the swap had a button of its own that chooser was offering to turn a return
   * into a different kind of document AFTER somebody had already said which one
   * they wanted. A screen that asks you to re-declare what you came to do is a
   * screen that will be got wrong.
   *
   * The consequence, said out loud: a return is always recorded as a CREDIT
   * against the order — what went back comes off what the shop owes, and when
   * the order is already paid it becomes money the supplier owes the shop (see
   * PurchaseReturnService.balance). "The supplier wired the money back" is not
   * a thing this screen records any more; it never changed a single figure,
   * because the balance counts every completed return whatever it is labelled.
   */
  const settlement = swap ? 'replace' : 'credit';
  const state = { settlement, reason: '', lines: [] };
  const host = h('div');
  const totalHost = h('div', { class: 'muted small' });

  const cap = (line) => Math.min(line.returnable_quantity, line.on_hand);

  function renderTotal() {
    const total = state.lines.reduce((sum, line) => sum + line.quantity * line.unit_credit, 0);
    // Valued at what is actually coming back, which on an uneven swap is not
    // what went out.
    const back = state.lines.reduce(
      (sum, line) => sum + line.replacement * (line.swap ? line.swapCost : line.unit_credit), 0,
    );
    mount(totalHost,
      `${t('total')}: ${money(total)}`,
      swap ? ` · ${t('replacementQty')}: ${money(back)}` : '');
  }

  function render() {
    mount(host, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'name', label: t('product'), render: (r) => `${r.product_name_en || ''} ${r.variant_label || ''}` },
        { key: 'quantity_received', label: t('received'), type: 'number', render: (r) => number(r.quantity_received) },
        { key: 'returned_quantity', label: t('alreadyReturned'), type: 'number', render: (r) => number(r.returned_quantity) },
        // The fact that stops the mistake.
        {
          key: 'on_hand',
          label: t('onShelf'),
          type: 'number',
          render: (r) => h('span', { class: r.on_hand < r.returnable_quantity ? 'strong' : 'muted' }, number(r.on_hand)),
        },
        {
          key: 'quantity',
          label: t('sendBack'),
          align: 'end',
          render: (r) => numberInput({
            value: r.quantity,
            min: 0,
            max: cap(r),
            step: 'any',
            style: { width: '86px' },
            onchange: (event) => {
              const asked = Number(event.target.value) || 0;
              r.quantity = Math.max(0, Math.min(asked, cap(r)));
              if (r.replacement > r.quantity) r.replacement = r.quantity;
              event.target.value = r.quantity;
              render();
            },
          }),
        },
        ...(swap ? [{
          key: 'replacement',
          label: t('replacementQty'),
          align: 'end',
          render: (r) => numberInput({
            value: r.replacement,
            min: 0,
            max: r.quantity,
            step: 'any',
            style: { width: '86px' },
            onchange: (event) => {
              r.replacement = Math.max(0, Math.min(Number(event.target.value) || 0, r.quantity));
              event.target.value = r.replacement;
              renderTotal();
            },
          }),
        }, {
          /*
           * WHAT is coming back. Blank means the same item, which is the common
           * case - a supplier replacing a faulty bottle with the same bottle.
           * The owner's case is the other one: the supplier cannot send that
           * item and sends a different one against the same credit, at ITS cost,
           * so an uneven swap leaves the difference owing rather than pretending
           * the two were worth the same.
           */
          key: 'swap',
          label: t('replacementItem'),
          render: (r) => (r.swap
            ? h('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
              h('span', { class: 'mono small' }, r.swap.sku),
              h('span', { class: 'muted small' }, money(r.swapCost)),
              h('button', {
                class: 'btn sm ghost',
                title: t('sameItem'),
                onclick: () => { r.swap = null; r.swapCost = 0; render(); },
              }, '✕'))
            : h('button', {
              class: 'btn sm ghost',
              onclick: () => pickReplacement(r, render),
            }, t('chooseAnotherItem'))),
        }] : []),
        {
          key: 'value',
          label: t('value'),
          type: 'money',
          render: (r) => money(r.quantity * r.unit_credit),
        },
      ],
      rows: state.lines,
      emptyMessage: t('nothingReturnable'),
    }));
    renderTotal();
  }

  const reason = textInput({
    placeholder: t('reason'),
    oninput: (event) => { state.reason = event.target.value; },
  });

  const dialog = modal({
    title: `${swap ? t('swapWithSupplier') : t('returnToSupplier')} — ${order.po_number}`,
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, field({ label: t('reason'), input: reason }))),
      host,
      totalHost),
    footer: h('button', {
      class: 'btn primary',
      onclick: async () => {
        const picked = state.lines
          .filter((line) => line.quantity > 0)
          .map((line) => ({
            po_line_id: line.id,
            quantity: line.quantity,
            replacement_quantity: swap ? line.replacement : 0,
            replacement_variant_id: swap && line.swap ? line.swap.variant_id : null,
            replacement_unit_cost: swap && line.swap ? line.swapCost : null,
          }));
        if (!picked.length) { toast(t('errPrNothingPicked'), 'warn'); return; }
        try {
          await api.post('/api/purchase-returns', {
            purchase_order_id: order.id,
            settlement,
            reason: state.reason || null,
            lines: picked,
          });
          toast(t('saved'));
          dialog.close();
          window.location.reload();
        } catch (error) { toastError(error); }
      },
    }, swap ? t('swapWithSupplier') : t('sendBack')),
  });

  mount(host, spinner());
  api.get(`/api/purchases/${order.id}/returnable`).then((data) => {
    state.lines = data.lines
      .filter((line) => line.returnable_quantity > 0)
      .map((line) => ({
        ...line, quantity: 0, replacement: 0, swap: null, swapCost: 0,
      }));
    render();
  }).catch((error) => {
    toastError(error);
    mount(host, h('div', { class: 'empty' }, tError(error)));
  });
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

// ------------------------------------------------------- payments and proof

/**
 * Every payment on this order — the owner asked for this in the same breath as
 * the upload: *"and how to see it after upload."*
 *
 * The thumbnail column points at `?size=thumb`, which is the ~20 KB preview the
 * browser made when the photograph was taken. Ten payments cost ten of those,
 * not ten phone photographs; the readable one is only fetched when somebody
 * clicks. A reversed payment is still here, struck through and greyed, with who
 * reversed it and why — the total already excludes it.
 */
function paymentsCard(order) {
  const body = h('div', { class: 'card-body tight' }, spinner());
  const summary = h('div', { class: 'muted small' });

  const card = h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-head' },
      h('h3', {}, t('paymentsOnThisOrder')),
      h('span', { class: 'spacer' }),
      summary,
      can('purchases.pay') && order.status !== 'cancelled'
        ? h('button', {
          class: 'btn sm primary',
          onclick: () => openPayment(order),
        }, `＋ ${t('registerPayment')}`)
        : null),
    body);

  async function load() {
    try {
      const data = await api.get(`/api/purchases/${order.id}/payments`);
      mount(summary, `${t('paid')}: ${money(data.paid_amount)} · ${t('outstanding')}: ${money(data.outstanding)}`);
      mount(body, dataTable({
        columns: [
          {
            key: 'paid_on',
            label: t('paymentDate'),
            render: (p) => h('div', {},
              h('div', {}, date(p.paid_on)),
              p.status === 'reversed' ? tag(t('reversedPayment'), 'danger') : null),
          },
          {
            key: 'amount',
            label: t('amount'),
            type: 'money',
            class: 'amount',
            render: (p) => money(p.amount),
          },
          { key: 'method', label: t('paymentMethod'), render: (p) => t(p.method === 'unknown' ? 'unknownMethod' : p.method, p.method) },
          { key: 'reference', label: t('paymentReference'), class: 'mono small' },
          {
            key: 'note',
            label: t('paymentNote'),
            render: (p) => h('div', {},
              h('div', {}, p.note || '—'),
              p.status === 'reversed'
                ? h('small', { class: 'muted' },
                  `${t('reversedBy')}: ${p.reversed_by_name || '—'} — ${p.reversal_reason || ''}`)
                : null),
          },
          { key: 'created_by_name', label: t('recordedBy') },
          {
            key: 'proof',
            label: t('proof'),
            render: (p) => (p.attachments.length
              ? h('div', { class: 'row-actions' }, p.attachments.map((attachment) => h('img', {
                class: 'proof-thumb',
                loading: 'lazy',
                // The preview, never the readable photograph. See AttachmentService.
                src: proofUrl(attachment.id, 'thumb'),
                alt: t('proofOfPayment'),
                title: t('openFullSize'),
                onclick: () => openProof(attachment, `${order.po_number} — ${money(p.amount)}`),
              })))
              : h('span', { class: 'muted' }, '—')),
          },
          {
            key: '__actions',
            label: t('actions'),
            class: 'nowrap',
            render: (p) => (can('purchases.reverse_payment') && p.status === 'recorded'
              ? h('div', { class: 'row-actions' }, h('button', {
                class: 'btn sm ghost',
                title: t('reversePayment'),
                onclick: () => openReversal(order, p),
              }, '↺'))
              : ''),
          },
        ],
        rows: data.rows,
        rowClass: (p) => (p.status === 'reversed' ? 'payment-reversed' : ''),
        emptyMessage: t('noPaymentsYet'),
      }));
    } catch (error) {
      toastError(error);
      mount(body, h('div', { class: 'empty' }, t('noPaymentsYet')));
    }
  }

  load();
  return card;
}

function openReversal(order, payment) {
  const reason = textInput({ placeholder: t('mistypedAmount') });
  const dialog = modal({
    title: `${t('reversePayment')} — ${money(payment.amount)}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, t('reversalReasonHint')),
      field({ label: t('reversalReason'), input: reason })),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!reason.value.trim()) { toast(t('reversalReason'), 'warn'); return; }
          try {
            await api.post(`/api/purchases/${order.id}/payments/${payment.id}/reverse`,
              { reason: reason.value.trim() });
            toast(t('paymentReversed'));
            dialog.close();
            window.location.reload();
          } catch (error) { toastError(error); }
        },
      }, t('reversePayment')),
    ],
  });
}

function openPayment(order) {
  const outstanding = Math.round((order.total_amount - order.paid_amount) * 100) / 100;
  const form = buildForm([
    { name: 'amount', label: t('amount'), type: 'number', required: true, value: outstanding },
    { name: 'paidOn', label: t('paidOnDate'), type: 'date', required: true },
    {
      name: 'method',
      label: t('paymentMethod'),
      type: 'select',
      required: true,
      options: ['cash', 'card', 'transfer', 'wallet', 'cheque'].map((v) => ({ value: v, label: t(v) })),
    },
    { name: 'reference', label: t('paymentReference') },
    { name: 'note', label: t('paymentNote'), span: 2 },
  ], { method: 'transfer', paidOn: isoDate() }, { columns: 2 });

  const proof = proofPicker();

  const dialog = modal({
    title: `${t('registerPayment')} — ${order.po_number}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${t('outstanding')}: ${money(outstanding)}`),
      form.node,
      field({ label: t('proofOfPayment'), input: proof.node })),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          // A photograph still being compressed is a photograph that would be
          // left behind by a save that went now.
          if (proof.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
          const values = form.values();
          try {
            await api.post(`/api/purchases/${order.id}/payments`, {
              // The amount is sent as typed and rounded by the server; nothing
              // the browser calculated is trusted as a total.
              amount: Number(values.amount),
              method: values.method,
              reference: values.reference || null,
              note: values.note || null,
              paidOn: values.paidOn || null,
              photo: proof.value(),
            });
            toast(t('paymentRecorded'));
            dialog.close();
            // The whole screen, not just the list: the order's totals, its
            // status tag and the outstanding figure all moved with this.
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
        h('div', { class: 'doc-title' }, session.settings['company.name'] || t('appName')),
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
      h('div', { class: 'line' }, h('span', {}, t('totalUnits')),
        h('span', {}, number(order.lines.reduce((sum, line) => sum + Number(line.quantity_ordered || 0), 0)))),
      h('div', { class: 'line' }, h('span', {}, t('subtotal')), h('span', {}, money(order.subtotal))),
      h('div', { class: 'line' },
        h('span', {}, order.discount_percent
          ? `${t('discount')} ${number(order.discount_percent)}%` : t('discount')),
        h('span', {}, money(order.discount_amount))),
      h('div', { class: 'line' }, h('span', {}, t('shipping')), h('span', {}, money(order.shipping_amount))),
      h('div', { class: 'line' }, h('span', {}, t('tax')), h('span', {}, money(order.tax_amount))),
      h('div', { class: 'line grand' }, h('span', {}, t('total')), h('span', {}, money(order.total_amount)))),
    order.notes ? h('p', { class: 'small' }, order.notes) : null);
}
