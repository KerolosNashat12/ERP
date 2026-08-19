/**
 * The console's furniture: the shapes every screen is assembled from.
 *
 * Two people build screens in this app, so the shapes live here rather than
 * being redrawn in each view — a KPI tile is one tile everywhere, a copyable
 * link is one component everywhere, and a change to either lands on every
 * screen at once. The class names these produce are the vocabulary listed at
 * the top of `platform.css`.
 */
import { h } from '../core/dom.js';
import { t } from '../core/i18n.js';
import icons from './icons.js';
import { int, moneyBig } from './format.js';

// ------------------------------------------------------------------- page

/** Title, one-line subtitle, actions on the (inline) end. Every screen. */
export function pageHead({ title, subtitle, actions = [], back }) {
  return h('div', {},
    back || null,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, title),
        subtitle ? h('p', {}, subtitle) : null),
      h('span', { class: 'spacer' }),
      actions.length ? h('div', { class: 'page-actions' }, actions) : null));
}

export function backLink(label, onClick) {
  return h('button', { class: 'back-link', type: 'button', onclick: onClick },
    h('span', { class: 'chev', html: icons.chevron, style: { display: 'inline-flex', width: '13px', transform: 'scaleX(-1)' } }),
    label);
}

/** A card with an optional head. `tight` removes the body padding for tables. */
export function card({
  title, subtitle, actions = [], body, tight = false, className = '',
}) {
  const head = (title || actions.length)
    ? h('div', { class: 'card-head' },
      h('div', {},
        title ? h('h3', {}, title) : null,
        subtitle ? h('span', { class: 'sub' }, subtitle) : null),
      h('span', { class: 'spacer' }),
      ...actions)
    : null;
  return h('div', { class: `card ${className}`.trim() },
    head,
    h('div', { class: `card-body${tight ? ' tight' : ''}` }, body));
}

// ------------------------------------------------------------------ numbers

/**
 * One figure, large, with a small label above it and a quiet comparison below.
 * `tone` marks it: 'accent' (the figure that matters most on the screen — it
 * is the one that carries a sparkline), 'ok', 'warn', 'danger'.
 */
export function kpi({
  label, value, sub, tone = '', title, spark,
}) {
  return h('div', { class: `kpi ${tone}`.trim(), title: title || undefined },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null,
    spark || null);
}

export const kpiRow = (...tiles) => h('div', { class: 'kpis' }, tiles.flat().filter(Boolean));

/**
 * The second tier: figures worth showing, not worth a tile each. One white
 * card, thin dividers, the labels muted underneath — and each value in the
 * colour of what it means (`tone`: 'primary', 'ok', 'warn', 'danger'), which
 * is why a suspended shop is orange here and a healthy one is green. Colour by
 * meaning; never by position in the row.
 */
export function metricStrip(items) {
  return h('div', { class: 'metric-strip' },
    items.filter(Boolean).map((item, index) => h('div', {
      class: `metric${index ? ' sep' : ''}${item.tone ? ` ${item.tone}` : ''}`,
    },
    h('b', {}, item.value),
    h('span', {}, item.label))));
}

/**
 * A bar under a figure. Two jobs, one shape: a plan limit (used of allowed)
 * and a share of a total (this shop of the fleet).
 */
export function meter(fraction, kind = '') {
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  return h('div', { class: 'meter' },
    h('div', { class: `meter-fill ${kind}`.trim(), style: { width: `${pct.toFixed(1)}%` } }));
}

/**
 * "Users 12 / 20" with the bar under it, or no bar at all when the plan has no
 * limit — a full-looking meter for an unlimited plan would be a lie, and an
 * empty one would be meaningless.
 */
export function limitCell(used, limit, label) {
  const caption = label ? h('span', { class: 'k' }, label) : null;
  if (used === null || used === undefined) {
    return h('div', { class: 'meter-cell' },
      h('span', { class: 'meter-label' }, caption, h('span', { dir: 'ltr' }, '—')));
  }
  if (!limit) {
    return h('div', { class: 'meter-cell' },
      h('span', { class: 'meter-label' }, caption, h('span', { dir: 'ltr' }, `${int(used)} · ${t('unlimited')}`)));
  }
  const fraction = used / limit;
  const kind = fraction >= 1 ? 'danger' : (fraction >= 0.85 ? 'warn' : '');
  return h('div', { class: 'meter-cell' },
    h('span', { class: 'meter-label' }, caption, h('span', { dir: 'ltr' }, `${int(used)} / ${int(limit)}`)),
    meter(fraction, kind));
}

/** A money figure with its share of the fleet drawn underneath. */
export function amountCell(value, currency, fractionOfMax) {
  if (value === null || value === undefined) {
    return h('div', { class: 'amount-cell' }, h('span', { class: 'muted' }, '—'));
  }
  return h('div', { class: 'amount-cell' },
    h('span', { class: 'amount' }, moneyBig(value, currency)),
    fractionOfMax === undefined ? null : meter(fractionOfMax, 'primary'));
}

