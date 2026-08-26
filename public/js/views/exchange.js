/**
 * الاستبدال — the customer brings something back and takes something else.
 *
 * ── The screen, in the order the counter works ──────────────────────────────
 * Find the invoice. Tick what is coming back. Pick what is going out. Read the
 * difference. Take the money, or hand it over. Four steps, in that order,
 * because that is the order the conversation actually happens in — and the
 * difference is on screen from the moment there is anything to compute it
 * from, rather than appearing at the end as a surprise.
 *
 * ── What this screen does NOT decide ────────────────────────────────────────
 * Any of the money. The credit, the replacement's price and the difference are
 * all computed by the server, which is the same server that prices the till and
 * the website; the figures below are shown as they are typed so the cashier can
 * read them out, but the exchange is committed by one request that recomputes
 * every one of them. A screen that has been open since this morning is not
 * allowed an opinion about today's prices.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, toast, toastError, tag, textInput, selectInput, field,
  confirmDialog,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, dateTime } from '../core/format.js';
import { can } from '../core/store.js';
import { navigate } from '../core/router.js';
import { variantPicker } from './pickers.js';

/**
 * One entry point for `#/exchanges`, `#/exchanges/new` and `#/exchanges/:id` —
 * the same shape `returnsView` uses next door, so the two screens are routed
 * the same way and neither is a special case.
 */
export default async function exchangesRouter(root, route) {
  const second = route.segments?.[1];
  if (second === 'new') return newExchangeView(root);
  if (second) return exchangeDetailsView(root, Number(second));
  return exchangesListView(root);
}

