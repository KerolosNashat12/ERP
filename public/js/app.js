/** Application shell: session bootstrap, navigation, routing, global scanner. */
import api, { onUnauthorized } from './core/api.js';
import { h, mount, toast, toastError, modal } from './core/ui.js';
import { t, setLanguage, getLanguage, pick } from './core/i18n.js';
import { session, can, loadSession, clearSession, badges, refreshBadges, setTenant, setBranding } from './core/store.js';
import { defineRoutes, startRouter, navigate } from './core/router.js';
import { startScanner, onScan, triggerScan } from './core/scanner.js';
import { shopMark, applyShopIdentity } from './core/brand.js';
import { applyDeploymentBanner } from '../shared/deploymentBanner.js';

import { renderLogin, promptPasswordChange } from './views/auth.js';

/*
 * Every other screen is fetched the first time it is opened, not at sign-in.
 *
 * Statically importing all thirty of them meant a cashier signing in on a
 * phone downloaded reports, payroll, labels, the audit log and the legacy
 * invoice importer before the till could draw - about forty files that most
 * users never open in a day. `screen()` returns a route handler that imports
 * the module on first use and remembers it, so opening a screen twice fetches
 * once, and the browser caches it after that anyway.
 *
 * The router already awaits its handler, so nothing else had to change.
 */
const screen = (load, name = 'default') => {
  let ready = null;
  return (host, route) => {
    if (!ready) ready = load().then((module) => module[name]);
    return ready.then((view) => view(host, route));
  };
};

const appRoot = document.getElementById('app');

/**
 * What the sidebar prints under the shop's name. The build only appears when
 * the server knows one - a shop PC has no commit and should not grow an empty
 * bracket because of it.
 */
let buildInfo = null;
const buildLabel = () => (buildInfo?.commit ? `ERP v1.0 · ${buildInfo.commit}` : 'ERP v1.0');

