/** Sign-in screen and the forced password change on first login. */
import api from '../core/api.js';
import { h, mount, field, textInput, toast, toastError, modal, buildForm } from '../core/ui.js';
import { t, setLanguage, getLanguage } from '../core/i18n.js';

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
  field({ label: t('password'), input: passwordInput }),
  errorBox,
  button);

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
          h('h1', {}, 'M', h('span', { class: 'gold' }, '&'), 'M'),
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
          form,
          h('div', { class: 'login-hint' },
            h('strong', {}, t('demoAccounts')), h('br'),
            h('code', {}, 'admin / admin123'), ' · ',
            h('code', {}, 'manager / manager123'), ' · ',
            h('code', {}, 'cashier / cashier123'))))));
}

/** Shown when a user must set their own password (first login). */
export function promptPasswordChange({ forced = false } = {}) {
  return new Promise((resolve) => {
    const form = buildForm([
      { name: 'currentPassword', label: t('currentPassword'), type: 'password', required: true, span: 2 },
      { name: 'newPassword', label: t('newPassword'), type: 'password', required: true, span: 2 },
      { name: 'confirmPassword', label: t('newPassword') + ' *', type: 'password', required: true, span: 2 },
    ], {}, { columns: 2 });

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
