/** The tenant fleet: search, filter, create, and jump into management. */
import api from '../core/api.js';
import {
  h, mount, dataTable, tag, toast, toastError, modal, debounce, selectInput, textInput, field,
} from '../core/dom.js';
import { t, pickName, getLanguage } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import { buildTenantFields } from './tenantForm.js';
import { showOneTimePassword, showAdoptionSummary } from './otp.js';

export async function tenantsView(root) {
  let allRows = [];
  const statsCache = new Map();
  /**
   * Whether this console is talking to a hosted control plane. Fetched once
   * here rather than inside the dialog, so opening "new tenant" never waits on
   * the network. A failed probe assumes "not hosted", which is the shop-PC
   * default and the safe one: it offers a file rather than demanding a URL the
   * owner may not have.
   */
  let hostedControlPlane = false;
  try {
    ({ hostedControlPlane } = await api.get('/environment'));
  } catch { hostedControlPlane = false; }

  const searchInput = textInput({ placeholder: t('search') });
  const statusSelect = selectInput({
    options: [
      { value: '', label: t('allStatuses') },
      { value: 'active', label: t('active') },
      { value: 'suspended', label: t('suspended') },
    ],
  });
  const tableHost = h('div', {});

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('tenants')),
        h('p', {}, t('tenantsSubtitle'))),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => openCreateDialog(refresh, hostedControlPlane) }, `+ ${t('newTenant')}`)),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        field({ label: t('search'), input: searchInput }),
        field({ label: t('status'), input: statusSelect })),
      h('div', { class: 'card-body tight' }, tableHost)));

  searchInput.addEventListener('input', debounce(() => renderTable(), 200));
  statusSelect.addEventListener('change', () => renderTable());

  function filteredRows() {
    const q = searchInput.value.trim().toLowerCase();
    const status = statusSelect.value;
    return allRows.filter((row) => {
      if (status && row.status !== status) return false;
      if (!q) return true;
      return row.nameEn.toLowerCase().includes(q)
        || (row.nameAr || '').toLowerCase().includes(q)
        || row.slug.toLowerCase().includes(q);
    });
  }

  function renderTable() {
    const rows = filteredRows();
    if (!allRows.length) {
      mount(tableHost, h('div', { class: 'empty' },
        h('span', { class: 'ico' }, '⌂'),
        h('div', { class: 'lead' }, t('noTenantsTitle')),
        h('div', {}, t('noTenantsBody')),
        h('button', { class: 'btn primary', style: { marginTop: '14px' }, onclick: () => openCreateDialog(refresh, hostedControlPlane) }, `+ ${t('newTenant')}`)));
      return;
    }

    mount(tableHost, dataTable({
      emptyMessage: t('noResults'),
      onRowClick: (row) => navigate(`tenants/${row.slug}`),
      columns: [
        {
          label: t('name'),
          render: (row) => h('div', { class: 'tenant-name' },
            h('span', { class: 'en' }, pickName(row)),
            h('span', { class: 'ar' }, getLanguage() === 'ar' ? row.nameEn : (row.nameAr || ''))),
        },
        { label: t('slug'), render: (row) => h('span', { class: 'tenant-slug' }, row.slug) },
        {
          label: t('status'),
          render: (row) => h('span', {},
            h('span', { class: `status-dot ${row.status}` }),
            row.status === 'active' ? t('active') : t('suspended')),
        },
        {
          label: t('modules'),
          render: (row) => h('div', { class: 'module-chips' },
            row.modules.length
              ? row.modules.map((m) => h('span', { class: 'module-chip' }, t(m)))
              : h('span', { class: 'muted small' }, '—')),
        },
        {
          label: t('website'),
          render: (row) => tag(row.websiteEnabled ? t('on') : t('off'), row.websiteEnabled ? 'ok' : ''),
        },
        {
          label: t('created'),
          render: (row) => h('span', { class: 'small muted' }, formatDate(row.createdAt)),
        },
        {
          label: t('stats'),
          render: (row) => statsCell(row.slug),
        },
        {
          label: '', align: 'end',
          render: (row) => h('button', {
            class: 'btn sm',
            onclick: (e) => { e.stopPropagation(); navigate(`tenants/${row.slug}`); },
          }, t('manage')),
        },
      ],
      rows,
    }));
  }

  /**
   * Stats are a separate endpoint per tenant (`/tenants/:slug/stats`), not
   * part of the list payload — each row fetches its own, once, and paints
   * the cell in place when it lands, same pattern as the ERP's sidebar
   * badges. A failed fetch just leaves the cell blank; it never blocks the
   * table.
   */
  function statsCell(slug) {
    const host = h('span', { class: 'small muted' }, '…');
    if (statsCache.has(slug)) {
      paintStats(host, statsCache.get(slug));
    } else {
      api.get(`/tenants/${slug}/stats`).then((data) => {
        statsCache.set(slug, data);
        paintStats(host, data);
      }).catch(() => { host.textContent = '—'; });
    }
    return host;
  }

  function paintStats(host, data) {
    mount(host, h('div', { class: 'stats-inline' },
      h('span', {}, h('b', {}, data.users), ` ${t('usersStat')}`),
      h('span', {}, h('b', {}, data.products), ` ${t('productsStat')}`),
      h('span', {}, h('b', {}, data.sales30d), ` ${t('sales30dStat')}`)));
  }

  async function refresh() {
    try {
      const { rows } = await api.get('/tenants');
      allRows = rows;
      renderTable();
    } catch (error) {
      toastError(error);
    }
  }

  await refresh();
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(getLanguage() === 'ar' ? 'ar-EG' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return iso; }
}

function openCreateDialog(onDone, hostedControlPlane = false) {
  const form = buildTenantFields({ websiteEnabled: true }, { withSlug: true, hostedControlPlane });
  const submit = h('button', { class: 'btn primary' }, t('create'));

  const dialog = modal({
    title: t('createTenant'),
    size: 'wide',
    body: h('div', { class: 'stack' }, ...form.nodes),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      submit,
    ],
  });

  submit.addEventListener('click', async () => {
    if (!form.validate()) return;
    const values = form.values();
    submit.disabled = true;
    submit.textContent = t('creating');
    try {
      const result = await api.post('/tenants', values);
      dialog.close();
      // An adopted shop never had a password generated for it — showing the
      // one-time-password dialog would invent one that does not exist.
      if (result.adopted) {
        showAdoptionSummary({ slug: result.slug, users: result.users, products: result.products });
      } else {
        showOneTimePassword({
          slug: result.slug,
          adminUsername: result.adminUsername,
          adminPassword: result.adminPassword,
          headline: t('tenantCreated'),
        });
      }
      toast(t('saved'));
      await onDone();
    } catch (error) {
      if (error.details) form.setServerErrors(error.details);
      toastError(error);
    } finally {
      submit.disabled = false;
      submit.textContent = t('create');
    }
  });
}
