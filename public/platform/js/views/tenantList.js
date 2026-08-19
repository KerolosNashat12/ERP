/**
 * Shops — every shop on this server, with the two links its owner hands out.
 *
 * Two requests, in parallel, and neither waits on the other:
 *   /tenants   the control plane's own record — name, plan, modules, links.
 *              This is the screen; without it there is nothing to draw.
 *   /overview  what is actually inside each shop — how many users and
 *              products it really has, and whether its database answered at
 *              all. Enrichment: if it fails or is slow, the list is still a
 *              list, with the counts left as "—" rather than invented.
 *
 * The links are rendered, never assembled. `links.erp` and `links.shop` come
 * from the server that served this page, so a deployment behind a proxy or a
 * custom domain hands out addresses that work — and each one has a copy button
 * beside it, because these get pasted into WhatsApp, and a hand-typed URL is a
 * dead link in somebody else's hands.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, toast, toastError, modal, debounce, selectInput, textInput, field,
} from '../core/dom.js';
import { t, pickName, getLanguage } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import { buildTenantFields } from './tenantForm.js';
import { platformEnvironment } from '../core/environment.js';
import { showOneTimePassword, showAdoptionSummary } from './otp.js';
import {
  pageHead, card, statusCell, moduleChips, limitCell, linkRow, iconButton,
} from '../ui/page.js';
import { loadInto, skRows, skCard, emptyState } from '../ui/states.js';
import { date, int } from '../ui/format.js';

export async function tenantsView(root) {
  /**
   * Whether this console is talking to a hosted control plane. Asked once here
   * rather than inside the dialog, so opening "new shop" never waits on the
   * network — and asked through the shared probe, so this screen and the form
   * read one answer, and connecting Turso invalidates both at once. A failed
   * probe assumes "not hosted", which is the shop-PC default and the safe one:
   * it offers a file rather than demanding a URL the owner may not have.
   */
  const { hostedControlPlane } = await platformEnvironment();

  let rows = [];
  let facts = new Map();
  let reload = () => {};

  const searchInput = textInput({ type: 'search', placeholder: t('search') });
  const statusSelect = selectInput({
    options: [
      { value: '', label: t('allStatuses') },
      { value: 'active', label: t('active') },
      { value: 'suspended', label: t('suspended') },
    ],
  });
  const countLabel = h('span', { class: 'as-of' });
  const tableHost = h('div', {});

  const newButton = h('button', {
    class: 'btn primary',
    onclick: () => openCreateDialog(() => reload(), hostedControlPlane),
  }, h('span', { class: 'plus' }, '+'), ' ', t('newTenant'));

  const body = h('div', {});

  mount(root,
    pageHead({
      title: t('shops'),
      subtitle: t('shopsSubtitle'),
      actions: [
        iconButton({ icon: 'refresh', label: t('refresh'), onClick: () => reload() }),
        newButton,
      ],
    }),
    body);

  searchInput.addEventListener('input', debounce(() => renderTable(), 180));
  statusSelect.addEventListener('change', () => renderTable());

  reload = loadInto(body, {
    skeleton: () => skCard(skRows(4, 6), true),
    load: async () => {
      const [tenants, overview] = await Promise.all([
        api.get('/tenants'),
        // Enrichment only — a fleet read that fails must not take the list
        // of shops down with it.
        api.get('/overview').catch(() => null),
      ]);
      return { rows: tenants.rows, overview };
    },
    render: (data) => {
      rows = data.rows;
      facts = new Map((data.overview?.shops || []).map((shop) => [shop.slug, shop]));
      const shell = card({
        tight: true,
        body: h('div', {},
          h('div', { class: 'filters' },
            field({ label: t('searchLabel'), input: searchInput }),
            field({ label: t('status'), input: statusSelect }),
            h('span', { class: 'spacer' }),
            countLabel),
          tableHost),
      });
      renderTable();
      return shell;
    },
  });

  function filtered() {
    const query = searchInput.value.trim().toLowerCase();
    const status = statusSelect.value;
    return rows.filter((row) => {
      if (status && row.status !== status) return false;
      if (!query) return true;
      return row.nameEn.toLowerCase().includes(query)
        || (row.nameAr || '').toLowerCase().includes(query)
        || row.slug.toLowerCase().includes(query);
    });
  }

  function renderTable() {
    countLabel.textContent = t('shopCount', {
      shown: int(filtered().length), total: int(rows.length),
    });

    if (!rows.length) {
      mount(tableHost, emptyState({
        icon: 'shop',
        title: t('noTenantsTitle'),
        message: t('noTenantsBody'),
        action: h('button', {
          class: 'btn primary',
          onclick: () => openCreateDialog(() => reload(), hostedControlPlane),
        }, h('span', { class: 'plus' }, '+'), ' ', t('newTenant')),
      }));
      return;
    }

    mount(tableHost, dataTable({
      rows: filtered(),
      onRowClick: (row) => navigate(`tenants/${row.slug}`),
      rowClass: (row) => (facts.get(row.slug)?.error ? 'is-error' : ''),
      emptyIcon: '⌕',
      emptyTitle: t('noResults'),
      emptyMessage: t('noResultsBody'),
      columns: [
        {
          label: t('shop'),
          render: (row) => h('div', { class: 'cell-title' },
            h('span', { class: 'name' }, pickName(row)),
            h('span', { class: 'sub' }, getLanguage() === 'ar' ? row.nameEn : (row.nameAr || '')),
            h('span', { class: 'sub mono' }, row.slug)),
        },
        {
          label: t('status'),
          render: (row) => {
            const fact = facts.get(row.slug);
            return h('div', { class: 'row tight' },
              statusCell(row.status),
              fact?.error
                ? h('span', { class: 'tag danger', title: fact.errorMessage || t('unreachable') }, t('unreachable'))
                : null);
          },
        },
        {
          label: t('plan'),
          render: (row) => {
            const fact = facts.get(row.slug);
            return h('div', { class: 'stack', style: { gap: '7px' } },
              limitCell(fact && !fact.error ? fact.users : null, row.limits?.maxUsers, t('usersTotal')),
              limitCell(fact && !fact.error ? fact.products : null, row.limits?.maxProducts, t('productsTotal')));
          },
        },
        {
          label: t('modules'),
          class: 'col-lo',
          render: (row) => moduleChips(row.modules),
        },
        {
          label: t('links'),
          // Two words and a glyph, not two addresses: a table row is not where
          // a URL is read, and the copy button beside each one is how it
          // actually leaves this screen.
          render: (row) => h('div', { class: 'links-cell compact' },
            linkRow({ label: t('erpLink'), url: row.links?.erp || `/t/${row.slug}`, compact: true }),
            linkRow({
              label: t('storeLink'),
              url: row.links?.shop || `/t/${row.slug}/shop`,
              off: !row.websiteEnabled,
              title: row.websiteEnabled ? undefined : t('websiteOffHint'),
              compact: true,
            })),
        },
        {
          label: t('created'),
          class: 'col-lo',
          render: (row) => h('span', { class: 'small muted nowrap' }, date(row.createdAt)),
        },
        {
          label: '',
          align: 'end',
          render: (row) => h('div', { class: 'row-actions' },
            h('button', {
              class: 'btn sm',
              onclick: (event) => { event.stopPropagation(); navigate(`tenants/${row.slug}`); },
            }, t('manage'))),
        },
      ],
    }));
  }
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

export default tenantsView;
