/**
 * Checkout. Cash on delivery, so there is no payment step and no payment field
 * anywhere on this page — that is stated plainly rather than left to be
 * discovered, because "where do I put my card" is the question that loses the
 * order.
 */
import { el, fill, icon, ICONS } from '../core/dom.js';
import { api, ShopError } from '../core/api.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money } from '../core/format.js';
import { href, navigate } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import * as cart from '../core/cart.js';
import { emptyState } from '../ui/states.js';
import { summaryPanel, totals } from '../ui/summary.js';
import { field, validate, notEmpty, looksLikePhone, looksLikeEmailOrBlank } from '../ui/forms.js';
import { rememberOrder } from './success.js';

/** A compact read-only echo of the basket, so nobody has to go back to check. */
function basketRecap() {
  return el('ul.recap',
    cart.getLines().map((line) => el('li.recap-line',
      el('span.recap-qty', `${line.qty}×`),
      el('span.recap-name',
        pick(line, 'name'),
        line.label && el('span.recap-variant', line.label)),
      el('span.recap-price', money(line.price * line.qty)))));
}

export default function checkoutView(root) {
  setPageMeta({ title: t('checkout') });
  const holder = el('div.wrap.stack');
  root.append(holder);

  if (cart.isEmpty()) {
    fill(holder,
      el('h1.page-title', t('checkout')),
      emptyState({
        title: t('cartEmptyTitle'),
        body: t('cartEmptyBody'),
        action: el('a.btn.btn-primary', { href: href('products') }, t('continueShopping')),
      }));
    return;
  }

  const name = field({
    name: 'name', label: t('fullName'), required: true, autocomplete: 'name',
  });
  const phone = field({
    name: 'phone', label: t('phone'), required: true, type: 'tel',
    autocomplete: 'tel', inputmode: 'tel', hint: t('phoneHint'),
    placeholder: '01xx xxx xxxx',
  });
  const email = field({
    name: 'email', label: t('email'), type: 'email', autocomplete: 'email',
  });
  const city = field({
    name: 'city', label: t('city'), required: true, autocomplete: 'address-level1',
  });
  const area = field({
    name: 'area', label: t('area'), autocomplete: 'address-level2',
  });
  const line = field({
    name: 'line', label: t('addressLine'), required: true, rows: 3,
    autocomplete: 'street-address',
  });
  const addressNotes = field({
    name: 'notes', label: t('addressNotes'), rows: 2, hint: t('addressNotesHint'),
  });
  const note = field({ name: 'note', label: t('orderNote'), rows: 2 });

  const formError = el('div.form-error', { role: 'alert', hidden: true });
  // The button lives in the summary column, outside the <form>, so it is tied
  // back to it by id: that keeps "place order" next to the total on a phone
  // without nesting the whole summary inside the form on a wide screen.
  const submit = el('button.btn.btn-primary.btn-block.btn-lg',
    { type: 'submit', form: 'checkout-form' }, el('span', t('placeOrder')));

  const form = el('form.checkout-form', { id: 'checkout-form', novalidate: true, onSubmit: place },
    formError,
    el('section.panel',
      el('h2.panel-title', t('yourDetails')),
      name.node, phone.node, email.node),
    el('section.panel',
      el('h2.panel-title', t('deliveryAddress')),
      el('div.field-row', city.node, area.node),
      line.node,
      addressNotes.node),
    el('section.panel.panel-cod',
      el('h2.panel-title', icon(ICONS.truck, { size: 18 }), t('paymentTitle')),
      el('div.cod-badge', icon(ICONS.check, { size: 16 }), el('strong', t('cashOnDelivery'))),
      el('p.prose.muted', t('codLong'))),
    // No `.panel-title` on this one: it holds a single field whose own label is
    // that same sentence, and the page was printing "Anything you want us to
    // know" twice, one line above itself.
    el('section.panel', note.node));

  async function place(event) {
    event.preventDefault();
    formError.hidden = true;

    const ok = validate([
      { field: name, test: notEmpty, message: t('requiredField') },
      { field: phone, test: looksLikePhone, message: t('invalidPhone') },
      { field: email, test: looksLikeEmailOrBlank, message: t('invalidEmail') },
      { field: city, test: notEmpty, message: t('requiredField') },
      { field: line, test: notEmpty, message: t('requiredField') },
    ]);
    if (!ok) return;

    submit.disabled = true;
    fill(submit, el('span', t('placingOrder')));

    try {
      const result = await api.placeOrder({
        lines: cart.toOrderLines(),
        customer: { name: name.value, phone: phone.value, email: email.value || undefined },
        address: {
          line: line.value,
          area: area.value || undefined,
          city: city.value,
          notes: addressNotes.value || undefined,
        },
        note: note.value || undefined,
        language: getLanguage(),
      });

      // The basket is cleared only once the order is really recorded — a failed
      // request must leave the customer's shopping exactly where it was.
      rememberOrder({ ...result, customer_name: name.value, phone: phone.value });
      cart.clear();
      navigate(`order/${encodeURIComponent(result.order_no)}`, { replace: true });
    } catch (error) {
      submit.disabled = false;
      fill(submit, el('span', t('placeOrder')));

      // The server refuses the whole order when one line has sold out and says
      // which one. Dropping that line here means the customer can retry rather
      // than hunt for the culprit themselves.
      //
      // Its message is written for whoever reads the logs and is only ever in
      // English, so when it has told us WHICH line failed we say it ourselves,
      // in the language the customer has been shopping in. Anything we cannot
      // interpret is still passed through — a message the shopper half
      // understands beats a generic one that tells them nothing.
      const goneVariant = error instanceof ShopError ? error.details?.variant_id : null;
      if (goneVariant) cart.dropVariant(Number(goneVariant));

      formError.hidden = false;
      fill(formError,
        el('strong', t('orderFailed')),
        el('span', goneVariant ? t('lineSoldOut')
          : (error?.offline ? t('errorBody') : (error?.message || t('errorBody')))));
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Dropping the sold-out line can empty the basket. Bouncing to an empty
      // cart page at that moment would replace the explanation with a shrug, so
      // the customer stays here, with the reason still on screen and the only
      // useful button in place of a total they can no longer pay.
      if (cart.isEmpty()) {
        fill(aside, el('a.btn.btn-ghost.btn-block', { href: href('products') }, t('continueShopping')));
      } else {
        fill(aside, ...asideContent());
      }
    }
  }

  const asideContent = () => [
    el('aside.panel.summary',
      el('h2.panel-title', t('orderSummary')),
      basketRecap()),
    summaryPanel({ showProgress: false, action: el('div.summary-actions', submit) }),
    el('p.cod-foot', t('payOnDelivery', money(totals().total))),
  ];

  const aside = el('div.checkout-aside', asideContent());

  fill(holder,
    el('h1.page-title', t('checkout')),
    el('div.checkout-layout', form, aside));
}
