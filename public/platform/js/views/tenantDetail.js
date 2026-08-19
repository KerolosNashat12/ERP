/**
 * One shop, in depth: Report, Users, Roles, Settings.
 *
 * The shell is one request — `GET /tenants/:slug` — for the things every tab
 * needs: the name, the status, the two links the server built, which modules
 * this shop is allowed, and where its data lives. Each tab then loads its own
 * answer, owns its own three states, and is built once and kept, so moving
 * between them is instant and only Refresh goes back to the network.
 *
 * The tab and the report's window both live in the URL (`#/tenants/mm?tab=roles`
 * `&days=90`). That is not decoration: the owner reloads this page, bookmarks
 * it, and pastes it to somebody — and a screen that always reopens on Report
 * for thirty days makes all three of those slightly worse. They are written
 * with `history.replaceState`, which changes the address without asking the
 * router to redraw a screen that is already correct.
 *
 * Nothing on this screen decides what is allowed. Suspension, limits and
 * modules are the server's to enforce; this is where they are read and set.
 */
import api from '../core/api.js';
import {
  h, mount, toast, toastError, confirmDialog,
} from '../core/dom.js';
import { t, pickName } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import { buildTenantFields } from './tenantForm.js';
import { showOneTimePassword } from './otp.js';
import { reportPanel } from './shopReport.js';
import { usersPanel } from './shopUsers.js';
import { rolesPanel } from './shopRoles.js';
import {
  pageHead, backLink, card, linkRow, iconButton, statusCell, tabStrip,
} from '../ui/page.js';
import {
  loadInto, skKpis, skCard, skBlock, skLine,
} from '../ui/states.js';
import { date, dateTime } from '../ui/format.js';
import icons from '../ui/icons.js';

const TABS = ['report', 'users', 'roles', 'settings'];

export async function tenantDetailView(root, route) {
  const slug = route.segments[1];
  const host = h('div', {});
  mount(root, host);

  loadInto(host, {
    skeleton: () => h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('div', { style: { flex: '1' } },
        skLine('280px', 24),
        h('span', { style: { display: 'block', height: '10px' } }),
        skLine('420px', 11))),
      skKpis(4),
      skCard(skBlock(280))),
    load: () => api.get(`/tenants/${slug}`),
    render: (tenant, reload) => renderShop(tenant, route, reload),
  });
}

function renderShop(tenant, route, reloadShell) {
  const state = {
    tab: TABS.includes(route.query.tab) ? route.query.tab : 'report',
    days: Number(route.query.days) || 30,
  };

  const panels = new Map();
  const tabsHost = h('div', {});
  const panelHost = h('div', { style: { marginTop: 'var(--s4)' } });

  /** The address follows the screen, without asking the router to redraw it. */
  function syncUrl() {
    const query = new URLSearchParams({ tab: state.tab });
    if (state.tab === 'report' && state.days !== 30) query.set('days', String(state.days));
    const url = `#/tenants/${tenant.slug}?${query}`;
    if (window.location.hash !== url) window.history.replaceState(null, '', url);
  }

  function panelFor(key) {
    if (panels.has(key)) return panels.get(key);
    const panel = buildPanel(key, tenant, state, reloadShell);
    panels.set(key, panel);
    return panel;
  }

  function show(key) {
    state.tab = TABS.includes(key) ? key : 'report';
    syncUrl();
    mount(tabsHost, tabStripFor(state.tab, show));
    mount(panelHost, panelFor(state.tab));
  }

  const refresh = iconButton({
    icon: 'refresh',
    label: t('refresh'),
    onClick: () => {
      const panel = panels.get(state.tab);
      // Settings is a view of the shell's own answer, so refreshing it is a
      // reload of the shell; every other tab owns its data and reloads itself.
      if (state.tab === 'settings' || !panel?.reload) reloadShell();
      else panel.reload();
    },
  });

  const head = pageHead({
    back: backLink(t('backToTenants'), () => navigate('tenants')),
    title: pickName(tenant),
    subtitle: h('span', { class: 'row tight' },
      statusCell(tenant.status),
      h('span', { class: 'muted' }, '·'),
      h('span', { class: 'mono small', dir: 'ltr' }, `/t/${tenant.slug}`),
      h('span', { class: 'muted' }, '·'),
      h('span', {}, `${t('createdAt')} ${date(tenant.createdAt)}`)),
    actions: [
      refresh,
      h('a', {
        class: 'btn', href: tenant.links?.erp || `/t/${tenant.slug}`, target: '_blank', rel: 'noopener',
      }, h('span', { html: icons.external }), t('openErpShort')),
      h('a', {
        class: 'btn',
        href: tenant.links?.shop || `/t/${tenant.slug}/shop`,
        target: '_blank',
        rel: 'noopener',
        title: tenant.websiteEnabled ? undefined : t('websiteOffHint'),
      }, h('span', { html: icons.external }), t('openShopShort')),
    ],
  });

  show(state.tab);
  return h('div', {}, head, tabsHost, panelHost);
}