/** Navigation model — a single list drives the sidebar and the permission gate. */
const NAV = [
  {
    group: 'navOperations',
    items: [
      { path: 'dashboard', label: 'dashboard', icon: '◱', permission: 'dashboard.view' },
      { path: 'pos', label: 'pos', icon: '▤', permission: 'sales.create' },
      { path: 'sales', label: 'sales', icon: '₪', permission: 'sales.view' },
      { path: 'returns', label: 'returns', icon: '↩', permission: 'sales.view' },
      { path: 'exchanges', label: 'exchanges', icon: '⇄', permission: 'sales.view' },
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
      /*
       * الهدر. In المخزون rather than in a group of its own, because a broken
       * bottle is a stock document before it is a money one — and the money it
       * costs is already on the dashboard and in the profit report, which is
       * where a loss is looked FOR rather than looked UP.
       */
      { path: 'wastage', label: 'wastage', icon: '⚠', permission: 'wastage.view' },
    ],
  },
  {
    group: 'navPurchasing',
    items: [
      { path: 'purchases', label: 'purchases', icon: '⇩', permission: 'purchases.view' },
      // Beside the orders, because that is what they are about: what came in on
      // one and went back out again.
      { path: 'supplier-returns', label: 'supplierReturns', icon: '↩', permission: 'purchases.view' },
      { path: 'suppliers', label: 'suppliers', icon: '⌂', permission: 'suppliers.view' },
      /*
       * فواتيرك — the invoices the shop already had ON PAPER. Beside الموردون
       * and أوامر الشراء because that is where he looks for a supplier's
       * paperwork, but its own MODULE (`legacy_invoices`), so a shop whose plan
       * does not include the archive never sees this entry — and, more
       * importantly, so that nothing on it can be mistaken for purchasing: the
       * page itself says, permanently and in his own language, that its
       * amounts are outside the shop's accounts.
       */
      { path: 'legacy-invoices', label: 'legacyInvoices', icon: '❐', permission: 'legacy_invoices.view' },
    ],
  },
  {
    // What the shop spends, and who it pays. Its own group rather than a corner
    // of Purchasing: buying stock and paying the electricity are different
    // acts, sold as different modules, and the owner asked for التكاليف as a
    // page of its own.
    group: 'navMoney',
    items: [
      { path: 'costs', label: 'costs', icon: '⌁', permission: 'costs.view' },
      { path: 'employees', label: 'employees', icon: '☻', permission: 'employees.view' },
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
      /*
       * سلة المهملات, beside the audit log rather than inside any one module:
       * it is the register of what was deleted across all of them, and "who
       * deleted the September invoice" is the same kind of question as "who
       * changed this price".
       */
      { path: 'trash', label: 'trash', icon: '🗑', permission: 'trash.view' },
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
    const { tenant, branding, deployment } = await api.get('/api/session');
    buildInfo = deployment?.build || null;
    tenantInfo = tenant;
    setTenant(tenant);
    /**
     * Which deployment this till is on, before the shell is drawn.
     *
     * On production and on a shop PC this call does nothing at all and removes
     * nothing, because there is nothing there. On staging it paints the hazard
     * frame — outside the layout, un-clickable, no animation — so a cashier
     * cannot mistake a test deployment for the shop they are standing in. It
     * rides on this request rather than making its own: the ERP is not allowed
     * to get slower for it. See public/shared/deploymentBanner.js.
     */
    applyDeploymentBanner(deployment, {
      label: t('stagingTag'),
      detail: t('stagingHere'),
      lang: getLanguage(),
    });
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
  exchanges: 'sales.view',
  'web-orders': 'weborders.view',
  products: 'products.view', brands: 'brands.view', categories: 'categories.view',
  attributes: 'attributes.view', labels: 'labels.view', inventory: 'inventory.view',
  movements: 'inventory.view', adjustments: 'inventory.view', wastage: 'wastage.view',
  purchases: 'purchases.view', 'supplier-returns': 'purchases.view',
  suppliers: 'suppliers.view', customers: 'customers.view',
  costs: 'costs.view', 'cost-categories': 'costs.view', employees: 'employees.view',
  'legacy-invoices': 'legacy_invoices.view',
  promotions: 'promotions.view', reports: 'reports.view', users: 'users.view',
  audit: 'audit.view', trash: 'trash.view', settings: 'settings.view',
};

// ------------------------------------------------------------------- shell

function buildShell() {
  const content = h('div', { class: 'content' });

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      shopMark(),
      h('div', { class: 'sidebar-brand-text' },
        h('div', { class: 'name' }, companyName()),
        /*
         * The build, beside the version.
         *
         * "I published — is it live?" is asked after every release, and until
         * now the only way to answer it was to fetch the JavaScript and search
         * inside it for a function name. Seven characters of commit here turn
         * that into a glance: if the sidebar shows the sha the publish log
         * printed, the shop is running what was published.
         */
        h('div', { class: 'sub' }, buildLabel()))),
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
    dashboard: screen(() => import('./views/dashboard.js'), 'dashboardView'),
    pos: screen(() => import('./views/pos.js'), 'posView'),
    sales: screen(() => import('./views/sales.js'), 'salesView'),
    returns: screen(() => import('./views/returns.js'), 'returnsView'),
    exchanges: screen(() => import('./views/exchange.js')),
    'web-orders': screen(() => import('./views/webOrders.js'), 'webOrdersView'),
    products: screen(() => import('./views/catalog.js'), 'productsView'),
    brands: screen(() => import('./views/masterData.js'), 'brandsView'),
    categories: screen(() => import('./views/masterData.js'), 'categoriesView'),
    attributes: screen(() => import('./views/masterData.js'), 'attributesView'),
    labels: screen(() => import('./views/labels.js'), 'labelsView'),
    inventory: screen(() => import('./views/inventory.js'), 'inventoryView'),
    movements: screen(() => import('./views/inventory.js'), 'movementsView'),
    adjustments: screen(() => import('./views/inventory.js'), 'adjustmentsView'),
    wastage: screen(() => import('./views/inventory.js'), 'wastageView'),
    purchases: screen(() => import('./views/purchasing.js'), 'purchasesView'),
    'supplier-returns': screen(() => import('./views/purchasing.js'), 'supplierReturnsView'),
    suppliers: screen(() => import('./views/masterData.js'), 'suppliersView'),
    customers: screen(() => import('./views/masterData.js'), 'customersView'),
    costs: screen(() => import('./views/costs.js'), 'costsView'),
    'cost-categories': screen(() => import('./views/costs.js'), 'costCategoriesView'),
    'legacy-invoices': screen(() => import('./views/legacyInvoices.js'), 'legacyInvoicesView'),
    employees: screen(() => import('./views/employees.js'), 'employeesView'),
    promotions: screen(() => import('./views/promotions.js'), 'promotionsView'),
    reports: screen(() => import('./views/reports.js'), 'reportsView'),
    users: screen(() => import('./views/admin.js'), 'usersView'),
    audit: screen(() => import('./views/admin.js'), 'auditView'),
    trash: screen(() => import('./views/trash.js')),
    settings: screen(() => import('./views/admin.js'), 'settingsView'),
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
