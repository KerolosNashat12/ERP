/**
 * Form fields.
 *
 * Validation is done here rather than left to the browser because the built-in
 * bubble appears in the browser's language, not the shop's — an Arabic
 * storefront popping up "Please fill out this field" in English is exactly the
 * kind of seam that makes a small shop look untrustworthy at the moment the
 * customer is deciding whether to hand over their address.
 */
import { el } from '../core/dom.js';
import { t } from '../core/i18n.js';

let sequence = 0;

export function field({
  name, label, type = 'text', required = false, hint = null,
  placeholder = '', autocomplete = null, rows = 0, inputmode = null, value = '',
}) {
  const id = `f-${name}-${(sequence += 1)}`;
  const error = el('p.field-error', { id: `${id}-error`, hidden: true });

  const control = rows
    ? el('textarea.input', { id, name, rows, placeholder, value })
    : el('input.input', { id, name, type, placeholder, value });
  if (autocomplete) control.setAttribute('autocomplete', autocomplete);
  if (inputmode) control.setAttribute('inputmode', inputmode);
  if (required) control.setAttribute('aria-required', 'true');
  control.setAttribute('aria-describedby', `${id}-error`);

  const wrapper = el('div.field',
    el('label.field-label', { for: id },
      label,
      !required && el('span.field-optional', `(${t('optional')})`)),
    control,
    hint && el('p.field-hint', hint),
    error);

  return {
    node: wrapper,
    control,
    get value() { return control.value.trim(); },
    setError(message) {
      error.textContent = message || '';
      error.hidden = !message;
      wrapper.classList.toggle('has-error', Boolean(message));
      control.setAttribute('aria-invalid', message ? 'true' : 'false');
    },
    focus() { control.focus(); },
  };
}

/**
 * Validate a set of fields, mark every failure at once, and put the cursor in
 * the first one. Stopping at the first error makes a customer fix a long form
 * one round trip at a time.
 */
export function validate(checks) {
  let first = null;
  for (const { field: entry, test, message } of checks) {
    const failed = !test(entry.value);
    entry.setError(failed ? message : null);
    if (failed && !first) first = entry;
  }
  if (first) first.focus();
  return !first;
}

export const notEmpty = (value) => value.length > 0;
/** Six digits is the server's floor; anything shorter is a typo, not a phone. */
export const looksLikePhone = (value) => value.replace(/[^\d]/g, '').length >= 6;

/**
 * Email is optional, so blank passes. When it is filled in, it is checked here
 * rather than left to the server — a 400 written in English is not a message an
 * Arabic-speaking customer should meet at the last step of a checkout.
 */
export const looksLikeEmailOrBlank = (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