/** Report / Users / Roles / Settings, in the console's own tab strip. */
const tabStripFor = (active, onChange) => tabStrip(
  TABS.map((key) => ({ key, label: t(`tab${key[0].toUpperCase()}${key.slice(1)}`) })),
  active,
  onChange,
);

function buildPanel(key, tenant, state, reloadShell) {
  if (key === 'report') {
    return reportPanel(tenant.slug, {
      days: state.days,
      onDays: (days) => {
        state.days = days;
        const query = new URLSearchParams({ tab: 'report' });
        if (days !== 30) query.set('days', String(days));
        window.history.replaceState(null, '', `#/tenants/${tenant.slug}?${query}`);
      },
    });
  }
  if (key === 'users') return usersPanel(tenant.slug);
  if (key === 'roles') return rolesPanel(tenant.slug, { shopModules: tenant.modules });
  return settingsPanel(tenant, reloadShell);
}

// ---------------------------------------------------------------- settings

/**
 * The shop's own record: what it is called, what it may use, what it is limited
 * to — and, beside it, the three facts an owner checks before touching any of
 * that. The links, because they are what gets handed out; where the data lives,
 * because "am I about to suspend a file on this PC or a database on the
 * internet" is a different question with a different answer; and the two
 * actions that stop a shop or hand its admin a new password.
 */
function settingsPanel(tenant, reloadShell) {
  const form = buildTenantFields(tenant, { withSlug: false });
  const save = h('button', { class: 'btn primary' }, t('saveChanges'));

  save.addEventListener('click', async () => {
    if (!form.validate()) return;
    save.disabled = true;
    try {
      await api.put(`/tenants/${tenant.slug}`, form.values());
      toast(t('saved'));
      reloadShell();
    } catch (error) {
      if (error.details) form.setServerErrors(error.details);
      toastError(error);
    } finally {
      save.disabled = false;
    }
  });

  return h('div', { class: 'split' },
    h('div', { class: 'stack' },
      card({
        title: t('settingsTitle'),
        subtitle: t('settingsSubtitle'),
        body: h('div', { class: 'stack' },
          ...form.nodes,
          h('div', { class: 'row' }, h('span', { class: 'spacer' }), save)),
      })),

    h('div', { class: 'stack' },
      card({
        title: t('linksTitle'),
        subtitle: t('linksSubtitle'),
        body: h('div', { class: 'stack', style: { gap: 'var(--s2)' } },
          linkRow({ label: t('erpLink'), url: tenant.links?.erp || `/t/${tenant.slug}` }),
          linkRow({
            label: t('storeLink'),
            url: tenant.links?.shop || `/t/${tenant.slug}/shop`,
            off: !tenant.websiteEnabled,
            title: tenant.websiteEnabled ? undefined : t('websiteOffHint'),
          })),
      }),

      card({
        title: t('databaseTitle'),
        subtitle: t('databaseSubtitle'),
        body: databaseFacts(tenant),
      }),

      h('div', { class: 'danger-zone' },
        h('h4', {}, t('dangerZone')),
        h('p', { class: 'small muted', style: { margin: '0 0 var(--s3)' } }, t('dangerZoneHint')),
        h('div', { class: 'row tight' },
          tenant.status === 'active'
            ? h('button', {
              class: 'btn danger',
              onclick: () => suspendResume(tenant, 'suspend', reloadShell),
            }, t('suspendTenant'))
            : h('button', {
              class: 'btn primary',
              onclick: () => suspendResume(tenant, 'resume', reloadShell),
            }, t('resumeTenant')),
          h('button', {
            class: 'btn',
            onclick: () => resetAdminPassword(tenant),
          }, t('resetAdminPassword'))))));
}

