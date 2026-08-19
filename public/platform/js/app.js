/** Platform dashboard shell: session bootstrap, top nav, routing. */
import api, { onUnauthorized } from './core/api.js';
import { h, mount, modal } from './core/dom.js';
import { t, setLanguage, getLanguage } from './core/i18n.js';
import { defineRoutes, startRouter, navigate, parseHash } from './core/router.js';

import { renderLogin, renderSetup } from './views/login.js';
import { tenantsView } from './views/tenantList.js';
import { tenantDetailView } from './views/tenantDetail.js';
import { migrateView } from './views/migrate.js';

const appRoot = document.getElementById('app');
let currentUser = null;

const TABS = [
  { path: 'tenants', label: 'tenants' },
  { path: 'migrate', label: 'migrations' },
];

// A slug is arbitrary text, so it can't live in the static route map the way
// `migrate` does — `tenants` alone already means the list; a second hash
// segment (`tenants/mm`) means the detail view. Same one-router-call
// pattern as the ERP's own `products/:id` dispatch.
defineRoutes({
  tenants: (host, route) => (route.segments[1] ? tenantDetailView(host, route) : tenantsView(host, route)),
  migrate: migrateView,
}, {
  notFound: (host) => mount(host, h('div', { class: 'empty' }, t('noResults'))),
});

function buildShell() {
  const content = h('div', { class: 'content' });
  const tabsHost = h('nav', { class: 'topbar-tabs', id: 'platform-tabs' });

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('span', { class: 'mark' }, 'M&M'),
      h('div', {},
        h('div', { class: 'name' }, t('platformName')),
        h('div', { class: 'sub' }, t('versionTag')))),
    tabsHost,
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn ghost sm',
      title: t('language'),
      onclick: () => {
        setLanguage(getLanguage() === 'en' ? 'ar' : 'en');
        window.location.reload();
      },
    }, getLanguage() === 'en' ? 'ع' : 'EN'),
    userChip());

  mount(appRoot, h('div', { class: 'shell' }, topbar, h('main', {}, content)));
  appRoot.classList.remove('app-loading');
  renderTabs();
  return content;
}

function renderTabs() {
  const host = document.getElementById('platform-tabs');
  if (!host) return;
  const current = parseHash().path;
  mount(host, ...TABS.map((tab) => h('a', {
    href: `#/${tab.path}`,
    class: current === tab.path ? 'active' : '',
  }, t(tab.label))));
}

function userChip() {
  const chip = h('button', { class: 'user-chip' },
    h('span', { class: 'avatar' }, initials(currentUser.fullName || currentUser.username)),
    h('span', { class: 'who' }, currentUser.fullName || currentUser.username));

  chip.addEventListener('click', () => {
    const dialog = modal({
      title: currentUser.fullName || currentUser.username,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, `@${currentUser.username}`),
        h('button', {
          class: 'btn block danger',
          onclick: async () => {
            try { await api.post('/auth/logout', {}); } finally {
              dialog.close();
              boot();
            }
          },
        }, t('signOut'))),
    });
  });
  return chip;
}

const initials = (name) => String(name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

async function boot() {
  try {
    const { user } = await api.get('/auth/me');
    currentUser = user;
  } catch {
    // A console with no owner yet asks for one to be made rather than for a
    // password that does not exist — the difference between a first run that
    // explains itself and one that looks broken.
    let needsSetup = false;
    try {
      ({ needsSetup } = await api.get('/auth/state'));
    } catch {
      // If even that cannot be reached, the sign-in form is the safer guess.
    }
    const onReady = async (user) => {
      currentUser = user;
      await startApp();
    };
    if (needsSetup) renderSetup(appRoot, onReady);
    else renderLogin(appRoot, onReady);
    appRoot.classList.remove('app-loading');
    return;
  }
  await startApp();
}

async function startApp() {
  const content = buildShell();
  window.addEventListener('route:changed', renderTabs);
  if (!window.location.hash || window.location.hash === '#/') navigate('tenants', true);
  await startRouter(content);
}

onUnauthorized(() => {
  currentUser = null;
  renderLogin(appRoot, async (user) => {
    currentUser = user;
    await startApp();
  });
});

boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
});
