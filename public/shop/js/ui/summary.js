/**
 * The money panel, shared by the cart and the checkout so the two can never
 * quote different totals.
 *
 * The arithmetic mirrors `WebOrderService.#totals` deliberately: prices in this
 * shop are net, VAT is added per line, and free delivery is measured against
 * the goods total with tax IN. Getting that last detail wrong is how a basket
 * promises free delivery that the order then charges for.
 */
import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { money } from '../core/format.js';
import { deliveryFor, freeDeliveryOver } from '../core/store.js';
import * as cart from '../core/cart.js';

export function totals() {
  const subtotal = cart.subtotal();
  const tax = cart.taxTotal();
  const goods = cart.goodsTotal();
  const delivery = deliveryFor(goods);
  return {
    subtotal, tax, goods, delivery, total: Math.round((goods + delivery + Number.EPSILON) * 100) / 100,
  };
}

const row = (label, value, className = '') => el(`div.sum-row.${className}`.replace(/\.$/, ''),
  el('span', label), el('span.sum-value', value));

/**
 * How close the basket is to free delivery. A bar plus the exact amount still
 * needed — "add 340 more" is a reason to keep shopping; "spend 2,000" is not.
 */
export function freeDeliveryProgress(goods) {
  const threshold = freeDeliveryOver();
  if (!threshold) return null;
  if (goods >= threshold) {
    return el('div.free-note.is-earned', el('span', t('freeDeliveryEarned')));
  }
  const remaining = Math.round((threshold - goods + Number.EPSILON) * 100) / 100;
  const pct = Math.max(Math.min((goods / threshold) * 100, 100), 3);
  return el('div.free-note',
    el('span', t('spendMoreForFree', money(remaining))),
    el('div.free-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) },
      el('span', { style: `width:${pct}%` })));
}

export function summaryPanel({ title, action, showProgress = true } = {}) {
  const sums = totals();
  return el('aside.panel.summary',
    title && el('h2.panel-title', title),
    showProgress && freeDeliveryProgress(sums.goods),
    row(t('subtotal'), money(sums.subtotal)),
    sums.tax > 0 && row(t('vat'), money(sums.tax)),
    row(t('delivery'), sums.delivery > 0 ? money(sums.delivery) : el('span.free-tag', t('free'))),
    row(t('total'), money(sums.total), 'sum-total'),
    action);
}
