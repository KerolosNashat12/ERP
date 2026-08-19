/**
 * "Why can't my cashier do X?"
 *
 * That is the whole reason this tab exists, so it is built to answer exactly
 * that question and nothing grander. Pick the role, find the part of the system,
 * and the pale entries are the answer.
 *
 * `GET /tenants/:slug/roles` returns each role with the permission codes it
 * actually holds *in that shop's own database*, plus the full catalogue of
 * codes that database knows about. Both halves matter: a permission that is
 * missing is only meaningful against the list of the ones that exist, and a
 * shop that is a migration behind has a shorter list than the code does.
 *
 * Codes never reach the screen on their own. `sales.return_no_receipt` is not
 * an answer to give somebody at 1am; "Sales — Return without receipt" is. The
 * module names are the ERP sidebar's own words, so the owner can walk from this
 * screen into the shop and find the same thing under the same name.
 *
 * One more thing is drawn here that is not in the permission tables at all: a
 * module the *shop* does not have switched on. A cashier with `purchases.view`
 * still cannot open Purchasing if the plan does not include it, and an owner
 * comparing a role against a complaint needs to see that before they go looking
 * for a bug.
 */
import api from '../core/api.js';
import { h, mount, dataTable } from '../core/dom.js';
import { t, getLanguage } from '../core/i18n.js';
import { card, meter, segmented } from '../ui/page.js';
import { loadInto, skCard, skRows, skBlock, emptyState } from '../ui/states.js';
import { int } from '../ui/format.js';
import { readShop } from './shopFetch.js';
import { MODULE_KEYS } from './tenantForm.js';

/**
 * A role's name in the reader's language, and never a bare code. The five
 * seeded roles are named in the dictionary; a shop that has invented its own
 * role is named by whatever that shop calls it.
 */
export function roleName(code, row) {
  if (row) {
    const own = getLanguage() === 'ar' ? (row.nameAr || row.nameEn) : (row.nameEn || row.nameAr);
    if (own) return own;
  }
  const key = `role_${code}`;
  const label = t(key);
  return label === key ? code : label;
}

/**
 * The order a person would ask about a module in: can they see it, add to it,
 * change it, remove from it — and then whatever else that module can do. The
 * catalogue arrives sorted by the permission *code*, which puts "Delete" second
 * and "See" last in every single module: alphabetical order in a language the
 * reader is not reading.
 */
const ACTION_ORDER = ['view', 'create', 'update', 'delete'];
const byAction = (a, b) => {
  const rank = (action) => {
    const index = ACTION_ORDER.indexOf(action);
    return index === -1 ? ACTION_ORDER.length : index;
  };
  return rank(a.action) - rank(b.action) || a.action.localeCompare(b.action);
};

/** "Sales — Return without receipt", never `sales.return_no_receipt`. */
const actionLabel = (action) => {
  const key = `act_${action}`;
  const label = t(key);
  return label === key ? action : label;
};

export function rolesPanel(slug, { shopModules = [] } = {}) {
  const host = h('div', {});
  let reload = () => {};

  reload = loadInto(host, {
    skeleton: () => h('div', { class: 'stack' },
      skCard(skRows(4, 4), true),
      skCard(skBlock(260))),
    load: () => readShop(api.get(`/tenants/${slug}/roles`)),
    render: (data) => renderRoles(data, new Set(shopModules)),
  });

  const panel = h('div', {}, host);
  panel.reload = () => reload();
  return panel;
}

