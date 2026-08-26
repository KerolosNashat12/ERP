/**
 * Point of sale.
 *
 * Scanner-first: a hardware QR scan anywhere on this screen adds the item to
 * the basket. Every total shown comes from the server's /sales/quote endpoint,
 * so the price the cashier sees is exactly what will be committed.
 */
import api from '../core/api.js';
import {
  h, mount, toast, toastError, textInput, numberInput, field,
  modal, debounce, printNode, tag, dataTable,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money, number, dateTime } from '../core/format.js';
import { session, can, devices } from '../core/store.js';
import { onScan } from '../core/scanner.js';

const HOLD_KEY = 'mm.pos.held';


/**
 * The offer on a variant row, computed the same way the server computes it.
 *
 * A copy of the rule rather than an import, for the reason every other shared
 * rule in this codebase is copied into the browser (see `shared/delivery.js`
 * and the storefront's `store.js`): there is no build step, and `src/` is not
 * served. It is DISPLAY only — the price that is charged is always the
 * server's, so a drift here shows a stale number for a moment and can never
 * take the wrong money.
 */
function offerFor(variant) {
  const list = Number(variant.selling_price || 0);
  const type = String(variant.discount_type || 'none');
  const value = Number(variant.discount_value || 0);
  const none = { price: list, listPrice: list, onSale: false, percent: 0 };
  if (!list || (type !== 'percent' && type !== 'amount') || !(value > 0)) return none;

  const day = new Date().toISOString().slice(0, 10);
  const from = variant.discount_starts_on ? String(variant.discount_starts_on).slice(0, 10) : null;
  const to = variant.discount_ends_on ? String(variant.discount_ends_on).slice(0, 10) : null;
  if ((from && day < from) || (to && day > to)) return none;

  const round2 = (n) => Math.round(n * 100) / 100;
  const off = type === 'percent'
    ? round2(list * (Math.min(Math.max(value, 0), 100) / 100))
    : round2(Math.min(Math.max(value, 0), list));
  const price = round2(Math.max(list - off, 0));
  if (!(list - price > 0)) return none;
  return { price, listPrice: list, onSale: true, percent: Math.round(((list - price) / list) * 100) };
}

/**
 * One basket line, as the server should read it.
 *
 * `unit_price` is sent ONLY when a person typed one. Otherwise it is left out
 * entirely, which is what tells `SalesService` to price the line itself — from
 * the product's own offer, on the server's clock.
 */
function lineForServer(line) {
  const payload = {
    key: line.key,
    variant_id: line.variant_id,
    quantity: line.quantity,
    discount_percent: line.discount_percent,
  };
  if (line.priceEdited) payload.unit_price = line.unit_price;
  return payload;
}

