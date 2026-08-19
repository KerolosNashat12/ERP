/** Application shell: session bootstrap, navigation, routing, global scanner. */
import api, { onUnauthorized } from './core/api.js';
import { h, mount, toast, toastError, modal } from './core/ui.js';
import { t, setLanguage, getLanguage, pick } from './core/i18n.js';
import { session, can, loadSession, clearSession, badges, refreshBadges, setTenant, setBranding } from './core/store.js';
import { defineRoutes, startRouter, navigate } from './core/router.js';
import { startScanner, onScan, triggerScan } from './core/scanner.js';
import { shopMark, applyShopIdentity } from './core/brand.js';

import { renderLogin, promptPasswordChange } from './views/auth.js';
import { dashboardView } from './views/dashboard.js';
import { posView } from './views/pos.js';
import { productsView } from './views/catalog.js';
import { suppliersView, brandsView, categoriesView, customersView, attributesView } from './views/masterData.js';
import { inventoryView, movementsView, adjustmentsView } from './views/inventory.js';
import { purchasesView } from './views/purchasing.js';
import { salesView } from './views/sales.js';
import { webOrdersView } from './views/webOrders.js';
import { returnsView } from './views/returns.js';
import { promotionsView } from './views/promotions.js';
import { reportsView } from './views/reports.js';
import { usersView, auditView, settingsView } from './views/admin.js';
import { labelsView } from './views/labels.js';

const appRoot = document.getElementById('app');

/** Navigation model — a single list drives the sidebar and the permission gate. */
const NAV = [
  {
    group: 'navOperations',
    items: [
      { path: 'dashboard', label: 'dashboard', icon: '◱', permission: 'dashboard.view' },
      { path: 'pos', label: 'pos', icon: '▤', permission: 'sales.create' },
      { path: 'sales', label: 'sales', icon: '₪', permission: 'sales.view' },
      { path: 'returns', label: 'returns', icon: '↩', permission: 'sales.view' },
      {
        path: 'web-orders',
        label: 'webOrders',
        icon: '⛟',
        permission: 'weborders.view',
        badge: 'pendingWebOrders',
        // Nothing to confirm without a storefront to place an order on —
        // the one nav entry tied to the website switch, not just a module.
        requiresWebsite: true,
      },
      { path: 'customers', label: 'customers', icon: '☺', permission: 'customers.view' },
    ],
  },
  {
    group: 'navCatalogue',
    items: [
      { path: 'products', label: 'products', icon: '❑', permission: 'products.view' },
      { path: 'brands', label: 'brands', icon: '◈', permission: 'brands.view' },
      { path: 'categories', label: 'categories', icon: '☰', permission: 'categories.view' },
      { path: 'attributes', label: 'attributes', icon: '⚙', permission: 'attributes.view' },
      { path: 'labels', label: 'labels', icon: '▩', permission: 'labels.view' },
    ],
  },
  {
    group: 'inventory',
    items: [
      { path: 'inventory', label: 'stockOnHand', icon: '▥', permission: 'inventory.view' },
      { path: 'movements', label: 'movements', icon: '⇄', permission: 'inventory.view' },
      { path: 'adjustments', label: 'adjustments', icon: '✓', permission: 'inventory.view' },
    ],
  },
  {
    group: 'navPurchasing',
    items: [
      { path: 'purchases', label: 'purchases', icon: '⇩', permission: 'purchases.view' },
      { path: 'suppliers', label: 'suppliers', icon: '⌂', permission: 'suppliers.view' },
    ],
  },
  {
    group: 'navInsight',
    items: [
      { path: 'promotions', label: 'promotions', icon: '%', permission: 'promotions.view' },
      { path: 'reports', label: 'reports', icon: '▦', permission: 'reports.view' },
    ],
  },
  {
    group: 'navSystem',
    items: [
      { path: 'users', label: 'users', icon: '☷', permission: 'users.view', badge: 'pendingResets' },
      { path: 'audit', label: 'audit', icon: '⎗', permission: 'audit.view' },
      { path: 'settings', label: 'settings', icon: '✦', permission: 'settings.view' },
    ],
  },
];

/**
 * `null` in single-shop mode — every module and the website are effectively
 * on then, since there is no plan restricting them. This is UI politeness
 * only: the server enforces the same rule inside `requirePermission` and the
 * `/api/shop/*` gate, so hiding a nav entry here can never be the only thing
 * standing between a tenant and a module it does not have.
 */
