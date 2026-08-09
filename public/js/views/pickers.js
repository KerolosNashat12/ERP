/** Shared item picker used by purchase orders, transfers, counts and labels. */
import api from '../core/api.js';
import { h, mount, textInput, debounce, toast } from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number } from '../core/format.js';
import { onScan } from '../core/scanner.js';

/**
 * Renders a search box that calls `onPick(variant)` for each chosen item.
 * Also listens for hardware scans while it is on screen.
 * @returns {{node: HTMLElement, destroy: Function}}
 */
export function variantPicker({ onPick, placeholder }) {
  const results = h('div');

  const input = textInput({
    placeholder: placeholder || t('scanPrompt'),
    dataset: { scanTarget: 'true' },
    autocomplete: 'off',
    oninput: debounce((event) => search(event.target.value), 220),
    onkeydown: (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      pickByCode(input.value.trim());
    },
  });

  async function pickByCode(code) {
    if (!code) return;
    try {
      const variant = await api.get(`/api/products/scan/${encodeURIComponent(code)}`);
      onPick(variant);
      input.value = '';
      mount(results);
    } catch {
      search(code);
    }
  }

  async function search(term) {
    if (!term || term.length < 2) { mount(results); return; }
    const { rows } = await api.get('/api/products/lookup', { q: term });
    if (!rows.length) { mount(results, h('div', { class: 'pos-results' }, h('div', { class: 'empty' }, t('noResults')))); return; }
    mount(results, h('div', { class: 'pos-results' }, rows.map((row) => h('div', {
      class: 'pos-result',
      onclick: () => { onPick(row); input.value = ''; mount(results); },
    },
    h('div', { class: 'meta' },
      h('div', { class: 'name' }, `${pick(row, 'product_name')} — ${row.variant_label || ''}`),
      h('small', { class: 'mono' }, row.sku)),
    h('div', { class: 'right small' },
      h('div', {}, money(row.selling_price)),
      h('small', { class: 'muted' }, `${number(row.quantity || 0)} ${t('inStock')}`))))));
  }

  const unsubscribe = onScan((code) => pickByCode(code));

  return {
    node: h('div', { class: 'pos-search' }, input, results),
    input,
    destroy: () => unsubscribe(),
  };
}

/** Small helper for line-editing tables. */
export const lineNumber = (line, key, onChange, width = '90px', step = 'any') =>
  h('input', {
    class: 'input', type: 'number', step, value: line[key], style: { width },
    onchange: (event) => {
      line[key] = event.target.value === '' ? 0 : Number(event.target.value);
      onChange();
    },
  });

export function requireLines(lines) {
  if (!lines.length) {
    toast(t('addLine'), 'warn');
    return false;
  }
  return true;
}