const factRow = (label, value) => h('div', { class: 'row between tight' },
  h('span', { class: 'small muted' }, label),
  value instanceof Node ? value : h('span', { class: 'small strong' }, value));

/**
 * Where this shop's data lives, in the two facts that are safe to render: the
 * driver and the host. Never the token — the API does not return it — and never
 * the rest of a URL, because a query string on a database address is where a
 * credential hides. A `file:` database is named by its file and not by the path
 * to it, which is the server's business and not this screen's.
 */
function databaseFacts(tenant) {
  const database = tenant.database || {};
  const libsql = database.driver === 'libsql';
  const url = database.url || '';
  let host = null;
  let file = null;

  if (libsql && url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') file = parsed.pathname.split('/').pop();
      else host = parsed.hostname;
    } catch { host = null; }
  } else if (database.file) {
    file = String(database.file).split(/[\\/]/).pop();
  }

  return h('div', { class: 'stack', style: { gap: 'var(--s2)' } },
    factRow(t('driverLabel'), h('span', { class: 'tag info' }, libsql ? t('driverLibsql') : t('driverSqlite'))),
    // Deliberately not the plan or the modules: those are the form on the left,
    // and a card repeating the fields beside them is two versions of one truth.
    host ? factRow(t('hostLabel'), h('span', { class: 'mono small', dir: 'ltr' }, host)) : null,
    file ? factRow(t('fileLabel'), h('span', { class: 'mono small', dir: 'ltr' }, file)) : null,
    libsql
      ? factRow(t('authTokenState'), h('span', {
        class: `tag ${database.hasAuthToken ? 'ok' : 'quiet'}`,
      }, database.hasAuthToken ? t('tokenSet') : t('tokenNotSet')))
      : null,
    factRow(t('updatedAt'), h('span', { class: 'small muted' }, dateTime(tenant.updatedAt))));
}

async function suspendResume(tenant, action, reloadShell) {
  const confirmed = await confirmDialog({
    title: t(action === 'suspend' ? 'suspendConfirmTitle' : 'resumeConfirmTitle'),
    message: t(action === 'suspend' ? 'suspendConfirmBody' : 'resumeConfirmBody'),
    confirmLabel: t(action === 'suspend' ? 'suspendTenant' : 'resumeTenant'),
    danger: action === 'suspend',
  });
  if (!confirmed) return;
  try {
    await api.post(`/tenants/${tenant.slug}/${action}`, {});
    toast(t(action === 'suspend' ? 'suspended_action' : 'resumed_action'));
    reloadShell();
  } catch (error) {
    toastError(error);
  }
}

async function resetAdminPassword(tenant) {
  const confirmed = await confirmDialog({
    title: t('resetAdminConfirmTitle'),
    message: t('resetAdminConfirmBody'),
    confirmLabel: t('resetAdminPassword'),
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await api.post(`/tenants/${tenant.slug}/reset-admin-password`, {});
    showOneTimePassword({
      slug: tenant.slug,
      username: result.adminUsername,
      password: result.adminPassword,
      headline: t('passwordReset'),
      withLinks: false,
    });
  } catch (error) {
    toastError(error);
  }
}

export default tenantDetailView;
