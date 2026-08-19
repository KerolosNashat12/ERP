/**
 * Minimal DOM toolkit — deliberately a fresh, small copy for the platform
 * dashboard rather than an import from the ERP's own `public/js/core/ui.js`.
 * The platform owns everything under `public/platform/` and nothing outside
 * it, so it cannot depend on a sibling app's files without coupling two
 * things that ship, and change, independently. The vocabulary (h/mount,
 * modal, toast, dataTable) is intentionally the same shape as the ERP's —
 * same hand, separate build.
 */
import { t } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && key !== 'list' && typeof value !== 'object') {
      try { node[key] = value; } catch { node.setAttribute(key, value); }
    } else node.setAttribute(key, value);
  }
  appendAll(node, children);
  return node;
}

function appendAll(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  appendAll(f, children);
  return f;
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  appendAll(node, children);
  return node;
}

export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ------------------------------------------------------------------ toasts

export function toast(message, kind = 'ok', ttl = 3800) {
  const root = document.getElementById('toast-root');
  if (!root) return null;
  const node = h('div', { class: `toast ${kind}` }, message);
  root.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, ttl);
  return node;
}

export const toastError = (error) => toast(error?.message || t('somethingWrong'), 'error', 5200);

// ------------------------------------------------------------------ modals

const modalStack = [];

export function modal({
  title, body, footer, size = '', onClose, closeOnBackdrop = true,
}) {
  const root = document.getElementById('modal-root');
  const dialog = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-head' },
      h('h3', {}, title),
      h('button', { class: 'btn ghost sm', onclick: () => close(), title: t('close') }, '✕')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);

  const backdrop = h('div', {
    class: 'modal-backdrop',
    onclick: (event) => { if (closeOnBackdrop && event.target === backdrop) close(); },
  }, dialog);

  function close(result) {
    backdrop.remove();
    const index = modalStack.indexOf(handle);
    if (index >= 0) modalStack.splice(index, 1);
    if (onClose) onClose(result);
  }

  const handle = {
    close, dialog, backdrop, setBody: (node) => mount(dialog.querySelector('.modal-body'), node),
  };
  root.append(backdrop);
  modalStack.push(handle);
  setTimeout(() => dialog.querySelector('input, select, textarea, button')?.focus(), 40);
  return handle;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].close();
});

export function confirmDialog({
  title, message, confirmLabel, danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const dialog = modal({
      title: title || t('confirm'),
      size: 'narrow',
      body: h('p', { class: 'muted', style: { margin: 0, whiteSpace: 'pre-line' } }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => { finish(false); dialog.close(); } }, t('cancel')),
        h('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          onclick: () => { finish(true); dialog.close(); },
        }, confirmLabel || t('confirm')),
      ],
      onClose: () => finish(false),
    });
  });
}

// ------------------------------------------------------------------ inputs

export function field({
  label, input, hint, error,
}) {
  return h('div', { class: `field${error ? ' error' : ''}` },
    label ? h('label', {}, label) : null,
    input,
    hint ? h('span', { class: 'hint' }, hint) : null,
    error ? h('span', { class: 'error-text' }, error) : null);
}

export function textInput(props = {}) {
  return h('input', { class: 'input', type: 'text', ...props });
}

export function numberInput(props = {}) {
  return h('input', { class: 'input', type: 'number', step: '1', ...props });
}

/**
 * A secret the browser must never render in the clear: an auth token typed into
 * a shared screen at a counter, or captured in a screenshot of the form.
 */
export function passwordInput(props = {}) {
  return h('input', {
    class: 'input', type: 'password', autocomplete: 'new-password', ...props,
  });
}

export function selectInput({
  options = [], value, placeholder, ...props
} = {}) {
  const node = h('select', { class: 'select', ...props });
  if (placeholder !== undefined) node.append(h('option', { value: '' }, placeholder));
  for (const option of options) node.append(h('option', { value: option.value }, option.label));
  node.value = value === null || value === undefined ? '' : String(value);
  return node;
}

export function checkboxInput({ label, checked, ...props } = {}) {
  return h('label', { class: 'checkbox' },
    h('input', { type: 'checkbox', checked: Boolean(checked), ...props }),
    h('span', {}, label));
}

// ------------------------------------------------------------------ tables

/**
 * The console's one table.
 *
 * `columns: [{ key, label, render(row), align, width, class }]`
 *
 * Two details carry the design rather than the markup:
 *   - every cell is written with `data-label`, which is what the phone layout
 *     in platform.css turns back into a label when the table becomes a stack
 *     of cards. A table built by hand somewhere else must do the same.
 *   - the first column is marked `data-primary`, so on a phone it becomes the
 *     card's title instead of a labelled row.
 *
 * `class: 'col-lo'` marks a column that is dropped first when the window is
 * too narrow to hold every one of them.
 */
export function dataTable({
  columns, rows, onRowClick, rowClass, emptyIcon, emptyTitle, emptyMessage, emptyAction,
}) {
  if (!rows?.length) {
    return h('div', { class: 'state' },
      h('span', { class: 'ico' }, emptyIcon || '\u25CE'),
      emptyTitle ? h('div', { class: 'lead' }, emptyTitle) : null,
      h('p', {}, emptyMessage || t('noResults')),
      emptyAction || null);
  }

  const cellClass = (c) => `${c.align === 'end' ? 'num' : ''} ${c.class || ''}`.trim();

  const head = h('tr', {}, columns.map((c) => h('th', {
    class: cellClass(c),
    style: c.width ? { width: c.width } : undefined,
  }, c.label)));

  const body = rows.map((row, index) => h('tr', {
    class: `${onRowClick ? 'clickable' : ''} ${rowClass ? (rowClass(row) || '') : ''}`.trim(),
    onclick: onRowClick ? (event) => {
      if (event.target.closest('button, a, input, select')) return;
      onRowClick(row, index);
    } : undefined,
  }, columns.map((c, column) => {
    const content = c.render ? c.render(row, index) : row[c.key];
    const dataset = column === 0 ? { label: c.label || '', primary: '1' } : { label: c.label || '' };
    return h('td', { class: cellClass(c), dataset },
      content instanceof Node ? content : (content ?? '\u2014'));
  })));

  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data' }, h('thead', {}, head), h('tbody', {}, body)));
}

export const tag = (label, kind = '') => h('span', { class: `tag ${kind}` }, label);

export function spinner(message) {
  return h('div', { class: 'empty' }, message || t('loading'));
}

/** Debounce helper for search boxes. */
export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