// -------------------------------------------------------------------- chips

/** A pill, not a word: green while a shop is trading, red once it is stopped. */
export const statusCell = (status) => h('span', { class: `status-cell ${status}` },
  h('span', { class: `status-dot ${status}` }),
  status === 'active' ? t('active') : t('suspended'));

/** Module chips, capped — a shop with sixteen modules must not eat the row. */
export function moduleChips(modules = [], max = 3) {
  if (!modules.length) return h('span', { class: 'muted' }, '—');
  const shown = modules.slice(0, max);
  const rest = modules.length - shown.length;
  return h('div', { class: 'module-chips', title: modules.map((m) => t(m)).join(' · ') },
    shown.map((m) => h('span', { class: 'module-chip' }, t(m))),
    rest > 0 ? h('span', { class: 'module-chip more' }, `+${int(rest)}`) : null);
}

// -------------------------------------------------------------------- links

/**
 * navigator.clipboard only exists on a secure origin, and this console can run
 * over plain HTTP on a LAN — fall back to the old copy command, and then to
 * selecting the text so it can be copied by hand.
 */
export async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* denied or insecure context — try the fallback below */ }

  const helper = h('textarea', { class: 'copy-helper', readonly: true, value });
  document.body.append(helper);
  helper.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  helper.remove();
  return copied;
}

/**
 * A copy button that says so. It turns into a tick for a moment rather than
 * only firing a toast, because the owner is usually copying two links in a row
 * and needs to know which one is on the clipboard.
 */
export function copyButton(value, label) {
  const button = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: label || t('copyToClipboard'),
    'aria-label': label || t('copyToClipboard'),
    html: icons.copy,
    onclick: async (event) => {
      event.stopPropagation();
      const ok = await copyText(value);
      button.innerHTML = ok ? icons.check : icons.copy;
      button.classList.toggle('on', ok);
      button.title = ok ? t('copied') : t('copyManually');
      setTimeout(() => {
        button.innerHTML = icons.copy;
        button.classList.remove('on');
        button.title = label || t('copyToClipboard');
      }, 1600);
    },
  });
  return button;
}

/**
 * One of the two addresses a shop is handed out at: the label, the URL itself
 * (which opens in a new tab), and a copy button — because the owner sends
 * these to staff and to customers, and typing one out is how a dead link
 * happens.
 */
export function linkRow({
  label, url, off = false, title, compact = false,
}) {
  const copy = copyButton(url, `${t('copyToClipboard')} — ${label}`);

  /**
   * In a table row the address itself is noise — thirty characters of scheme
   * and host, repeated twice on every line, to say "ERP" and "the shop". The
   * compact form says exactly that, with the external-link glyph to promise a
   * new tab, and keeps the address on the title and on the copy button.
   */
  if (compact) {
    return h('div', { class: `link-row compact${off ? ' off' : ''}` },
      h('a', {
        class: 'link-pill',
        href: url,
        target: '_blank',
        rel: 'noopener',
        title: title || url,
        onclick: (event) => event.stopPropagation(),
      }, h('span', {}, label), h('span', { class: 'ext', html: icons.external })),
      copy);
  }

  return h('div', { class: `link-row${off ? ' off' : ''}` },
    h('span', { class: 'link-label' }, label),
    h('a', {
      class: 'link-url',
      href: url,
      target: '_blank',
      rel: 'noopener',
      title: title || url,
      onclick: (event) => event.stopPropagation(),
    }, url.replace(/^https?:\/\//, '')),
    copy);
}

// ------------------------------------------------------------------ choices

/** Two or three mutually exclusive options, inline. Returns the node. */
export function segmented(options, value, onChange) {
  const node = h('div', { class: 'seg' });
  for (const option of options) {
    node.append(h('button', {
      type: 'button',
      class: option.value === value ? 'on' : '',
      onclick: () => {
        for (const child of node.children) child.classList.remove('on');
        node.querySelector(`[data-v="${CSS.escape(String(option.value))}"]`)?.classList.add('on');
        onChange(option.value);
      },
      dataset: { v: String(option.value) },
    }, option.label));
  }
  return node;
}

/** The shop-detail screens' tab strip. `onChange(key)` on every click. */
export function tabStrip(items, active, onChange) {
  return h('div', { class: 'tabs' }, items.map((item) => h('button', {
    type: 'button',
    class: `tab${item.key === active ? ' active' : ''}`,
    onclick: () => onChange(item.key),
  }, item.label)));
}

export function iconButton({
  icon, label, onClick, className = '',
}) {
  return h('button', {
    class: `icon-btn ${className}`.trim(),
    type: 'button',
    title: label,
    'aria-label': label,
    html: icons[icon] || '',
    onclick: onClick,
  });
}

export default {
  pageHead, backLink, card, kpi, kpiRow, metricStrip, meter, limitCell, amountCell,
  statusCell, moduleChips, copyText, copyButton, linkRow, segmented, tabStrip, iconButton,
};
