/** Platform sign-in — a separate world from any shop's login. */
import api from '../core/api.js';
import { h, field, mount, textInput } from '../core/dom.js';
import { t, setLanguage, getLanguage } from '../core/i18n.js';

const EYE_SHOW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1.8 12S5.4 5.4 12 5.4 22.2 12 22.2 12 18.6 18.6 12 18.6 1.8 12 1.8 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_HIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.4c6.6 0 10.2 6.6 10.2 6.6a18 18 0 0 1-3.4 4.3M6.2 7.7A18 18 0 0 0 1.8 12S5.4 18.6 12 18.6c1.8 0 3.4-.5 4.7-1.2"/><path d="M10 10a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';

function withPasswordToggle(input) {
  const wrapper = h('div', { class: 'pw-field' });
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

export function renderLogin(root, onSuccess) {
  const usernameInput = textInput({ name: 'username', autocomplete: 'username', autofocus: true });
  const passwordInput = h('input', {
    class: 'input', type: 'password', name: 'password', autocomplete: 'current-password',
  });
  const button = h('button', { class: 'btn primary block lg', type: 'submit' }, t('signIn'));
  const errorBox = h('div', { class: 'error-text', style: { minHeight: '16px' } });

  const form = h('form', {
    class: 'stack',
    onsubmit: async (event) => {
      event.preventDefault();
      errorBox.textContent = '';
      button.disabled = true;
      button.textContent = t('signingIn');
      try {
        // Wrong password and unknown username answer with the exact same
        // message and status — the form must never distinguish them either.
        const result = await api.post('/auth/login', {
          username: usernameInput.value.trim(),
          password: passwordInput.value,
        }, { isLogin: true });
        onSuccess(result.user);
      } catch (error) {
        errorBox.textContent = error.status === 401 ? t('invalidCredentials') : (error.message || t('somethingWrong'));
        passwordInput.value = '';
        passwordInput.focus();
      } finally {
        button.disabled = false;
        button.textContent = t('signIn');
      }
    },
  },
  field({ label: t('username'), input: usernameInput }),
  field({ label: t('password'), input: withPasswordToggle(passwordInput) }),
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
          h('h1', {}, 'M', h('span', { class: 'gold' }, '&'), 'M', h('span', { class: 'gold' }, ' · Platform')),
          h('p', { class: 'tag' }, t('platformTag')),
          h('ul', {},
            h('li', {}, t('tenants') + ' · ' + t('newTenant')),
            h('li', {}, t('modules') + ' · ' + t('website') + ' · ' + t('maxUsers')),
            h('li', {}, t('suspendTenant') + ' · ' + t('resumeTenant')),
            h('li', {}, t('migrations')))),
        h('div', { class: 'small', style: { color: 'var(--ink-3)' } }, t('versionTag'))),
      h('main', { class: 'login-main' },
        h('div', { class: 'login-card' },
          languageToggle,
          h('h2', { style: { marginTop: '18px' } }, t('welcome')),
          h('p', { class: 'muted' }, t('signInSubtitle')),
          form))));
}
