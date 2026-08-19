/**
 * The one-time admin-password hand-off, shared by tenant creation and
 * password reset. The server never stores this in the clear and never
 * returns it again — this dialog is the only place it will ever exist, so
 * it refuses to close on a stray backdrop click and copying is one tap.
 */
import { h } from '../core/dom.js';
import { modal, toast } from '../core/dom.js';
import { t } from '../core/i18n.js';

export function showOneTimePassword({ slug, adminUsername, adminPassword, headline }) {
  const code = h('div', { class: 'otp-code', dir: 'ltr' }, adminPassword);

  const dialog = modal({
    title: t('oneTimePassword'),
    size: 'narrow',
    closeOnBackdrop: false,
    body: h('div', { class: 'otp-panel' },
      h('p', { class: 'muted small', style: { margin: 0 } }, headline),
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'small muted' }, `${t('tenant')}: `, h('span', { class: 'mono strong' }, slug)),
        h('div', { class: 'small muted' }, `${t('adminAccount')}: `, h('span', { class: 'mono strong' }, adminUsername))),
      code,
      h('div', { class: 'otp-warn' },
        h('span', { class: 'ico' }, '⚠'),
        h('span', {}, t('oneTimePasswordHint')))),
    footer: [
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (await copyText(adminPassword)) { toast(t('copied')); return; }
          selectContents(code);
          toast(t('copyManually'), 'warn', 6000);
        },
      }, t('copyToClipboard')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => dialog.close() }, t('close')),
    ],
  });
  return dialog;
}

/**
 * navigator.clipboard only exists on a secure origin, and this console can
 * run over plain HTTP on a LAN — fall back to the old copy command, and
 * then to simply selecting the text so it can be copied by hand.
 */
async function copyText(value) {
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

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
