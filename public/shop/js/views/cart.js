/** The basket. Everything here is local — no request is made until checkout. */
import { el, fill, icon, ICONS } from '../core/dom.js';
import { t, pick } from '../core/i18n.js';
import { money } from '../core/format.js';
import { href } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import * as cart from '../core/cart.js';
import { productPhoto } from '../ui/cards.js';
import { emptyState } from '../ui/states.js';
import { summaryPanel } from '../ui/summary.js';

function cartLine(line, rerender) {
  const name = pick(line, 'name');
  return el('article.cart-line',
    el('a.cart-photo', { href: line.product_id ? href(`product/${line.product_id}`) : href('cart'), 'aria-label': name },
      productPhoto(line.image_id, name)),
    el('div.cart-detail',
      el('h3.cart-name',
        line.product_id
          ? el('a', { href: href(`product/${line.product_id}`) }, name)
          : name),
      line.label && el('p.cart-variant', line.label),
      el('p.cart-unit.muted', `${money(line.price)} ${t('eachPrice')}`)),
    el('div.cart-controls',
      el('div.stepper',
        el('button.step', {
          type: 'button',
          'aria-label': t('decrease'),
          onClick: () => { cart.setQty(line.variant_id, line.qty - 1); rerender(); },
        }, icon(ICONS.minus, { size: 15 })),
        el('span.qty-value', String(line.qty)),
        el('button.step', {
          type: 'button',
          'aria-label': t('increase'),
          onClick: () => { cart.setQty(line.variant_id, line.qty + 1); rerender(); },
        }, icon(ICONS.plus, { size: 15 }))),
      el('button.link-danger', {
        type: 'button',
        onClick: () => { cart.remove(line.variant_id); rerender(); },
      }, icon(ICONS.trash, { size: 15 }), el('span', t('remove')))),
    el('div.cart-line-total', money(line.price * line.qty)));
}

export default function cartView(root) {
  setPageMeta({ title: t('yourCart') });
  const holder = el('div.wrap.stack');
  root.append(holder);

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
        el('div.cart-lines', cart.getLines().map((line) => cartLine(line, draw))),
        summaryPanel({
          title: t('orderSummary'),
          action: el('div.summary-actions',
            el('a.btn.btn-primary.btn-block', { href: href('checkout') }, t('goToCheckout')),
            el('a.btn.btn-ghost.btn-block', { href: href('products') }, t('continueShopping'))),
        })));
  }

  draw();
}