let tenantInfo = null;

async function loadTenantInfo() {
  try {
    const { tenant, branding } = await api.get('/api/session');
    tenantInfo = tenant;
    setTenant(tenant);
    // Unauthenticated on purpose (see the route): the sidebar, the tab and the
    // login screen all need the shop's mark before anyone has signed in.
    setBranding(branding);
    applyShopIdentity(tenant?.name);
  } catch {
    tenantInfo = null;
  }
}

const moduleEnabled = (permission) => !tenantInfo || tenantInfo.modules.includes(permission.split('.')[0]);
const websiteOn = () => !tenantInfo || tenantInfo.websiteEnabled !== false;
const navItemVisible = (item) => can(item.permission) && moduleEnabled(item.permission)
  && (!item.requiresWebsite || websiteOn());

const ROUTE_PERMISSIONS = {
  dashboard: 'dashboard.view', pos: 'sales.create', sales: 'sales.view', returns: 'sales.view',
  'web-orders': 'weborders.view',
  products: 'products.view', brands: 'brands.view', categories: 'categories.view',
  attributes: 'attributes.view', labels: 'labels.view', inventory: 'inventory.view',
  movements: 'inventory.view', adjustments: 'inventory.view',
  purchases: 'purchases.view', suppliers: 'suppliers.view', customers: 'customers.view',
  promotions: 'promotions.view', reports: 'reports.view', users: 'users.view',
  audit: 'audit.view', settings: 'settings.view',
};

// ------------------------------------------------------------------- shell

function buildShell() {
  const content = h('div', { class: 'content' });

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      shopMark(),
      h('div', { class: 'sidebar-brand-text' },
        h('div', { class: 'name' }, companyName()),
        h('div', { class: 'sub' }, 'ERP v1.0'))),
    h('nav', { class: 'nav', id: 'nav' }));

  const scanBox = h('div', { class: 'topbar-scan' },
    h('span', { class: 'ico' }, '⌗'),
    h('input', {
      placeholder: t('scanPrompt'),
      dataset: { scanTarget: 'true' },
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = event.target.value.trim();
        if (!value) return;
        event.target.value = '';
        triggerScan(value);
      },
    }));

  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'btn ghost menu-toggle', onclick: () => sidebar.classList.toggle('open') }, '☰'),
    h('h1', { id: 'page-title' }, t('dashboard')),
    h('span', { class: 'spacer' }),
    scanBox,
    h('button', {
      class: 'btn ghost sm',
      title: t('language'),
      onclick: async () => {
        const next = getLanguage() === 'en' ? 'ar' : 'en';
        setLanguage(next);
        try { await api.put('/api/auth/preferences', { language: next }); } catch { /* preference is local anyway */ }
        window.location.reload();
      },
    }, getLanguage() === 'en' ? 'ع' : 'EN'),
    userChip());

  mount(appRoot, h('div', { class: 'shell' }, sidebar, h('main', { class: 'main' }, topbar, content)));
  appRoot.classList.remove('app-loading');
  renderNav();
  return content;
}

function userChip() {
  const chip = h('button', { class: 'user-chip' },
    h('span', { class: 'avatar' }, initials(session.user.fullName)),
    h('span', { class: 'who' },
      h('strong', {}, session.user.fullName.split(' ')[0]),
      h('small', {}, pick(session.user.role, 'name') || session.user.role?.code || '')));

  chip.addEventListener('click', () => {
    const dialog = modal({
      title: session.user.fullName,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' },
          `${session.user.username} · ${pick(session.user.role, 'name')}`),
        h('div', { class: 'muted small' }, `${session.user.permissions.length} ${t('permissions')}`),
        h('button', {
          class: 'btn block',
          onclick: async () => { dialog.close(); await promptPasswordChange(); },
        }, t('changePassword')),
        h('button', {
          class: 'btn block danger',
          onclick: async () => {
            try { await api.post('/api/auth/logout', {}); } finally {
              clearSession();
              dialog.close();
              boot();
            }
          },
        }, t('logout'))),
    });
  });
  return chip;
}

const companyName = () => (getLanguage() === 'ar'
  ? (session.settings['company.name_ar'] || session.settings['company.name'])
  : (session.settings['company.name'] || t('appName')));

