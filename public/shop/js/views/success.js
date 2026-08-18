/**
 * "Your order is in."
 *
 * The order number is the biggest thing on the page on purpose: it is the only
 * receipt a cash-on-delivery customer gets, and it is what they will read out
 * on the phone. It is kept in `sessionStorage` so a refresh — or a customer who
 * taps back — still lands on the confirmation instead of an empty basket.
 */
import { el, icon, ICONS } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { money } from '../core/format.js';
import { href, navigate } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';

const KEY = 'mm.shop.lastOrder';

export function rememberOrder(order) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(order));
  } catch { /* the confirmation still paints from memory this once */ }
  lastOrder = order;
}

let lastOrder = null;

function readOrder(orderNo) {
  if (lastOrder && lastOrder.order_no === orderNo) return lastOrder;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.order_no === orderNo ? parsed : null;
  } catch {
    return null;
  }
}

export default function successView(root, route) {
  const orderNo = route.params.orderNo;
  const order = readOrder(orderNo);

  // Opened on another device, or in a session that has since been cleared:
  // there is nothing to confirm, so send them to tracking with the number
  // already filled in rather than showing a made-up receipt.
  if (!order) {
    navigate(`track?order=${encodeURIComponent(orderNo)}`, { replace: true });
    return;
  }

  setPageMeta({ title: t('thankYou') });

  root.append(el('div.wrap.stack',
    el('div.success',
      el('div.success-mark', icon(ICONS.check, { size: 30 })),
      el('h1.success-title', t('thankYou')),
      el('p.success-sub', t('weWillCall')),

      el('div.order-no-card',
        el('span.order-no-label', t('orderNumber')),
        el('strong.order-no', order.order_no),
        el('p.order-no-note', t('keepThisNumber'))),

      order.total_amount !== undefined && el('div.success-total',
        el('span', t('total')),
        el('strong', money(order.total_amount))),
      order.total_amount !== undefined && el('p.success-cod', t('payOnDelivery', money(order.total_amount))),

      el('div.success-actions',
        el('a.btn.btn-primary', { href: href(`track?order=${encodeURIComponent(order.order_no)}`) },
          t('trackThisOrder')),
        el('a.btn.btn-ghost', { href: href('products') }, t('backToShop'))))));
}