async function newExchangeView(root) {

  const state = {
    invoice: null,
    back: [],        // lines from the original invoice, with how many are coming back
    out: [],         // what the customer is taking instead
    settlement: 'cash',
    reason: 'wrong_item',
    notes: '',
  };

  const lookupHost = h('div');

  /*
   * Built once, not per render: the picker owns a text box the cashier types
   * and scans into, and rebuilding it on every keystroke would take the focus
   * away mid-word.
   */
  const picker = variantPicker({
    onPick: (variant) => {
      const existing = state.out.find((line) => line.variant_id === variant.variant_id);
      if (existing) existing.quantity += 1;
      else {
        state.out.push({
          variant_id: variant.variant_id,
          sku: variant.sku,
          name: pick(variant, 'product_name'),
          // Shown, never sent: the server prices the replacement itself.
          unit_price: variant.selling_price,
          quantity: 1,
        });
      }
      renderOut();
      renderSettlement();
    },
  });
  const backHost = h('div');
  const outHost = h('div');
  const settleHost = h('div', { class: 'card-body stack' });

  const invoiceInput = textInput({
    placeholder: t('scanReceiptPrompt'),
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
      // Only what is still returnable: a line already sent back cannot be part
      // of an exchange either, and showing it with a zero beside it invites the
      // cashier to try.
      state.back = result.lines
        .filter((line) => line.returnable_quantity > 0)
        .map((line) => ({ ...line, quantity: 0, condition: 'resellable' }));
      if (!state.back.length) toast(t('everythingReturned'), 'warn', 6000);
      invoiceInput.value = '';
      render();
    } catch (error) { toastError(error); }
  }

  // --------------------------------------------------------------- the money

  /*
   * The arithmetic, shown as it is typed.
   *
   * `refund_per_unit` is what the customer actually paid for that piece after
   * every discount on that invoice — the lookup works it out, and it is the
   * only honest basis for a credit. The replacement side uses today's price,
   * offer included, which is what the picker hands over.
   */
  const creditTotal = () => state.back.reduce(
    (sum, line) => sum + Number(line.quantity || 0) * Number(line.refund_per_unit || 0), 0,
  );
  const replacementTotal = () => state.out.reduce(
    (sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0,
  );

  function renderSettlement() {
    const credit = creditTotal();
    const replacement = replacementTotal();
    const difference = Math.round((replacement - credit) * 100) / 100;

    mount(settleHost,
      h('div', { class: 'totals' },
        row(t('exchangeCredit'), money(credit)),
        row(t('exchangeReplacement'), money(replacement)),
        h('div', { class: 'line strong' },
          h('span', {},
            difference > 0 ? t('customerPays') : difference < 0 ? t('shopPaysBack') : t('nothingToSettle')),
          h('span', { class: `mono ${difference > 0 ? '' : 'ok'}` }, money(Math.abs(difference))))),

      difference !== 0
        ? field({
          label: t('settlementMethod'),
          input: selectInput({
            value: state.settlement,
            options: ['cash', 'card', 'transfer', 'wallet']
              .map((value) => ({ value, label: t(value, value) })),
            onchange: (event) => { state.settlement = event.target.value; },
          }),
        })
        : null,

      field({
        label: t('reason'),
        input: selectInput({
          value: state.reason,
          options: [
            { value: 'wrong_item', label: t('wrongItem', 'Wrong item') },
            { value: 'wrong_size', label: t('wrongSize', 'Wrong size') },
            { value: 'defective', label: t('defective', 'Faulty') },
            { value: 'changed_mind', label: t('changedMind', 'Changed their mind') },
            { value: 'other', label: t('other', 'Other') },
          ],
          onchange: (event) => { state.reason = event.target.value; },
        }),
      }),
      field({
        label: t('notes'),
        input: textInput({
          value: state.notes,
          oninput: (event) => { state.notes = event.target.value; },
        }),
      }),

      h('button', {
        class: 'btn primary block lg',
        disabled: !ready(),
        onclick: () => submit(),
      }, t('completeExchange')));
  }

  /*
   * `.totals .line` is the rule that spaces a label away from its figure — the
   * same one the returns screen and every printed document use. Without the
   * wrapper the two spans sit against each other and read as one word:
   * "Credit for what came backEGP 0.00".
   */
  const row = (label, value) => h('div', { class: 'line' },
    h('span', {}, label), h('span', { class: 'mono' }, value));

  const ready = () => Boolean(state.invoice)
    && state.back.some((line) => Number(line.quantity) > 0)
    && state.out.some((line) => Number(line.quantity) > 0);

  async function submit() {
    if (!ready()) return;
    const credit = creditTotal();
    const replacement = replacementTotal();
    const difference = Math.round((replacement - credit) * 100) / 100;

    /*
     * One confirmation, and it says the money out loud. This is the only screen
     * in the shop where stock moves in two directions and cash moves in one,
     * and "are you sure" without a number on it is not a confirmation.
     */
    const ok = await confirmDialog({
      title: t('completeExchange'),
      message: difference > 0
        ? t('confirmExchangePay').replace('{amount}', money(difference))
        : difference < 0
          ? t('confirmExchangeRefund').replace('{amount}', money(-difference))
          : t('confirmExchangeEven'),
      confirmLabel: t('completeExchange'),
    });
    if (!ok) return;

    try {
      const result = await api.post('/api/exchanges', {
        sale_id: state.invoice.sale.id,
        lines: state.back
          .filter((line) => Number(line.quantity) > 0)
          .map((line) => ({
            sale_line_id: line.sale_line_id,
            quantity: Number(line.quantity),
            condition: line.condition,
          })),
        replacements: state.out
          .filter((line) => Number(line.quantity) > 0)
          .map((line) => ({ variant_id: line.variant_id, quantity: Number(line.quantity) })),
        settlement_method: state.settlement,
        reason_code: state.reason,
        notes: state.notes || null,
      });
      toast(`${t('exchangeDone')} — ${result.exchange_no}`);
      navigate(`exchanges/${result.id}`);
    } catch (error) { toastError(error); }
  }

  // --------------------------------------------------------------- the lists

  function renderLookup() {
    if (!state.invoice) {
      mount(lookupHost, h('div', { class: 'stack' },
        field({ label: t('invoice'), input: invoiceInput, hint: t('scanReceiptPrompt') })));
      return;
    }
    const { sale } = state.invoice;
    mount(lookupHost,
      h('div', { class: 'row' },
        h('div', {},
          h('div', { class: 'strong' }, sale.invoice_no),
          h('div', { class: 'muted small' },
            `${dateTime(sale.sale_date)} · ${sale.customer_name || t('walkIn')} · ${money(sale.total_amount)}`)),
        h('span', { class: 'spacer' }),
        state.invoice.outsideWindow
          ? tag(`${t('outsideWindow')} (${state.invoice.ageDays} ${t('days')})`, 'danger')
          : tag(`${state.invoice.ageDays} ${t('daysOld')}`, 'ok'),
        h('button', {
          class: 'btn sm ghost',
          onclick: () => {
            state.invoice = null; state.back = []; state.out = []; render();
          },
        }, '✕ ' + t('changeInvoice'))));
  }

  function renderBack() {
    if (!state.back.length) {
      mount(backHost, h('div', { class: 'empty' }, t('findInvoiceFirst')));
      return;
    }
    mount(backHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'description', label: t('product') },
        {
          key: 'returnable',
          label: t('returnable'),
          render: (line) => number(line.returnable_quantity),
        },
        {
          key: 'quantity',
          label: t('qty'),
          render: (line) => h('input', {
            class: 'input sm',
            type: 'number',
            min: 0,
            max: line.returnable_quantity,
            step: 1,
            value: line.quantity,
            style: { width: '84px' },
            // Capped where it is typed as well as on the server: the cashier
            // finds out now rather than after pressing the last button.
            oninput: (event) => {
              const wanted = Number(event.target.value) || 0;
              line.quantity = Math.min(Math.max(wanted, 0), line.returnable_quantity);
              if (line.quantity !== wanted) event.target.value = line.quantity;
              renderSettlement();
            },
          }),
        },
        {
          key: 'condition',
          label: t('condition'),
          render: (line) => selectInput({
            value: line.condition,
            options: [
              { value: 'resellable', label: t('resellable') },
              { value: 'damaged', label: t('damaged') },
            ],
            onchange: (event) => { line.condition = event.target.value; },
          }),
        },
        {
          key: 'refund_per_unit',
          label: t('refundPerUnit'),
          type: 'money',
          render: (line) => money(line.refund_per_unit),
        },
      ],
      rows: state.back,
    }));
  }

  function renderOut() {
    mount(outHost,
      // `.node` — the picker hands back a controller (node, input, dispose),
      // not an element. Mounting the object itself prints [object Object],
      // which is exactly what the first version of this screen did.
      h('div', { class: 'card-body' }, picker.node),
      state.out.length
        ? dataTable({
          columns: [
            { key: 'sku', label: t('sku'), class: 'mono small' },
            { key: 'name', label: t('product') },
            {
              key: 'quantity',
              label: t('qty'),
              render: (line) => h('input', {
                class: 'input sm',
                type: 'number',
                min: 1,
                step: 1,
                value: line.quantity,
                style: { width: '84px' },
                oninput: (event) => {
                  line.quantity = Math.max(Number(event.target.value) || 1, 1);
                  renderSettlement();
                },
              }),
            },
            {
              key: 'unit_price', label: t('price'), type: 'money', render: (line) => money(line.unit_price),
            },
            {
              key: '__x',
              label: '',
              width: '1%',
              render: (line) => h('button', {
                class: 'btn sm ghost danger',
                onclick: () => {
                  state.out = state.out.filter((entry) => entry !== line);
                  render();
                },
              }, '✕'),
            },
          ],
          rows: state.out,
        })
        : h('div', { class: 'empty' }, t('pickReplacement')));
  }

  function render() {
    renderLookup();
    renderBack();
    renderOut();
    renderSettlement();
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('newExchange')), h('p', {}, t('exchangeHint'))),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('exchanges') }, t('exchanges'))),

    h('div', { class: 'pos' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('exchangeStep1'))),
          h('div', { class: 'card-body stack' }, lookupHost)),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('exchangeStep2'))),
          backHost),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('exchangeStep3'))),
          outHost)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('exchangeStep4'))),
        settleHost)));

  render();
  return undefined;
}

