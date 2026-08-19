/**
 * The three states every screen in this console owes the person reading it.
 *
 *   loading — a skeleton the same shape and the same height as the answer, so
 *             nothing on the page moves when the answer arrives;
 *   empty   — what this screen is for, and the one button that fills it;
 *   error   — what failed, in words, and a button that tries again.
 *
 * A spinner over a blank page is none of those three, which is why there isn't
 * one in this file.
 */
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import icons from './icons.js';

/** A single shimmering bar. `w` is any CSS width. */
export const skLine = (w = '100%', height = 10) => h('span', {
  class: 'sk sk-line', style: { width: w, height: `${height}px`, display: 'block' },
});

export const skBlock = (height = 120) => h('div', {
  class: 'sk sk-block', style: { height: `${height}px` },
});

/** A KPI row the same height as the real one, so the page does not jump. */
export function skKpis(count = 4) {
  return h('div', { class: 'kpis' }, Array.from({ length: count }, () => h('div', { class: 'kpi is-sk' },
    skLine('54%', 9),
    h('span', { style: { display: 'block', height: '12px' } }),
    skLine('72%', 24),
    h('span', { style: { display: 'block', height: '8px' } }),
    skLine('44%', 9))));
}

/** The two lines of a card's head, while the card's body is still loading. */
export const skCardHead = () => h('div', { class: 'card-head' },
  h('div', { style: { flex: '1' } },
    skLine('180px', 13),
    h('span', { style: { display: 'block', height: '8px' } }),
    skLine('260px', 9)));

/** A whole card: head, then whatever body skeleton is passed in. */
export const skCard = (body, tight = false) => h('div', { class: 'card' },
  skCardHead(),
  h('div', { class: `card-body${tight ? ' tight' : ''}` }, body));

/** Table rows that keep the card at its real height while the data loads. */
export function skRows(rows = 6, cols = 4) {
  return h('div', { class: 'sk-rows' }, Array.from({ length: rows }, () => h('div', { class: 'sk-row' },
    Array.from({ length: cols }, (_, i) => skLine(i === 0 ? '70%' : `${40 + ((i * 17) % 35)}%`)))));
}

/**
 * A state block. `icon` is a key from `icons`; `action` is a button node.
 * `kind` is '' (empty), 'error' or 'loading'.
 */
export function state({
  icon = 'chart', title, message, action, kind = '',
}) {
  return h('div', { class: `state ${kind}`.trim() },
    h('span', { class: 'ico', html: icons[icon] || icons.chart }),
    title ? h('div', { class: 'lead' }, title) : null,
    message ? h('p', {}, message) : null,
    action || null);
}

export const emptyState = ({
  icon = 'shop', title, message, action,
}) => state({
  icon, title: title || t('noResults'), message, action,
});

/**
 * What failed and a way to try again. The message is the server's own where
 * there is one — "Something went wrong" tells the owner nothing they can act on.
 */
export function errorState(error, onRetry) {
  return state({
    kind: 'error',
    icon: 'alert',
    title: t('couldNotLoad'),
    message: error?.message || t('somethingWrong'),
    action: onRetry
      ? h('button', { class: 'btn', onclick: onRetry }, h('span', { html: icons.refresh }), t('retry'))
      : null,
  });
}

/**
 * Load once, and own the three states while doing it.
 *
 *   loadInto(host, {
 *     skeleton: () => skRows(6),
 *     load: () => api.get('/overview'),
 *     render: (data, reload) => node,
 *   })
 *
 * Returns a `reload()` the caller can hang off a refresh button. Every screen
 * that uses this behaves identically when the network is slow or gone, which
 * is the point of it being here rather than in each screen.
 */
export function loadInto(host, { skeleton, load, render }) {
  let generation = 0;

  async function run() {
    const mine = (generation += 1);
    mount(host, skeleton ? skeleton() : skRows(5));
    try {
      const data = await load();
      if (mine !== generation) return;
      mount(host, render(data, run));
    } catch (error) {
      if (mine !== generation) return;
      // Framed, because this is the whole screen's failure standing where the
      // screen should be — a bare message floating on the page reads like a
      // crash, and a card reads like an answer.
      mount(host, h('div', { class: 'card' }, errorState(error, run)));
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  run();
  return run;
}

export default {
  skLine, skBlock, skKpis, skCardHead, skCard, skRows, state, emptyState, errorState, loadInto,
};