export async function posView(root) {
  const state = {
    lines: [],
    customer: null,
    promotionCode: '',
    manualDiscount: 0,
    loyaltyRedeem: 0,
    paymentMethod: 'cash',
    amountPaid: '',
    notes: '',
    quote: null,
    nextKey: 1,
  };

  const searchInput = textInput({
    placeholder: t('scanPrompt'),
    dataset: { scanTarget: 'true' },
    autocomplete: 'off',
    oninput: debounce((event) => runSearch(event.target.value), 220),
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const value = searchInput.value.trim();
        if (value) addByCode(value);
      }
    },
  });

  const resultsHost = h('div');
  const cartHost = h('div', { class: 'card-body tight pos-cart' });
  const totalsHost = h('div', { class: 'card-body stack' });
  const customerHost = h('div');

  // ------------------------------------------------------------ basket ops

  function addLine(variant, quantity = 1) {
    const existing = state.lines.find((l) => l.variant_id === variant.variant_id);
    if (existing) existing.quantity += quantity;
    else {
      /*
       * The offer is shown here and DECIDED on the server.
       *
       * The line opens at the offer price so the cashier reads the customer the
       * same number the website is showing — but `priceEdited` stays false, and
       * a line that has not been edited is sent WITHOUT a price. The server
       * then prices it from the database, on the server's own idea of what day
       * it is. A till that has been open since yesterday, or a queued offline
       * sale replayed this morning, therefore cannot charge yesterday's offer.
       */
      const offer = offerFor(variant);
      state.lines.push({
        key: state.nextKey++,
        variant_id: variant.variant_id,
        sku: variant.sku,
        name: pick(variant, 'product_name'),
        variantLabel: variant.variant_label,
        unit_price: offer.price,
        list_price: offer.onSale ? offer.listPrice : 0,
        priceEdited: false,
        quantity,
        discount_percent: 0,
        stock: variant.quantity,
      });
    }
    mount(resultsHost);
    searchInput.value = '';
    refreshQuote();
  }

  async function addByCode(code) {
    try {
      const variant = await api.get(`/api/products/scan/${encodeURIComponent(code)}`);
      addLine(variant);
      toast(`${variant.sku} ${t('added')}`, 'ok', 1400);
    } catch {
      // Not an exact code — fall back to a name search.
      runSearch(code);
    }
  }

  async function runSearch(term) {
    if (!term || term.length < 2) { mount(resultsHost); return; }
    try {
      const { rows } = await api.get('/api/products/lookup', { q: term });
      if (!rows.length) { mount(resultsHost, h('div', { class: 'pos-results' }, h('div', { class: 'empty' }, t('noResults')))); return; }
      mount(resultsHost, h('div', { class: 'pos-results' },
        rows.map((row) => h('div', {
          class: 'pos-result',
          onclick: () => addLine(row),
        },
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, `${pick(row, 'product_name')} — ${row.variant_label || ''}`),
          h('small', { class: 'mono' }, row.sku)),
        h('div', { class: 'right' },
          h('div', { class: 'strong' }, money(row.selling_price)),
          h('small', { class: row.quantity > 0 ? 'muted' : 'tag danger' },
            row.quantity > 0 ? `${number(row.quantity)} ${t('inStock')}` : t('outOfStock')))))));
    } catch (error) { toastError(error); }
  }

  const unsubscribe = onScan((code) => addByCode(code));

  // ------------------------------------------------------------- rendering

  function renderCart() {
    if (!state.lines.length) {
      mount(cartHost, h('div', { class: 'empty' }, h('span', { class: 'ico' }, '🛒'), t('emptyCart')));
      return;
    }
    mount(cartHost, dataTable({
      columns: [
        {
          key: 'item',
          label: t('product'),
          render: (line) => h('div', {},
            h('div', { class: 'strong small' }, line.name),
            h('small', { class: 'muted' }, `${line.variantLabel || ''} · ${line.sku}`)),
        },
        {
          key: 'qty',
          label: t('qty'),
          align: 'end',
          render: (line) => h('div', { class: 'qty-box' },
            h('button', { onclick: () => { line.quantity = Math.max(1, line.quantity - 1); refreshQuote(); } }, '−'),
            h('input', {
              value: line.quantity,
              onchange: (e) => { line.quantity = Math.max(0.001, Number(e.target.value) || 1); refreshQuote(); },
            }),
            h('button', { onclick: () => { line.quantity += 1; refreshQuote(); } }, '+')),
        },
        {
          key: 'price',
          label: t('price'),
          align: 'end',
          render: (line) => numberInput({
            value: line.unit_price, style: { width: '92px' },
            disabled: !can('sales.discount'),
            onchange: (e) => {
              line.unit_price = Number(e.target.value) || 0;
              // From here on this line's price is a person's decision, and the
              // server must take it verbatim rather than re-pricing it.
              line.priceEdited = true;
              refreshQuote();
            },
          }),
        },
        {
          key: 'disc',
          label: '%',
          align: 'end',
          render: (line) => numberInput({
            value: line.discount_percent, style: { width: '64px' }, min: 0, max: 100,
            disabled: !can('sales.discount'),
            onchange: (e) => { line.discount_percent = Number(e.target.value) || 0; refreshQuote(); },
          }),
        },
        {
          key: 'total',
          label: t('total'),
          align: 'end',
          render: (line) => {
            const quoted = state.quote?.lines?.find((l) => l.key === line.key);
            return h('span', { class: 'strong' }, money(quoted ? quoted.line_total : line.quantity * line.unit_price));
          },
        },
        {
          key: '__x',
          label: '',
          render: (line) => h('button', {
            class: 'btn sm ghost',
            onclick: () => { state.lines = state.lines.filter((l) => l.key !== line.key); refreshQuote(); },
          }, '✕'),
        },
      ],
      rows: state.lines,
    }));
  }

  function renderCustomer() {
    const searchBox = textInput({
      placeholder: t('selectCustomer'),
      value: state.customer ? `${state.customer.name} (${state.customer.phone || state.customer.code})` : '',
      oninput: debounce(async (event) => {
        const term = event.target.value.trim();
        if (term.length < 2) { mount(dropdown); return; }
        const { rows } = await api.get('/api/customers/search', { q: term });
        mount(dropdown, h('div', { class: 'pos-results' },
          rows.map((row) => h('div', {
            class: 'pos-result',
            onclick: () => {
              state.customer = row;
              state.loyaltyRedeem = 0;
              mount(dropdown);
              renderCustomer();
              refreshQuote();
            },
          },
          h('div', { class: 'meta' },
            h('div', { class: 'name' }, row.name),
            h('small', {}, `${row.phone || row.code} · ${t(row.customer_group)}`)),
          row.balance > 0 ? tag(money(row.balance), 'warn') : null))));
      }, 260),
    });
    const dropdown = h('div');

    mount(customerHost,
      h('div', { class: 'pos-search' },
        field({ label: t('customer'), input: searchBox }),
        dropdown),
      state.customer
        ? h('div', { class: 'row small', style: { marginTop: '6px' } },
          tag(t(state.customer.customer_group), state.customer.customer_group === 'vip' ? 'gold' : 'info'),
          state.customer.balance > 0 ? tag(`${t('balance')}: ${money(state.customer.balance)}`, 'warn') : null,
          Number(state.customer.loyalty_points) > 0
            ? tag(`${number(state.customer.loyalty_points)} ${t('pointsAvailable')}`, 'ok') : null,
          h('button', {
            class: 'btn sm ghost',
            onclick: () => { state.customer = null; state.loyaltyRedeem = 0; renderCustomer(); refreshQuote(); },
          }, '✕ ' + t('walkIn')))
        : h('div', { class: 'muted small', style: { marginTop: '6px' } }, t('walkIn')));
  }

  function renderTotals() {
    const q = state.quote;
    const total = q?.totalAmount || 0;
    const paid = state.amountPaid === '' ? total : Number(state.amountPaid);
    const change = state.paymentMethod === 'cash' && paid > total ? paid - total : 0;

    const promoInput = textInput({
      value: state.promotionCode,
      placeholder: t('promoCode'),
      onchange: (e) => { state.promotionCode = e.target.value.trim().toUpperCase(); refreshQuote(); },
    });

    const line = (label, value, cls = '') => h('div', { class: `line ${cls}` },
      h('span', {}, label), h('span', { class: 'mono' }, value));

    mount(totalsHost,
      customerHost,
      h('div', { class: 'row', style: { gap: '6px' } },
        h('div', { style: { flex: 1 } }, field({ label: t('promoCode'), input: promoInput })),
        h('button', { class: 'btn', style: { alignSelf: 'end' }, onclick: () => refreshQuote() }, t('applyCode'))),
      q?.promotion ? h('div', {}, tag(`${q.promotion.code} · −${money(q.promotionDiscount)}`, 'ok')) : null,

      can('sales.discount') ? h('div', { class: 'row', style: { gap: '8px' } },
        h('div', { style: { flex: 1 } }, field({
          label: t('manualDiscount'),
          input: numberInput({
            value: state.manualDiscount, min: 0,
            onchange: (e) => { state.manualDiscount = Number(e.target.value) || 0; refreshQuote(); },
          }),
        })),
        state.customer && Number(state.customer.loyalty_points) > 0 ? h('div', { style: { flex: 1 } }, field({
          label: t('redeemPoints'),
          input: numberInput({
            value: state.loyaltyRedeem, min: 0, max: state.customer.loyalty_points,
            onchange: (e) => { state.loyaltyRedeem = Number(e.target.value) || 0; refreshQuote(); },
          }),
        })) : null) : null,

      h('div', { class: 'totals' },
        line(t('subtotal'), money(q?.subtotal || 0)),
        q?.lineDiscount ? line(t('lineDiscount'), `− ${money(q.lineDiscount)}`, 'discount') : null,
        q?.promotionDiscount ? line(`${t('promoCode')} ${q.promotion?.code || ''}`, `− ${money(q.promotionDiscount)}`, 'discount') : null,
        q?.manualDiscount ? line(t('manualDiscount'), `− ${money(q.manualDiscount)}`, 'discount') : null,
        q?.loyaltyDiscount ? line(t('loyaltyPoints'), `− ${money(q.loyaltyDiscount)}`, 'discount') : null,
        line(t('tax'), money(q?.taxAmount || 0)),
        line(t('total'), money(total), 'grand')),

      h('div', { class: 'field' },
        h('label', {}, t('paymentMethod')),
        h('div', { class: 'pay-methods' },
          ...['cash', 'card', 'transfer', 'wallet', 'credit'].map((method) => h('button', {
            class: `btn sm${state.paymentMethod === method ? ' active' : ''}`,
            onclick: () => { state.paymentMethod = method; renderTotals(); },
          }, t(method))))),

      state.paymentMethod !== 'credit' ? field({
        label: t('amountPaid'),
        input: numberInput({
          value: state.amountPaid, placeholder: String(total.toFixed(2)),
          oninput: (e) => { state.amountPaid = e.target.value; renderTotals(); },
        }),
      }) : h('div', { class: 'muted small' }, t('credit') + ' — ' + t('customer') + ' ' + t('required')),

      change > 0 ? h('div', { class: 'totals' }, line(t('change'), money(change), 'grand')) : null,

      h('div', { class: 'row', style: { marginTop: '4px' } },
        h('button', {
          class: 'btn gold lg block',
          disabled: !state.lines.length,
          onclick: checkout,
        }, `${t('completeSale')} · ${money(total)}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: holdSale, disabled: !state.lines.length }, t('holdSale')),
        h('button', { class: 'btn sm', onclick: resumeSale }, t('resumeSale')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn sm ghost',
          onclick: () => { resetSale(); },
        }, t('clearCart'))));
  }

  // ----------------------------------------------------------------- quote

  const refreshQuote = debounce(async () => {
    if (!state.lines.length) {
      state.quote = null;
      renderCart();
      renderTotals();
      return;
    }
    try {
      state.quote = await api.post('/api/sales/quote', {
        customer_id: state.customer?.id || null,
        promotion_code: state.promotionCode || null,
        manual_discount: state.manualDiscount || 0,
        loyalty_redeem_points: state.loyaltyRedeem || 0,
        lines: state.lines.map((l) => lineForServer(l)),
      });
    } catch (error) {
      if (state.promotionCode) {
        toast(error.message, 'warn');
        state.promotionCode = '';
        state.quote = await api.post('/api/sales/quote', {
          customer_id: state.customer?.id || null,
          manual_discount: state.manualDiscount || 0,
          lines: state.lines.map((l) => ({
            key: l.key, variant_id: l.variant_id, quantity: l.quantity,
            unit_price: l.unit_price, discount_percent: l.discount_percent,
          })),
        });
      } else {
        toastError(error);
      }
    }
    renderCart();
    renderTotals();
  }, 120);

  async function checkout() {
    const total = state.quote?.totalAmount || 0;
    const paid = state.paymentMethod === 'credit'
      ? 0
      : (state.amountPaid === '' ? total : Number(state.amountPaid));
    try {
      const sale = await api.post('/api/sales', {
        customer_id: state.customer?.id || null,
        promotion_code: state.promotionCode || null,
        manual_discount: state.manualDiscount || 0,
        loyalty_redeem_points: state.loyaltyRedeem || 0,
        payment_method: state.paymentMethod,
        paid_amount: paid,
        notes: state.notes || null,
        lines: state.lines.map((l) => lineForServer(l)),
      });
      toast(`${t('saleCompleted')} — ${sale.invoice_no}`);
      showReceiptDialog(sale);
      resetSale();
    } catch (error) { toastError(error); }
  }

  function resetSale() {
    state.lines = [];
    state.customer = null;
    state.promotionCode = '';
    state.manualDiscount = 0;
    state.loyaltyRedeem = 0;
    state.amountPaid = '';
    state.quote = null;
    state.paymentMethod = 'cash';
    renderCustomer();
    renderCart();
    renderTotals();
    searchInput.focus();
  }

  function holdSale() {
    const held = JSON.parse(localStorage.getItem(HOLD_KEY) || '[]');
    held.push({
      at: new Date().toISOString(),
      lines: state.lines,
      customer: state.customer,
      promotionCode: state.promotionCode,
    });
    localStorage.setItem(HOLD_KEY, JSON.stringify(held.slice(-10)));
    toast(t('holdSale'));
    resetSale();
  }

  function resumeSale() {
    const held = JSON.parse(localStorage.getItem(HOLD_KEY) || '[]');
    if (!held.length) { toast(t('noResults'), 'warn'); return; }
    const dialog = modal({
      title: t('heldSales'),
      size: 'narrow',
      body: h('div', { class: 'stack' }, held.map((entry, index) => h('button', {
        class: 'btn block',
        onclick: () => {
          state.lines = entry.lines;
          state.customer = entry.customer;
          state.promotionCode = entry.promotionCode || '';
          held.splice(index, 1);
          localStorage.setItem(HOLD_KEY, JSON.stringify(held));
          dialog.close();
          renderCustomer();
          refreshQuote();
        },
      }, `${dateTime(entry.at)} · ${entry.lines.length} ${t('products')}`))),
    });
  }

  // ------------------------------------------------------------------ view

  mount(root,
    h('div', { class: 'pos' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card-body' },
            h('div', { class: 'pos-search' },
              field({
                label: `${t('search')} / ${t('barcode')}`,
                input: searchInput,
                hint: t('scanToTest'),
              }),
              resultsHost))),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' },
            h('h3', {}, t('cart')),
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted small' }, session.location ? pick(session.location, 'name') : '')),
          cartHost)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('charge'))),
        totalsHost)));

  renderCustomer();
  renderCart();
  renderTotals();
  searchInput.focus();

  return () => unsubscribe();
}

/**
 * Receipt. Width, font scale, QR and footer all come from Settings → Devices,
 * so the same builder drives a 58mm thermal roll, an 80mm one, or A4.
 * `options` lets the device settings screen preview un-saved changes.
 */
export function buildReceipt(sale, options = {}) {
  const cfg = { ...devices().receipt, ...options };
  const settings = session.settings;
  const ar = getLanguage() === 'ar';
  const widthMm = cfg.width === '58' ? 54 : (cfg.width === 'a4' ? 180 : 76);
  const scale = (cfg.fontScale || 100) / 100;
  const footer = cfg.footer ?? (ar ? settings['printer.receipt_footer_ar'] : settings['printer.receipt_footer_en']);
  const policy = cfg.returnPolicy
    ?? (ar ? settings['printer.receipt_return_policy_ar'] : settings['printer.receipt_return_policy_en']);

  const node = h('div', {
    class: 'receipt',
    style: {
      width: `${widthMm}mm`,
      fontSize: `${11 * scale}px`,
      border: cfg.preview ? '1px dashed var(--line)' : undefined,
      padding: cfg.preview ? '8px' : undefined,
    },
  },
  h('h3', { style: { fontSize: `${15 * scale}px` } },
    ar ? (settings['company.name_ar'] || t('appName')) : (settings['company.name'] || t('appName'))),
  h('div', { class: 'center' }, settings['company.address'] || ''),
  h('div', { class: 'center' }, settings['company.phone'] || ''),
  settings['company.tax_number'] ? h('div', { class: 'center' }, `${t('taxNumber')}: ${settings['company.tax_number']}`) : null,
  h('hr'),
  h('div', {}, `${t('invoiceNo')}: ${sale.invoice_no}`),
  h('div', {}, `${t('date')}: ${dateTime(sale.sale_date)}`),
  h('div', {}, `${t('cashier')}: ${sale.cashier_name || ''}`),
  h('div', {}, `${t('customer')}: ${sale.customer_name || t('walkIn')}`),
  h('hr'),
  h('table', { style: { fontSize: `${10.5 * scale}px` } }, sale.lines.map((line) => h('tr', {},
    h('td', { colspan: 2 },
      h('div', {}, line.description),
      h('div', {}, `${number(line.quantity)} × ${money(line.unit_price, { withSymbol: false })}`),
      // The saving, on the customer's own copy. A shop that discounts and does
      // not say so on the receipt has given the discount and kept the credit
      // for it — and a customer holding a slip that shows the old price beside
      // the new one has a reason to come back for the next offer.
      Number(line.list_price) > Number(line.unit_price)
        ? h('div', { class: 'muted' },
          `${t('offer')}: ${money(line.list_price, { withSymbol: false })} → ${money(line.unit_price, { withSymbol: false })}`)
        : null),
    h('td', { style: { textAlign: 'end', verticalAlign: 'bottom' } },
      money(line.line_total, { withSymbol: false }))))),
  h('hr'),
  cfg.showTaxLines
    ? h('div', { class: 'tot' }, h('span', {}, t('subtotal')), h('span', {}, money(sale.subtotal, { withSymbol: false })))
    : null,
  sale.discount_amount
    ? h('div', { class: 'tot' }, h('span', {}, t('discount')), h('span', {}, `− ${money(sale.discount_amount, { withSymbol: false })}`))
    : null,
  cfg.showTaxLines
    ? h('div', { class: 'tot' }, h('span', {}, t('tax')), h('span', {}, money(sale.tax_amount, { withSymbol: false })))
    : null,
  h('div', { class: 'tot grand', style: { fontSize: `${13 * scale}px` } },
    h('span', {}, t('total')), h('span', {}, money(sale.total_amount))),
  h('div', { class: 'tot' }, h('span', {}, t(sale.payment_method, sale.payment_method)),
    h('span', {}, money(sale.paid_amount, { withSymbol: false }))),
  sale.change_amount
    ? h('div', { class: 'tot' }, h('span', {}, t('change')), h('span', {}, money(sale.change_amount, { withSymbol: false })))
    : null,
  sale.loyalty_earned
    ? h('div', { class: 'tot' }, h('span', {}, t('loyaltyPoints')), h('span', {}, `+${number(sale.loyalty_earned)}`))
    : null,
  h('hr'),
  cfg.showQr ? h('div', { class: 'qr', id: `receipt-qr-${sale.id}` }) : null,
  policy ? h('div', { class: 'center small' }, policy) : null,
  footer ? h('div', { class: 'center' }, footer) : null);

  return node;
}

/**
 * Show the receipt after a sale. The QR encodes `INV:<number>` so the same
 * receipt can be scanned back at the returns desk.
 */
export async function showReceiptDialog(sale) {
  const cfg = devices().receipt;

  const withQr = async (node) => {
    if (!cfg.showQr) return node;
    try {
      const { dataUri } = await api.get('/api/labels/qr', { payload: `INV:${sale.invoice_no}`, size: 140 });
      const holder = node.querySelector(`#receipt-qr-${sale.id}`);
      if (holder) mount(holder, h('img', { src: dataUri, alt: sale.invoice_no }));
    } catch { /* the receipt is still valid without the QR */ }
    return node;
  };

  const printReceipt = async () => {
    const copies = Math.max(1, cfg.copies || 1);
    const sheet = h('div', {});
    for (let i = 0; i < copies; i += 1) {
      sheet.append(await withQr(buildReceipt(sale)));
      if (i < copies - 1) sheet.append(h('div', { style: { pageBreakAfter: 'always' } }));
    }
    printNode(sheet);
  };

  if (cfg.autoPrint) {
    await printReceipt();
    return;
  }

  const receipt = await withQr(buildReceipt(sale, { preview: true }));
  const dialog = modal({
    title: `${t('invoice')} ${sale.invoice_no}`,
    size: 'narrow',
    body: h('div', { style: { display: 'grid', justifyContent: 'center' } }, receipt),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('close')),
      h('button', { class: 'btn primary', onclick: printReceipt }, '🖨 ' + t('printReceipt')),
    ],
  });
}