/** The list of exchanges, and one exchange with both its documents. */
async function exchangesListView(root) {
  const listHost = h('div', { class: 'card-body tight' }, spinner());

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('exchanges')), h('p', {}, t('exchangeHint'))),
      h('span', { class: 'spacer' }),
      can('sales.exchange')
        ? h('button', { class: 'btn primary', onclick: () => navigate('exchanges/new') }, '＋ ' + t('newExchange'))
        : null),
    h('div', { class: 'card' }, listHost));

  try {
    const data = await api.get('/api/exchanges', { pageSize: 100 });
    mount(listHost, dataTable({
      columns: [
        { key: 'exchange_no', label: t('document'), class: 'mono small' },
        { key: 'created_at', label: t('date'), render: (r) => dateTime(r.created_at) },
        { key: 'invoice_no', label: t('invoice'), class: 'mono small' },
        { key: 'new_invoice_no', label: t('newInvoice'), class: 'mono small' },
        { key: 'customer_name', label: t('customer'), render: (r) => r.customer_name || t('walkIn') },
        { key: 'credit_amount', label: t('exchangeCredit'), type: 'money', render: (r) => money(r.credit_amount) },
        {
          key: 'replacement_amount', label: t('exchangeReplacement'), type: 'money', render: (r) => money(r.replacement_amount),
        },
        {
          key: 'difference_amount',
          label: t('difference'),
          type: 'money',
          // Signed, and coloured by direction: money in is not the same event
          // as money out and should not read the same on a list.
          render: (r) => h('span', { class: r.difference_amount < 0 ? 'ok' : '' },
            `${r.difference_amount > 0 ? '+' : ''}${money(r.difference_amount)}`),
        },
        { key: 'created_by_name', label: t('user'), render: (r) => h('span', { class: 'small muted' }, r.created_by_name || '—') },
      ],
      rows: data.rows,
      onRowClick: (row) => navigate(`exchanges/${row.id}`),
      emptyMessage: t('noExchanges'),
    }));
  } catch (error) {
    toastError(error);
    mount(listHost, h('div', { class: 'empty' }, error.message));
  }
  return undefined;
}

