/**
 * Minimal DOM toolkit — hyperscript, tables, forms, modals, toasts.
 * Keeping this deliberately small avoids a build step: the app runs straight
 * from disk, which matters for an offline install.
 */
import { t, pick } from './i18n.js';

/** h('div', {class:'x', onclick}, child, child) */
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

export function modal({ title, body, footer, size = '', onClose, closeOnBackdrop = true }) {
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

  const handle = { close, dialog, backdrop, setBody: (node) => mount(dialog.querySelector('.modal-body'), node) };
  root.append(backdrop);
  modalStack.push(handle);
  setTimeout(() => dialog.querySelector('input, select, textarea, button')?.focus(), 40);
  return handle;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].close();
});

export function confirmDialog({ title, message, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const dialog = modal({
      title: title || t('confirm'),
      size: 'narrow',
      body: h('p', { class: 'muted', style: { margin: 0 } }, message),
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

export function field({ label, input, hint, error }) {
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
  return h('input', { class: 'input', type: 'number', step: 'any', ...props });
}

export function selectInput({ options = [], value, placeholder, ...props } = {}) {
  const node = h('select', { class: 'select', ...props });
  if (placeholder !== undefined) node.append(h('option', { value: '' }, placeholder));
  for (const option of options) {
    node.append(h('option', { value: option.value }, option.label));
  }
  node.value = value === null || value === undefined ? '' : String(value);
  return node;
}

export function checkboxInput({ label, checked, ...props } = {}) {
  return h('label', { class: 'checkbox' },
    h('input', { type: 'checkbox', checked: Boolean(checked), ...props }),
    h('span', {}, label));
}

/**
 * Declarative form builder.
 * fields: [{ name, label, type, options, required, value, span, hint, ... }]
 * Returns { node, values(), setError(name,msg), focus() }
 */
export function buildForm(fields, initial = {}, { columns = 2 } = {}) {
  const inputs = new Map();
  const wrapper = h('div', { class: `grid cols-${columns}` });

  for (const spec of fields) {
    if (spec.when && !spec.when(initial)) continue;
    const value = initial[spec.name] ?? spec.value ?? '';
    let input;
    switch (spec.type) {
      case 'number':
        input = numberInput({ name: spec.name, value, min: spec.min, max: spec.max, step: spec.step || 'any', disabled: spec.disabled });
        break;
      case 'select':
        input = selectInput({
          name: spec.name, options: spec.options || [], value,
          placeholder: spec.placeholder ?? (spec.required ? undefined : '—'),
          disabled: spec.disabled,
        });
        break;
      case 'textarea':
        input = h('textarea', { class: 'textarea', name: spec.name, rows: spec.rows || 3 }, value);
        break;
      case 'checkbox':
        input = checkboxInput({ label: spec.label, name: spec.name, checked: value === 1 || value === true });
        break;
      case 'date':
        input = h('input', { class: 'input', type: 'date', name: spec.name, value: value ? String(value).slice(0, 10) : '' });
        break;
      case 'color':
        input = h('input', { class: 'input', type: 'color', name: spec.name, value: value || '#000000', style: { height: '34px', padding: '2px' } });
        break;
      case 'password':
        input = h('input', { class: 'input', type: 'password', name: spec.name, value, autocomplete: 'new-password' });
        break;
      default:
        input = textInput({ name: spec.name, value, placeholder: spec.placeholder, disabled: spec.disabled });
    }

    const holder = spec.type === 'checkbox'
      ? h('div', { class: 'field' }, input)
      : field({ label: spec.label + (spec.required ? ' *' : ''), input, hint: spec.hint });
    if (spec.span) holder.style.gridColumn = `span ${Math.min(spec.span, columns)}`;
    inputs.set(spec.name, { input, spec, holder });
    wrapper.append(holder);
  }

  return {
    node: wrapper,
    inputs,
    values() {
      const out = {};
      for (const [name, { input, spec }] of inputs) {
        if (spec.type === 'checkbox') out[name] = input.querySelector('input').checked ? 1 : 0;
        else if (spec.type === 'number') out[name] = input.value === '' ? null : Number(input.value);
        else out[name] = input.value === '' ? null : input.value;
      }
      return out;
    },
    validate() {
      let ok = true;
      for (const [, { input, spec, holder }] of inputs) {
        holder.classList.remove('error');
        holder.querySelector('.error-text')?.remove();
        if (!spec.required) continue;
        const raw = spec.type === 'checkbox' ? true : input.value;
        if (raw === '' || raw === null) {
          ok = false;
          holder.classList.add('error');
          holder.append(h('span', { class: 'error-text' }, t('required')));
        }
      }
      return ok;
    },
    setErrors(details = []) {
      for (const detail of details) {
        const entry = inputs.get(detail.path);
        if (!entry) continue;
        entry.holder.classList.add('error');
        entry.holder.append(h('span', { class: 'error-text' }, detail.message));
      }
    },
  };
}

// ------------------------------------------------------------------ tables

/**
 * columns: [{ key, label, type, render(row), align, width, class }]
 */
export function dataTable({ columns, rows, onRowClick, footer, emptyMessage, rowClass }) {
  if (!rows?.length) {
    return h('div', { class: 'empty' },
      h('span', { class: 'ico' }, '◍'),
      h('div', {}, emptyMessage || t('noResults')));
  }

  const head = h('tr', {}, columns.map((c) => h('th', {
    class: `${c.align === 'end' || c.type === 'money' || c.type === 'number' ? 'num' : ''} ${c.class || ''}`,
    style: c.width ? { width: c.width } : undefined,
  }, c.label)));

  const body = rows.map((row, index) => {
    const tr = h('tr', {
      class: `${onRowClick ? 'clickable' : ''} ${rowClass ? rowClass(row) : ''}`,
      onclick: onRowClick ? (event) => {
        if (event.target.closest('button, a, input, select')) return;
        onRowClick(row, index);
      } : undefined,
    }, columns.map((c) => {
      const isNumeric = c.align === 'end' || c.type === 'money' || c.type === 'number';
      const content = c.render ? c.render(row, index) : row[c.key];
      return h('td', { class: `${isNumeric ? 'num' : ''} ${c.class || ''}` },
        content instanceof Node ? content : (content ?? '—'));
    }));
    return tr;
  });

  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('thead', {}, head),
      h('tbody', {}, body),
      footer ? h('tfoot', {}, footer) : null));
}

/**
 * "Why is this row here?"
 *
 * A document list can now be found by what is inside it — type a barcode on
 * the Sales screen and you get the invoices that sold that item. A row that
 * came back for that reason has to say so, or the list looks like it is
 * ignoring what was typed. The server marks each row (`search_match`) and
 * names the line that answered; this renders that, and renders nothing at all
 * when the document itself was the match.
 */
export function matchNote(row) {
  if (!row || row.search_match !== 'line') return null;
  const name = pick(row, 'search_match_name');
  const parts = [name, row.search_match_sku].filter(Boolean);
  if (!parts.length) return null;
  return h('small', { class: 'muted' }, `↳ ${t('containsItem')}: ${parts.join(' · ')}`);
}

export function pager({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) {
    return h('div', { class: 'pager' }, `${total ?? 0} ${t('results')}`);
  }
  return h('div', { class: 'pager' },
    h('span', {}, `${total} ${t('results')}`),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn sm', disabled: page <= 1, onclick: () => onPage(page - 1) }, `‹ ${t('previous')}`),
    h('span', {}, `${t('page')} ${page} ${t('of')} ${pages}`),
    h('button', { class: 'btn sm', disabled: page >= pages, onclick: () => onPage(page + 1) }, `${t('next')} ›`));
}

export const tag = (label, kind = '') => h('span', { class: `tag ${kind}` }, label);

export const statusTag = (status) => {
  const map = {
    draft: '', ordered: 'info', partially_received: 'warn', received: 'ok', completed: 'ok',
    cancelled: 'danger', void: 'danger', posted: 'ok', paid: 'ok', partial: 'warn', unpaid: 'danger',
    // web orders: pending is the one that needs somebody to act, and the two
    // unhappy endings read differently — cancelled is a decision, not received
    // is a delivery that failed.
    pending: 'warn', accepted: 'info', out_for_delivery: 'info',
    delivered: 'ok', not_received: 'danger',
  };
  return tag(t(camel(status), status.replace(/_/g, ' ')), map[status] ?? '');
};

const camel = (value) => String(value).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function spinner(message) {
  return h('div', { class: 'empty' }, message || t('loading'));
}

/** Renders a node into the hidden print area and opens the print dialog. */
export function printNode(node) {
  const root = document.getElementById('print-root');
  mount(root, node);
  setTimeout(() => {
    window.print();
    setTimeout(() => clear(root), 800);
  }, 120);
}

/** Debounce helper for search boxes. */
export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