function renderRoles(data, enabledModules) {
  const rows = data.rows || [];
  const catalogue = data.catalogue || [];

  if (!rows.length) {
    return card({
      title: t('rolesTitle'),
      body: emptyState({ icon: 'users', title: t('noRolesTitle'), message: t('noRolesBody') }),
    });
  }

  /**
   * The catalogue arrives sorted by the permission code, which puts the modules
   * in English alphabetical order — Attributes, Audit Log, Brands. The ERP's own
   * sidebar runs Dashboard, then the catalogue, then stock, then selling, then
   * administration, and an owner walking from this screen into that shop should
   * find the same things in the same order. A module this console has never
   * heard of (a shop ahead of, or behind, this build) keeps its place at the end
   * rather than disappearing.
   */
  const modules = [];
  const actionsByModule = new Map();
  for (const permission of catalogue) {
    if (!actionsByModule.has(permission.module)) {
      actionsByModule.set(permission.module, []);
      modules.push(permission.module);
    }
    actionsByModule.get(permission.module).push(permission);
  }
  for (const actions of actionsByModule.values()) actions.sort(byAction);
  modules.sort((a, b) => {
    const rank = (module) => {
      const index = MODULE_KEYS.indexOf(module);
      return index === -1 ? MODULE_KEYS.length : index;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const total = catalogue.length;

  let selected = rows[0].code;
  let heldOnly = false;

  const tableHost = h('div', {});
  const matrixHost = h('div', {});

  function select(code) {
    selected = code;
    paint();
  }

  function paint() {
    const role = rows.find((row) => row.code === selected) || rows[0];
    mount(tableHost, card({
      title: t('rolesTitle'),
      subtitle: t('rolesSubtitle'),
      tight: true,
      body: h('div', {},
        rolesTable(rows, total, selected, select),
        h('div', { class: 'pager' }, t('rolesReadOnly'))),
    }));
    mount(matrixHost, matrixCard(role, modules, actionsByModule, total, enabledModules, heldOnly, (value) => {
      heldOnly = value;
      paint();
    }));
  }

  paint();
  return h('div', { class: 'stack' }, tableHost, matrixHost);
}

/** Every role side by side: who holds it, and how much of the system it opens. */
function rolesTable(rows, total, selected, onSelect) {
  return dataTable({
    rows,
    onRowClick: (row) => onSelect(row.code),
    columns: [
      {
        label: t('roleColumn'),
        render: (row) => h('div', { class: 'cell-title' },
          h('span', { class: 'name' }, roleName(row.code, row)),
          h('span', { class: 'sub mono' }, row.code)),
      },
      { label: t('usersInRole'), align: 'end', render: (row) => int(row.userCount) },
      {
        label: t('permissionsColumn'),
        align: 'end',
        render: (row) => coverageCell(row.permissions.length, total),
      },
      {
        label: '',
        align: 'end',
        render: (row) => h('div', { class: 'row-actions' },
          h('button', {
            class: `btn sm${row.code === selected ? ' primary' : ''}`,
            onclick: (event) => { event.stopPropagation(); onSelect(row.code); },
          }, t('inspect'))),
      },
    ],
  });
}

/**
 * "24 / 63" with the share drawn under it. The same shape as a plan limit, on
 * purpose — but never tinted amber or red, because a role holding most of the
 * system is a fact about that role and not a warning about it.
 */
function coverageCell(held, total) {
  return h('div', { class: 'meter-cell' },
    h('span', { class: 'meter-label' }, h('span', { dir: 'ltr' }, `${int(held)} / ${int(total)}`)),
    meter(total ? held / total : 0, 'gold'));
}

function matrixCard(role, modules, actionsByModule, total, enabledModules, heldOnly, onHeldOnly) {
  const held = new Set(role.permissions || []);
  const touched = modules.filter((module) => actionsByModule.get(module).some((p) => held.has(p.code)));

  const shown = heldOnly ? touched : modules;

  return card({
    title: t('roleMatrixTitle', { role: roleName(role.code, role) }),
    subtitle: t('roleMatrixSubtitle', {
      held: int(held.size), total: int(total), modules: int(touched.length), allModules: int(modules.length),
    }),
    actions: [segmented(
      [{ value: 'all', label: t('showAllPermissions') }, { value: 'held', label: t('showHeldOnly') }],
      heldOnly ? 'held' : 'all',
      (value) => onHeldOnly(value === 'held'),
    )],
    body: h('div', { class: 'stack' },
      h('div', { class: 'row between' },
        h('span', { class: 'small muted' }, t('whyCantThey')),
        h('div', { class: 'row tight' },
          h('span', { class: 'tag ok' }, t('permissionsLegendHeld')),
          h('span', { class: 'tag quiet' }, t('permissionsLegendMissing')))),
      shown.length
        ? h('div', { class: 'grid cols-3' },
          shown.map((module) => modulePanel(module, actionsByModule.get(module), held, enabledModules)))
        : emptyState({ icon: 'alert', title: t('moduleNone'), message: t('noHeldInModule') })),
  });
}

function modulePanel(module, permissions, held, enabledModules) {
  const holds = permissions.filter((permission) => held.has(permission.code)).length;
  const off = enabledModules.size > 0 && !enabledModules.has(module);
  const summary = holds === permissions.length
    ? t('moduleFull')
    : (holds === 0 ? t('moduleNone') : t('modulePartial', { held: int(holds), total: int(permissions.length) }));

  return h('div', { class: 'panel stack', style: { gap: 'var(--s2)' } },
    h('div', { class: 'row between tight' },
      h('span', { class: 'strong' }, t(module)),
      h('span', { class: 'small muted nowrap' }, summary)),
    meter(permissions.length ? holds / permissions.length : 0, 'gold'),
    // A chip, not a banner: `.stack` is a grid, so a bare span would stretch
    // to the panel's full width and read as a bar rather than as a label.
    off
      ? h('div', { class: 'row tight' },
        h('span', { class: 'tag warn', title: t('moduleOffHint') }, t('moduleOffForShop')))
      : null,
    h('div', { class: 'row tight' }, permissions.map((permission) => h('span', {
      class: `tag ${held.has(permission.code) ? 'ok' : 'quiet'}`,
      title: permission.code,
    }, actionLabel(permission.action)))));
}

export default rolesPanel;