const initials = (name) => String(name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const current = window.location.hash.replace(/^#\/?/, '').split('/')[0].split('?')[0] || 'dashboard';
  mount(nav, ...NAV.flatMap((section) => {
    const items = section.items.filter(navItemVisible);
    if (!items.length) return [];
    return [
      h('div', { class: 'nav-group' }, t(section.group)),
      ...items.map((item) => {
        const count = item.badge ? badges[item.badge] : 0;
        return h('a', {
          href: `#/${item.path}`,
          class: current === item.path ? 'active' : '',
          onclick: () => document.getElementById('sidebar')?.classList.remove('open'),
        },
        h('span', { class: 'ico' }, item.icon),
        t(item.label),
        count ? h('span', { class: 'badge', title: t(item.badge) }, count) : null);
      }),
    ];
  }));
}

// ------------------------------------------------------------------- boot

async function boot() {
  // Unauthenticated and cheap — needed before the very first render of the
  // sidebar, on both the login path and the already-signed-in path below.
  await loadTenantInfo();
  try {
    await loadSession();
  } catch {
    renderLogin(appRoot, async () => {
      await loadSession();
      if (session.user.language && session.user.language !== getLanguage()) {
        setLanguage(session.user.language);
      }
      await startApp();
    });
    appRoot.classList.remove('app-loading');
    return;
  }
  await startApp();
}

async function startApp() {
  // The tenant row named the shop before sign-in; its own settings name it
  // better, and they have arrived by now.
  applyShopIdentity(tenantInfo?.name);
  const content = buildShell();

  defineRoutes({
    dashboard: dashboardView,
    pos: posView,
    sales: salesView,
    returns: returnsView,
    'web-orders': webOrdersView,
    products: productsView,
    brands: brandsView,
    categories: categoriesView,
    attributes: attributesView,
    labels: labelsView,
    inventory: inventoryView,
    movements: movementsView,
    adjustments: adjustmentsView,
    purchases: purchasesView,
    suppliers: suppliersView,
    customers: customersView,
    promotions: promotionsView,
    reports: reportsView,
    users: usersView,
    audit: auditView,
    settings: settingsView,
  }, {
    notFound: (host) => mount(host, h('div', { class: 'empty' }, t('noResults'))),
    beforeEach: (route) => {
      const required = ROUTE_PERMISSIONS[route.path];
      const navItem = NAV.flatMap((s) => s.items).find((i) => i.path === route.path);
      const allowed = !required || (navItem ? navItemVisible(navItem) : can(required));
      if (!allowed) {
        toast(t('somethingWrong'), 'error');
        navigate(firstAllowedRoute(), true);
        return false;
      }
      return true;
    },
  });

  window.addEventListener('route:changed', (event) => {
    renderNav();
    const item = NAV.flatMap((s) => s.items).find((i) => i.path === event.detail.path);
    const title = document.getElementById('page-title');
    if (title) title.textContent = item ? t(item.label) : t('dashboard');
  });

  // Pending password resets are the one thing an admin has to notice without
  // opening the screen, so the counter is fetched as soon as the shell is up.
  refreshBadges();

  if (!window.location.hash || window.location.hash === '#/') {
    navigate(firstAllowedRoute(), true);
  }
  await startRouter(content);

  // A scan from anywhere jumps to the product it identifies.
  onScan(async (code) => {
    if (window.location.hash.startsWith('#/pos')) return;
    if (document.querySelector('.pos-search input[data-scan-target]')) return;
    // The product editor consumes scans itself — there a scan is a code being
    // entered, not a product being looked up.
    if (/^#\/products\/(new|\d+\/edit)\b/.test(window.location.hash)) return;
    try {
      const variant = await api.get(`/api/products/scan/${encodeURIComponent(code)}`);
      if (can('products.view')) navigate(`products/${variant.product_id}`);
      toast(`${variant.sku} — ${variant.product_name_en}`, 'ok');
    } catch {
      toast(`${t('noResults')}: ${code}`, 'warn');
    }
  });

  if (session.user.mustChangePassword) {
    await promptPasswordChange({ forced: true });
    await loadSession();
  }
}

function firstAllowedRoute() {
  for (const section of NAV) {
    for (const item of section.items) if (navItemVisible(item)) return item.path;
  }
  return 'dashboard';
}

window.addEventListener('badges:changed', renderNav);

onUnauthorized(() => {
  clearSession();
  renderLogin(appRoot, async () => {
    await loadSession();
    await startApp();
  });
});

startScanner();
boot().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  toastError(error);
});
