/**
 * KJ Admin shell: session bootstrap, the navigation rail, routing.
 *
 * The rail is the console's frame: 72px, full height, icon only, pinned to the
 * page's INLINE START — which is the physical left in English and the physical
 * right in Arabic. Nothing here measures a side or asks which language is on;
 * `inset-inline-start` and `padding-inline-start` in platform.css do it, so the
 * content area's padding and every shadow mirror with the rail rather than
 * being stranded on the far edge. On a phone the same rail slides out past that
 * same edge and comes back as a drawer.
 */
import api, { onUnauthorized } from './core/api.js';
import { h, mount, confirmDialog } from './core/dom.js';
import { t, setLanguage, getLanguage } from './core/i18n.js';
import { applyDeploymentBanner } from '../../shared/deploymentBanner.js';
import { defineRoutes, startRouter, navigate, parseHash } from './core/router.js';

import { renderLogin, renderSetup } from './views/login.js';
import { overviewView } from './views/overview.js';
import { tenantsView } from './views/tenantList.js';
import { tenantDetailView } from './views/tenantDetail.js';
import { migrateView } from './views/migrate.js';
import { integrationsView } from './views/integrations.js';
import { landingView } from './views/landing.js';
import { state } from './ui/states.js';
import icons from './ui/icons.js';

const appRoot = document.getElementById('app');
let currentUser = null;

const TABS = [
  { path: 'overview', label: 'overview', icon: 'chart' },
  { path: 'tenants', label: 'shops', icon: 'shop' },
  { path: 'migrate', label: 'migrations', icon: 'arrows' },
  // Findable by looking, rather than only reachable from the create-shop form
  // at the moment it is needed — an owner who connected Turso once should be
  // able to see that it is still connected without opening a dialog about
  // something else.
  { path: 'integrations', label: 'integrations', icon: 'sliders' },
  // The public page's own words, prices and pictures. It is the one screen in
  // this console that writes something customers read, so it sits at the
  // bottom of the rail, apart from the fleet's own four.
  { path: 'landing', label: 'landing', icon: 'page' },
];

// A slug is arbitrary text, so it can't live in the static route map the way
// `migrate` does — `tenants` alone already means the list; a second hash
// segment (`tenants/mm`) means the detail view. Same one-router-call
// pattern as the ERP's own `products/:id` dispatch.
defineRoutes({
  overview: overviewView,
  tenants: (host, route) => (route.segments[1] ? tenantDetailView(host, route) : tenantsView(host, route)),
  migrate: migrateView,
  integrations: integrationsView,
  landing: landingView,
}, {
  notFound: (host) => mount(host, state({
    icon: 'search',
    title: t('noResults'),
    message: t('routeNotFound'),
    action: h('a', { class: 'btn', href: '#/overview' }, t('overview')),
  })),
});

function buildShell() {
  const content = h('div', { class: 'content' });
  const navHost = h('nav', { class: 'rail-nav', id: 'platform-nav', 'aria-label': t('platformName') });

  const signOut = h('button', {
    class: 'rail-out',
    type: 'button',
    title: t('signOut'),
    'aria-label': t('signOut'),
    html: icons.signout,
    onclick: async () => {
      // Pinned to the bottom of the rail, and one tap away from a thumb on a
      // phone: it asks first.
      const confirmed = await confirmDialog({
        title: t('signOut'),
        message: t('signOutConfirm'),
        confirmLabel: t('signOut'),
      });
      if (!confirmed) return;
      try { await api.post('/auth/logout', {}); } finally { boot(); }
    },
  });

  const rail = h('aside', { class: 'rail', id: 'platform-rail' },
    h('a', { class: 'rail-mark', href: '#/overview', title: t('platformName') }, 'KJ'),
    navHost,
    h('span', { class: 'spacer' }),
    signOut);

  const scrim = h('button', {
    class: 'rail-scrim',
    type: 'button',
    'aria-label': t('closeMenu'),
    onclick: () => setDrawer(false),
  });

  const toggle = h('button', {
    class: 'nav-toggle',
    type: 'button',
    title: t('menu'),
    'aria-label': t('menu'),
    'aria-expanded': 'false',
    html: icons.menu,
    onclick: () => setDrawer(!rail.classList.contains('open')),
  });

  /**
   * The drawer, on a phone. The scrim only exists while the drawer is open — a
   * full-screen element sitting behind every screen at all times is how a
   * dashboard ends up with a table nobody can tap.
   */
  function setDrawer(open) {
    rail.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) rail.after(scrim);
    else scrim.remove();
  }

  const topbar = h('header', { class: 'topbar' },
    toggle,
    h('div', { class: 'owner' },
      h('span', { class: 'avatar' }, 'KJ'),
      h('span', { class: 'who' }, currentUser.fullName || currentUser.username)),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn ghost sm',
      title: t('language'),
      'aria-label': t('language'),
      onclick: () => {
        setLanguage(getLanguage() === 'en' ? 'ar' : 'en');
        window.location.reload();
      },
    }, getLanguage() === 'en' ? 'العربية' : 'English'),
    h('span', { class: 'role-chip' }, t('ownerRole')),
    h('span', { class: 'version-tag' }, t('versionTag')));

  mount(appRoot, h('div', { class: 'shell' }, rail, topbar, h('main', {}, content)));
  appRoot.classList.remove('app-loading');
  closeDrawer = () => setDrawer(false);
  renderTabs();
  return content;
}

/** Set once the shell exists; the drawer closes on every route change. */
let closeDrawer = () => {};

function renderTabs() {
  const host = document.getElementById('platform-nav');
  if (!host) return;
  const current = parseHash().path;
  mount(host, ...TABS.map((tab) => h('a', {
    href: `#/${tab.path}`,
    class: `rail-link${current === tab.path ? ' active' : ''}`,
    title: t(tab.label),
    'aria-label': t(tab.label),
    'aria-current': current === tab.path ? 'page' : null,
    html: icons[tab.icon],
  })));
}

/**
 * Drawn from whichever of the console's two boot calls answers — `/auth/me`
 * when there is a session, `/auth/state` when there is not. Both carry it, so
 * the frame is on the SIGN-IN screen too, which is precisely where somebody is
 * about to type the owner's password into the wrong deployment.
 */
const showDeployment = (deployment) => applyDeploymentBanner(deployment, {
  label: t('stagingTag'),
  detail: t('stagingHere'),
  lang: getLanguage(),
});

async function boot() {
  try {
    const { user, deployment } = await api.get('/auth/me');
    showDeployment(deployment);
    currentUser = user;
  } catch {
    // A console with no owner yet asks for one to be made rather than for a
    // password that does not exist — the difference between a first run that
    // explains itself and one that looks broken.
    let needsSetup = false;
    try {
      const state = await api.get('/auth/state');
      needsSetup = state.needsSetup;
      showDeployment(state.deployment);
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
  window.addEventListener('route:changed', () => { renderTabs(); closeDrawer(); });
  if (!window.location.hash || window.location.hash === '#/') navigate('overview', true);
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
