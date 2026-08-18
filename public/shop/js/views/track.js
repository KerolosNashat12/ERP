/**
 * Order tracking.
 *
 * The number alone is not enough — the API wants the phone the order was placed
 * with, and answers a mismatch exactly as it answers a number that does not
 * exist. So the failure message here says "check both", never "wrong phone":
 * confirming that an order number is real is itself information a stranger
 * should not be able to fish for.
 */
import { el, fill } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, getLanguage } from '../core/i18n.js';
import { money, date } from '../core/format.js';
import { setPageMeta } from '../core/seo.js';
import { field, validate, notEmpty, looksLikePhone } from '../ui/forms.js';

const STATUS = {
  pending: ['status-pending', 'statusPending', 'statusPendingNote'],
  confirmed: ['status-confirmed', 'statusConfirmed', 'statusConfirmedNote'],
  delivered: ['status-delivered', 'statusDelivered', 'statusDeliveredNote'],
  cancelled: ['status-cancelled', 'statusCancelled', 'statusCancelledNote'],
};

function orderCard(order) {
  const [className, label, note] = STATUS[order.status] || STATUS.pending;
  // Arabic separates a list with its own comma; joining with the Latin one
  // leaves a visible seam in the middle of an address.
  const address = [order.address?.line, order.address?.area, order.address?.city]
    .filter(Boolean).join(getLanguage() === 'ar' ? '، ' : ', ');

  return el('div.panel.order-card',
    el('div.order-head',
      el('div',
        el('span.muted', t('orderNumberLabel')),
        el('strong.order-no-inline', order.order_no)),
      el('span.status-pill', { class: className }, label && t(label))),
    el('p.order-status-note', t(note)),

    el('dl.order-meta',
      el('div', el('dt', t('placedOn')), el('dd', date(order.placed_at))),
      address && el('div', el('dt', t('deliveringTo')), el('dd', address)),
      el('div', el('dt', t('paymentTitle')), el('dd', t('cashOnDelivery')))),

    el('h3.order-lines-title', t('items')),
    el('ul.recap', (order.lines || []).map((line) => el('li.recap-line',
      el('span.recap-qty', `${line.quantity}×`),
      el('span.recap-name', line.description),
      el('span.recap-price', money(line.line_total))))),

    el('div.order-sums',
      el('div.sum-row', el('span', t('subtotal')), el('span.sum-value', money(order.subtotal))),
      Number(order.tax_amount) > 0 && el('div.sum-row', el('span', t('vat')), el('span.sum-value', money(order.tax_amount))),
      el('div.sum-row', el('span', t('delivery')),
        el('span.sum-value', Number(order.delivery_fee) > 0 ? money(order.delivery_fee) : el('span.free-tag', t('free')))),
      el('div.sum-row.sum-total', el('span', t('total')), el('span.sum-value', money(order.total_amount)))));
}

export default function trackView(root, route) {
  setPageMeta({ title: t('trackTitle') });

  const orderNo = field({
    name: 'order', label: t('orderNumberLabel'), required: true,
    placeholder: 'WEB-2026-00001', value: route.query.order || '',
  });
  const phone = field({
    name: 'phone', label: t('phone'), required: true, type: 'tel',
    inputmode: 'tel', autocomplete: 'tel', placeholder: '01xx xxx xxxx',
  });

  const result = el('div.track-result');
  const button = el('button.btn.btn-primary.btn-block', { type: 'submit' }, t('trackButton'));

  const form = el('form.panel.track-form', { novalidate: true, onSubmit: find },
    orderNo.node, phone.node, button);

  async function find(event) {
    event.preventDefault();
    const ok = validate([
      { field: orderNo, test: notEmpty, message: t('requiredField') },
      { field: phone, test: looksLikePhone, message: t('invalidPhone') },
    ]);
    if (!ok) return;

    button.disabled = true;
    button.textContent = t('tracking');
    result.replaceChildren();

    try {
      const order = await api.trackOrder(orderNo.value, phone.value);
      fill(result, orderCard(order));
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      fill(result, el('div.form-error', { role: 'alert' },
        el('span', error?.offline ? t('errorBody') : t('orderNotFound'))));
    } finally {
      button.disabled = false;
      button.textContent = t('trackButton');
    }
  }

  root.append(el('div.wrap.stack.narrow',
    el('h1.page-title', t('trackTitle')),
    el('p.page-note.muted', t('trackIntro')),
    form,
    result));

  // Arriving from the confirmation page, the number is already known — put the
  // cursor straight on the only thing still missing.
  if (route.query.order) phone.focus();
}