async function exchangeDetailsView(root, id) {
  mount(root, spinner());
  let data;
  try {
    data = await api.get(`/api/exchanges/${id}`);
  } catch (error) {
    toastError(error);
    mount(root, h('div', { class: 'empty' }, error.message));
    return undefined;
  }

  const kpi = (label, value, cls = '') => h('div', { class: 'kpi' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${cls}` }, value));

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, data.exchange_no),
        h('p', {}, `${dateTime(data.created_at)} · ${data.customer_name || t('walkIn')}`)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('exchanges') }, '‹ ' + t('back'))),

    h('div', { class: 'grid cols-4' },
      kpi(t('exchangeCredit'), money(data.credit_amount)),
      kpi(t('exchangeReplacement'), money(data.replacement_amount)),
      kpi(data.difference_amount >= 0 ? t('customerPays') : t('shopPaysBack'),
        money(Math.abs(data.difference_amount)),
        data.difference_amount < 0 ? 'ok' : ''),
      kpi(t('settlementMethod'), t(data.settlement_method, data.settlement_method))),

    /*
     * The three documents, as links. This is the whole reason the exchanges
     * table exists: from here a person reaches the invoice the goods came from,
     * the return that credited them and the invoice that replaced them, without
     * knowing any of their numbers in advance.
     */
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('exchangePaperTrail'))),
      h('div', { class: 'card-body' }, dataTable({
        columns: [
          { key: 'what', label: t('document') },
          { key: 'number', label: t('number'), class: 'mono small' },
          { key: 'amount', label: t('amount'), type: 'money', render: (r) => money(r.amount) },
          {
            key: '__open',
            label: '',
            width: '1%',
            render: (r) => h('button', { class: 'btn sm ghost', onclick: () => navigate(r.href) }, t('view')),
          },
        ],
        rows: [
          {
            what: t('originalInvoice'),
            number: data.invoice_no,
            amount: data.original?.total_amount,
            href: `sales/${data.sale_id}`,
          },
          {
            what: t('returns'),
            number: data.return_no,
            amount: data.credit_amount,
            href: `returns/${data.return_id}`,
          },
          {
            what: t('newInvoice'),
            number: data.new_invoice_no,
            amount: data.replacement_amount,
            href: `sales/${data.new_sale_id}`,
          },
        ],
      }))));
  return undefined;
}
