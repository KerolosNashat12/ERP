/**
 * The three screens a shop spends more time on than anyone admits: loading,
 * empty, and broken. Each is a real piece of design here rather than the word
 * "Loading…", because on an Egyptian mobile connection the skeleton IS the page
 * for the first second or two of every visit.
 */
import { el, icon, ICONS } from '../core/dom.js';
import { t } from '../core/i18n.js';

/** A grid of card-shaped placeholders, sized like the cards that will replace them. */
export function skeletonGrid(count = 8) {
  return el('div.grid', { 'aria-busy': 'true', 'aria-label': t('loading') },
    Array.from({ length: count }, () => el('div.card.skeleton-card',
      el('div.skeleton.skeleton-photo'),
      el('div.card-body',
        el('div.skeleton.skeleton-line.w-40'),
        el('div.skeleton.skeleton-line.w-80'),
        el('div.skeleton.skeleton-line.w-50')))));
}

export function skeletonBlock(height = 200) {
  return el('div.skeleton', { style: `height:${height}px;border-radius:14px` });
}

/** The product page's own skeleton — a gallery beside a column of text. */
export function skeletonProduct() {
  return el('div.product-layout', { 'aria-busy': 'true' },
    el('div.gallery', el('div.skeleton.gallery-main'),
      el('div.thumbs', Array.from({ length: 4 }, () => el('div.skeleton.thumb')))),
    el('div.product-info',
      el('div.skeleton.skeleton-line.w-40'),
      el('div.skeleton.skeleton-line.w-80', { style: 'height:28px' }),
      el('div.skeleton.skeleton-line.w-50', { style: 'height:24px' }),
      el('div.skeleton', { style: 'height:120px;border-radius:12px;margin-block-start:20px' })));
}

/**
 * Empty is not an error, so it does not look like one: a quiet mark, a plain
 * sentence and — always — a way onward. A dead end with no link out is how a
 * shopper leaves.
 */
export function emptyState({ title, body, action } = {}) {
  return el('div.state',
    el('div.state-mark', el('span', '✦')),
    el('h2.state-title', title || t('nothingHere')),
    body && el('p.state-body', body),
    action);
}

/**
 * The API is unreachable or answered with a 500. The customer is told plainly,
 * given a button that retries in place, and never shown a stack trace or a
 * status code — neither means anything to them.
 */
export function errorState(error, onRetry) {
  const offline = error?.offline;
  return el('div.state.state-error',
    el('div.state-mark.state-mark-warn', el('span', '!')),
    el('h2.state-title', t('errorTitle')),
    el('p.state-body', offline ? t('errorBody') : (error?.message || t('errorBody'))),
    onRetry && el('button.btn.btn-primary', { type: 'button', onClick: onRetry }, t('retry')));
}

/** Shown on every page when `shopEnabled` is false. There is no catalogue behind it. */
export function closedState(whatsapp) {
  return el('div.state.state-closed',
    el('div.state-mark', el('span', '✦')),
    el('h2.state-title', t('closedTitle')),
    el('p.state-body', t('closedBody')),
    whatsapp && el('a.btn.btn-ghost', {
      href: `https://wa.me/${String(whatsapp).replace(/[^\d]/g, '')}`,
      target: '_blank', rel: 'noopener noreferrer',
    }, icon(ICONS.whatsapp), t('whatsappUs')));
}

/**
 * A short-lived confirmation. Announced politely to screen readers rather than
 * assertively, so it does not interrupt somebody mid-sentence — the customer
 * asked for this, it is not news.
 */
let toastTimer = null;
export function toast(message, action) {
  document.querySelector('.toast')?.remove();
  const node = el('div.toast', { role: 'status', 'aria-live': 'polite' },
    icon(ICONS.check), el('span', message), action);
  document.body.append(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 300);
  }, 3600);
  return node;
}
