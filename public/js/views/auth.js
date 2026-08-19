/** Sign-in screen and the forced password change on first login. */
import api from '../core/api.js';
import { h, frag, mount, field, textInput, toast, toastError, modal, buildForm } from '../core/ui.js';
import { t, setLanguage, getLanguage } from '../core/i18n.js';
import { shopMark } from '../core/brand.js';

const EYE_SHOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1.8 12S5.4 5.4 12 5.4 22.2 12 22.2 12 18.6 18.6 12 18.6 1.8 12 1.8 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_HIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.4c6.6 0 10.2 6.6 10.2 6.6a18 18 0 0 1-3.4 4.3M6.2 7.7A18 18 0 0 0 1.8 12S5.4 18.6 12 18.6c1.8 0 3.4-.5 4.7-1.2"/><path d="M10 10a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

/**
 * Wraps a password input in a relative box with an eye button that flips the
 * input between `password` and `text`. The button sits on the inline-end edge,
 * so it follows the text direction in Arabic without extra work.
 */
function withPasswordToggle(input) {
  const wrapper = h('div', { class: 'pw-field' });
  if (input.parentNode) input.replaceWith(wrapper);

  const button = h('button', {
    class: 'pw-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': t('showPassword'),
    title: t('showPassword'),
    html: EYE_SHOW,
    onclick: () => {
      const revealed = input.type === 'password';
      input.type = revealed ? 'text' : 'password';
      const label = revealed ? t('hidePassword') : t('showPassword');
      button.setAttribute('aria-pressed', revealed ? 'true' : 'false');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML = revealed ? EYE_HIDE : EYE_SHOW;
      input.focus();
    },
  });

  wrapper.append(input, button);
  return wrapper;
}

/** Adds the eye toggle to every password input of a buildForm() form. */
function addPasswordToggles(form) {
  for (const [, entry] of form.inputs) {
    if (entry.spec.type === 'password') withPasswordToggle(entry.input);
  }
}

/**
 * Reset requests are approved by an administrator in person — there is no mail
 * server. The endpoint answers the same way for unknown usernames on purpose,
 * so this dialog shows one confirmation regardless of what came back.
 */
function openForgotPassword(prefillUsername = '') {
  const form = buildForm([
    { name: 'username', label: t('username'), required: true, span: 2 },
    { name: 'note', label: t('forgotNote'), type: 'textarea', span: 2 },
  ], { username: prefillUsername }, { columns: 2 });

  const submit = h('button', { class: 'btn primary' }, t('requestReset'));
  submit.addEventListener('click', async () => {
    if (!form.validate()) return;
    const values = form.values();
    submit.disabled = true;
    try {
      const result = await api.post('/api/auth/forgot-password', {
        username: String(values.username || '').trim(),
        note: values.note || null,
      });
      dialog.close();
      toast(result?.alreadyPending ? t('resetAlreadyPending') : t('resetRequested'));
    } catch (error) {
      toastError(error);
      submit.disabled = false;
    }
  });

  const dialog = modal({
    title: t('forgotTitle'),
    size: 'narrow',
    body: frag(
      h('p', { class: 'muted', style: { marginTop: 0 } }, t('forgotIntro')),
      form.node),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      submit,
    ],
  });
  return dialog;
}

export function renderLogin(root, onSuccess) {
  const usernameInput = textInput({ name: 'username', autocomplete: 'username', autofocus: true });
  const passwordInput = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password' });
  const button = h('button', { class: 'btn primary block lg', type: 'submit' }, t('login'));
  const errorBox = h('div', { class: 'error-text', style: { minHeight: '16px' } });

  const form = h('form', {
    class: 'stack',
    onsubmit: async (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      button.disabled = true;
      button.textContent = t('signingIn');
      try {
        const result = await api.post('/api/auth/login', {
          username: usernameInput.value.trim(),
          password: passwordInput.value,
        });
        onSuccess(result.user);
      } catch (error) {
        errorBox.textContent = error.message;
        passwordInput.value = '';
        passwordInput.focus();
      } finally {
        button.disabled = false;
        button.textContent = t('login');
      }
    },
  },
  field({ label: t('username'), input: usernameInput }),
  field({ label: t('password'), input: withPasswordToggle(passwordInput) }),
  errorBox,
  button,
  h('div', { class: 'login-forgot' },
    h('button', {
      class: 'link-btn',
      type: 'button',
      onclick: () => openForgotPassword(usernameInput.value.trim()),
    }, t('forgotPassword'))));

  const languageToggle = h('div', { class: 'row', style: { gap: '6px' } },
    ...['en', 'ar'].map((lang) => h('button', {
      class: `btn sm ${getLanguage() === lang ? 'primary' : ''}`,
      type: 'button',
      onclick: () => { setLanguage(lang); window.location.reload(); },
    }, lang === 'en' ? 'English' : 'العربية')));

  mount(root,
    h('div', { class: 'login-page' },
      h('aside', { class: 'login-aside' },
        h('div', {},
          // The shop's own mark, not the platform's: whoever is signing in
          // works for one shop, and `/api/session` has already said which.
          h('div', { class: 'login-mark' }, shopMark({ className: 'mark', logoClass: 'mark-logo' })),
          h('p', { style: { color: '#9fb0c8', marginTop: '2px' } }, t('appTag')),
          h('ul', {},
            h('li', {}, t('products') + ' · ' + t('variants') + ' · ' + t('barcode')),
            h('li', {}, t('inventory') + ' · ' + t('transfers') + ' · ' + t('adjustments')),
            h('li', {}, t('pos') + ' · ' + t('promotions') + ' · ' + t('returns')),
            h('li', {}, t('purchases') + ' · ' + t('suppliers') + ' · ' + t('reports')),
            h('li', {}, t('users') + ' · ' + t('audit')))),
        h('div', { class: 'small', style: { color: '#7d8ca6' } }, 'v1.0 · Offline-first')),
      h('main', { class: 'login-main' },
        h('div', { class: 'login-card' },
          languageToggle,
          h('h2', { style: { marginTop: '18px' } }, t('welcomeBack')),
          h('p', { class: 'muted' }, t('loginSubtitle')),
          form))));
}

/** Shown when a user must set their own password (first login). */
export function promptPasswordChange({ forced = false } = {}) {
  return new Promise((resolve) => {
    const form = buildForm([
      { name: 'currentPassword', label: t('currentPassword'), type: 'password', required: true, span: 2 },
      { name: 'newPassword', label: t('newPassword'), type: 'password', required: true, span: 2 },
      { name: 'confirmPassword', label: t('newPassword') + ' *', type: 'password', required: true, span: 2 },
    ], {}, { columns: 2 });
    addPasswordToggles(form);

    const dialog = modal({
      title: t('changePassword'),
      size: 'narrow',
      closeOnBackdrop: !forced,
      body: form.node,
      footer: [
        forced ? null : h('button', { class: 'btn', onclick: () => { dialog.close(); resolve(false); } }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            const values = form.values();
            if (values.newPassword !== values.confirmPassword) {
              toast(t('somethingWrong') + ': passwords do not match', 'error');
              return;
            }
            try {
              await api.post('/api/auth/password', {
                currentPassword: values.currentPassword,
                newPassword: values.newPassword,
              });
              toast(t('saved'));
              dialog.close();
              resolve(true);
            } catch (error) { toastError(error); }
          },
        }, t('save')),
      ],
    });
  });
}
