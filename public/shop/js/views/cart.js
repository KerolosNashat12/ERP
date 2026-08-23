/**
 * The basket. The lines are local — nothing is fetched to paint them — but the
 * quantities are checked against the shop before the customer walks any further
 * with them.
 *
 * A basket lives in `localStorage`, so it can be days old, or hand-edited. When
 * the stock has moved underneath it, the line is clamped on load and the
 * customer is told once. `WebOrderService.place()` is still the guard that
 * matters; this only means nobody discovers the problem after typing in their
 * name, phone number and address.
 */
import { el, fill, icon, ICONS } from '../core/dom.js';
import { api } from '../core/api.js';
import { t, pick } from '../core/i18n.js';
import { money } from '../core/format.js';
import { href } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import { setPageMeta } from '../core/seo.js';
import * as cart from '../core/cart.js';
import { productPhoto } from '../ui/cards.js';
import { emptyState, toast } from '../ui/states.js';
import { summaryPanel } from '../ui/summary.js';

/**
 * What is left of this line, as far as this page knows: a number is a cap, and
 * null — not looked up yet, product gone, or simply not stock-tracked — is no
 * cap, and the server rules on it at checkout.
 */
function capOf(limits, variantId) {
  const value = limits.get(variantId);
  if (value === null || value === undefined) return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(n, 0) : null;
}

function cartLine(line, limits, rerender) {
  const name = pick(line, 'name');
  const cap = capOf(limits, line.variant_id);
  const atCap = cap !== null && line.qty >= cap;

  return el('article.cart-line',
    el('a.cart-photo', { href: line.product_id ? href(routePath('product', { id: line.product_id, slug: slugFor(line) })) : href('cart'), 'aria-label': name },
      productPhoto(line.image_id, name)),
    el('div.cart-detail',
      el('h3.cart-name',
        line.product_id
          ? el('a', { href: href(routePath('product', { id: line.product_id, slug: slugFor(line) })) }, name)
          : name),
      line.label && el('p.cart-variant', line.label),
      el('p.cart-unit.muted', `${money(line.price)} ${t('eachPrice')}`)),
    el('div.cart-controls',
      el('div.qty-field',
        el('div.stepper',
          el('button.step', {
            type: 'button',
            'aria-label': t('decrease'),
            onClick: () => { cart.setQty(line.variant_id, line.qty - 1, cap); rerender(); },
          }, icon(ICONS.minus, { size: 15 })),
          el('span.qty-value', String(line.qty)),
          el('button.step', {
            type: 'button',
            'aria-label': t('increase'),
            class: atCap ? 'is-disabled' : '',
            disabled: atCap,
            onClick: () => { cart.setQty(line.variant_id, line.qty + 1, cap); rerender(); },
          }, icon(ICONS.plus, { size: 15 }))),
        atCap && cap > 0 && el('p.stock-note', { role: 'status' }, t('onlyNLeft', cap))),
      el('button.link-danger', {
        type: 'button',
        onClick: () => { cart.remove(line.variant_id); rerender(); },
      }, icon(ICONS.trash, { size: 15 }), el('span', t('remove')))),
    el('div.cart-line-total', money(line.price * line.qty)));
}

export default function cartView(root) {
  // A basket is one customer's, so it is a page for them and not for an index.
  setPageMeta({ title: t('yourCart'), indexable: false });
  const holder = el('div.wrap.stack');
  root.append(holder);

  /** variant_id -> units left. Empty until the lookup below answers. */
  const limits = new Map();

  function draw() {
    if (cart.isEmpty()) {
      fill(holder,
        el('h1.page-title', t('yourCart')),
        emptyState({
          title: t('cartEmptyTitle'),
          body: t('cartEmptyBody'),
          action: el('a.btn.btn-primary', { href: href('products') }, t('continueShopping')),
        }));
      return;
    }

    fill(holder,
      el('h1.page-title', t('yourCart')),
      el('div.cart-layout',
        el('div.cart-lines', cart.getLines().map((line) => cartLine(line, limits, draw))),
        summaryPanel({
          title: t('orderSummary'),
          action: el('div.summary-actions',
            el('a.btn.btn-primary.btn-block', { href: href('checkout') }, t('goToCheckout')),
            el('a.btn.btn-ghost.btn-block', { href: href('products') }, t('continueShopping'))),
        })));
  }

  /**
   * One request per DISTINCT product, not per line, and only the detail
   * endpoint carries the count. Failures are silent on purpose: a shopper on a
   * flaky connection gets an uncapped stepper and the server's answer at
   * checkout, which is exactly where they were before this existed.
   */
  async function reconcile() {
    const ids = [...new Set(cart.getLines().map((line) => line.product_id).filter(Boolean))];
    if (!ids.length) return;

    const products = await Promise.all(ids.map((id) => api.product(id).catch(() => null)));
    for (const product of products) {
      for (const variant of product?.variants || []) {
        limits.set(variant.id, variant.available === undefined ? null : variant.available);
      }
    }

    const changed = cart.applyLimits(limits);
    draw();
    // Once, and without alarm: the basket already shows the new numbers.
    if (changed.length) toast(t('cartAdjusted'));
  }

  draw();
  reconcile();
}
