/** Users & roles, audit log, settings, locations and backups. */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  field, modal, debounce, tag, buildForm, confirmDialog, checkboxInput,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { number, dateTime, money } from '../core/format.js';
import { session, can, loadSession, setBadge } from '../core/store.js';
import { devicesPanel } from './devices.js';

// ------------------------------------------------------------ users & roles

export async function usersView(root) {
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const rolesHost = h('div', { class: 'card-body tight' });
  const resetsHost = h('div', { class: 'card-body tight' }, spinner());
  const resetsCount = h('span', { class: 'row' });
  let roleData = { rows: [], permissions: [] };

  async function load() {
    const [users, roles] = await Promise.all([
      api.get('/api/users'),
      api.get('/api/users/roles'),
    ]);
    roleData = roles;

    mount(listHost, dataTable({
      columns: [
        {
          key: 'user',
          label: t('user'),
          render: (r) => h('div', { class: 'row', style: { gap: '9px' } },
            h('div', { class: 'avatar' }, initials(r.full_name)),
            h('div', {},
              h('div', { class: 'strong small' }, r.full_name),
              h('small', { class: 'muted mono' }, r.username))),
        },
        { key: 'role', label: t('role'), render: (r) => tag(pick({ name_en: r.role_name_en, name_ar: r.role_name_ar }, 'name'), 'info') },
        { key: 'email', label: t('email'), render: (r) => h('span', { class: 'small' }, r.email || '—') },
        { key: 'phone', label: t('phone'), class: 'mono small' },
        { key: 'last_login_at', label: t('lastLogin'), render: (r) => h('span', { class: 'small muted' }, r.last_login_at ? dateTime(r.last_login_at) : '—') },
        {
          key: 'status',
          label: t('status'),
          render: (r) => {
            if (!r.is_active) return tag(t('inactive'));
            if (r.locked_until && new Date(r.locked_until) > new Date()) return tag(t('locked'), 'danger');
            return tag(t('active'), 'ok');
          },
        },
        {
          key: '__a',
          label: '',
          width: '1%',
          render: (r) => h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
            can('users.update') ? h('button', { class: 'btn sm ghost', onclick: () => openUserForm(r, load) }, '✎') : null,
            can('users.delete') && r.id !== session.user.id ? h('button', {
              class: 'btn sm ghost',
              onclick: async () => {
                if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
                try { await api.del(`/api/users/${r.id}`); toast(t('deleted')); load(); } catch (e) { toastError(e); }
              },
            }, '🗑') : null),
        },
      ],
      rows: users.rows,
    }));

    mount(rolesHost, dataTable({
      columns: [
        { key: 'name', label: t('role'), render: (r) => h('span', { class: 'strong' }, pick(r, 'name')) },
        { key: 'code', label: t('code'), class: 'mono small' },
        { key: 'description', label: t('description'), render: (r) => h('span', { class: 'small muted' }, r.description) },
        { key: 'user_count', label: t('users'), type: 'number' },
        { key: 'permissions', label: t('permissions'), type: 'number', render: (r) => number(r.permissions.length) },
        {
          key: '__a',
          label: '',
          render: (r) => (can('users.update') && r.code !== 'admin'
            ? h('button', { class: 'btn sm', onclick: () => openRolePermissions(r, roleData.permissions, load) }, t('edit'))
            : ''),
        },
      ],
      rows: roles.rows,
    }));
  }

  /**
   * The pending queue, loaded separately from the users table: approving has to
   * refresh both (the account gets unlocked) but rejecting only touches this one.
   */
  async function loadResets() {
    const { rows } = await api.get('/api/users/reset-requests', { status: 'pending' });
    setBadge('pendingResets', rows.length);
    mount(resetsCount, rows.length ? tag(`${t('pendingResets')} · ${number(rows.length)}`, 'warn') : null);

    mount(resetsHost, dataTable({
      emptyMessage: t('noResetRequests'),
      columns: [
        {
          key: 'user',
          label: t('user'),
          render: (r) => h('div', { class: 'row', style: { gap: '9px' } },
            h('div', { class: 'avatar' }, initials(r.full_name)),
            h('div', {},
              h('div', { class: 'strong small' }, r.full_name),
              h('small', { class: 'muted mono' }, r.username))),
        },
        {
          key: 'requested_at',
          label: t('requestedAt'),
          render: (r) => h('span', { class: 'small muted' }, dateTime(r.requested_at)),
        },
        {
          key: 'note',
          label: t('notes'),
          render: (r) => h('span', { class: 'small' }, r.note || '—'),
        },
        {
          key: 'status',
          label: t('status'),
          render: (r) => {
            if (!r.is_active) return tag(t('inactive'));
            if (r.locked_until && new Date(r.locked_until) > new Date()) return tag(t('locked'), 'danger');
            return tag(t('active'), 'ok');
          },
        },
        {
          key: '__a',
          label: '',
          width: '1%',
          render: (r) => (can('users.reset_password')
            ? h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
              h('button', {
                class: 'btn sm primary',
                onclick: (event) => approveReset(r, event.currentTarget),
              }, t('approveReset')),
              h('button', {
                class: 'btn sm',
                onclick: (event) => rejectReset(r, event.currentTarget),
              }, t('rejectReset')))
            : ''),
        },
      ],
      rows,
    }));
  }

  async function approveReset(row, button) {
    button.disabled = true;
    try {
      const result = await api.post(`/api/users/reset-requests/${row.id}/approve`, {});
      // Shown before anything else can fail: this password is never readable again.
      showOneTimePassword(result);
      await Promise.all([loadResets(), load()]);
    } catch (error) {
      button.disabled = false;
      toastError(error);
    }
  }

  async function rejectReset(row, button) {
    button.disabled = true;
    try {
      await api.post(`/api/users/reset-requests/${row.id}/reject`, {});
      toast(t('resetRejected'));
      await loadResets();
    } catch (error) {
      button.disabled = false;
      toastError(error);
    }
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('users')), h('p', {}, t('usersSubtitle'))),
      h('span', { class: 'spacer' }),
      can('users.create') ? h('button', { class: 'btn primary', onclick: () => openUserForm(null, load) }, '＋ ' + t('newUser')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', {}, t('resetRequests')),
        h('span', { class: 'spacer' }),
        resetsCount),
      resetsHost),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('users'))), listHost),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('rolePermissions'))), rolesHost));

  await Promise.all([load(), loadResets()]);
}

/**
 * The hand-over dialog. The server hashed the password before replying, so this
 * modal is the only place it will ever exist: it refuses to close on a stray
 * backdrop click, and copying is one tap.
 */
function showOneTimePassword({ username, oneTimePassword }) {
  const code = h('div', { class: 'otp-code', dir: 'ltr' }, oneTimePassword);

  const dialog = modal({
    title: t('oneTimePassword'),
    size: 'narrow',
    closeOnBackdrop: false,
    body: h('div', { class: 'otp-panel' },
      h('p', { class: 'muted small', style: { margin: 0 } }, t('resetApproved')),
      h('div', { class: 'row', style: { gap: '9px' } },
        h('div', { class: 'avatar' }, initials(username)),
        h('span', { class: 'strong mono' }, username)),
      code,
      h('div', { class: 'otp-warn' },
        h('span', { class: 'ico' }, '⚠'),
        h('span', {}, t('oneTimePasswordHint')))),
    footer: [
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (await copyText(oneTimePassword)) { toast(t('copied')); return; }
          selectContents(code);
          toast(t('copyManually'), 'warn', 6000);
        },
      }, t('copyToClipboard')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => dialog.close() }, t('close')),
    ],
  });
}

/**
 * navigator.clipboard only exists on a secure origin, and the shop server runs
 * over plain HTTP on the LAN — so fall back to the old copy command, and then to
 * simply selecting the text so the user can copy it by hand.
 */
async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* denied or insecure context — try the fallback below */ }

  const helper = h('textarea', { class: 'copy-helper', readonly: true, value });
  document.body.append(helper);
  helper.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  helper.remove();
  return copied;
}

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

const initials = (name) => String(name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();

async function openUserForm(user, refresh) {
  const roles = (await api.get('/api/users/roles')).rows;
  const form = buildForm([
    { name: 'full_name', label: t('fullName'), required: true },
    { name: 'username', label: t('username'), required: !user, disabled: Boolean(user) },
    { name: 'email', label: t('email') },
    { name: 'phone', label: t('phone') },
    { name: 'password', label: user ? t('newPassword') : t('password'), type: 'password', required: !user, hint: user ? t('leaveBlankKeepPassword') : t('minSixChars') },
    { name: 'role_id', label: t('role'), type: 'select', required: true, options: roles.map((r) => ({ value: r.id, label: pick(r, 'name') })) },
    { name: 'language', label: t('language'), type: 'select', required: true, options: [{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }] },
    { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    ...(user?.locked_until ? [{ name: 'unlock', label: t('unlock'), type: 'checkbox' }] : []),
  ], user || { is_active: 1, language: 'en' }, { columns: 2 });

  const dialog = modal({
    title: user ? `${t('edit')} — ${user.full_name}` : t('newUser'),
    body: form.node,
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            const values = form.values();
            const payload = { ...values, is_active: Boolean(values.is_active) };
            if (!payload.password) delete payload.password;
            if (user) {
              payload.unlock = Boolean(values.unlock);
              await api.put(`/api/users/${user.id}`, payload);
            } else {
              await api.post('/api/users', payload);
            }
            toast(t('saved'));
            dialog.close();
            refresh();
          } catch (error) {
            if (error.details?.length) form.setErrors(error.details);
            toastError(error);
          }
        },
      }, t('save')),
    ],
  });
}

function openRolePermissions(role, catalogue, refresh) {
  const selected = new Set(role.permissions);
  const grouped = catalogue.reduce((acc, permission) => {
    (acc[permission.module] ||= []).push(permission);
    return acc;
  }, {});

  const body = h('div', { class: 'stack' },
    ...Object.entries(grouped).map(([module, permissions]) => h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', { style: { fontSize: '13px' } }, t(module, module)),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn sm ghost',
          onclick: (event) => {
            const all = permissions.every((p) => selected.has(p.code));
            permissions.forEach((p) => (all ? selected.delete(p.code) : selected.add(p.code)));
            event.currentTarget.closest('.card').querySelectorAll('input[type=checkbox]')
              .forEach((box) => { box.checked = !all; });
          },
        }, t('selectAll'))),
      h('div', { class: 'card-body row' }, permissions.map((permission) => checkboxInput({
        label: permission.action,
        checked: selected.has(permission.code),
        onchange: (event) => (event.target.checked ? selected.add(permission.code) : selected.delete(permission.code)),
      }))))));

  const dialog = modal({
    title: `${t('rolePermissions')} — ${pick(role, 'name')}`,
    size: 'wide',
    body,
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await api.put(`/api/users/roles/${role.id}/permissions`, { permissions: [...selected] });
            toast(t('saved'));
            dialog.close();
            refresh();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

// ------------------------------------------------------------------- audit

export async function auditView(root) {
  const state = { search: '', module: '', action: '', dateFrom: '', dateTo: '', page: 1, pageSize: 50 };
  const filters = await api.get('/api/audit/filters');
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');

  async function load() {
    mount(listHost, spinner());
    const data = await api.get('/api/audit', state);
    mount(listHost, dataTable({
      columns: [
        { key: 'created_at', label: t('date'), render: (r) => h('span', { class: 'small nowrap' }, dateTime(r.created_at)) },
        {
          key: 'user',
          label: t('user'),
          render: (r) => h('div', {},
            h('div', { class: 'small strong' }, r.user_full_name || r.username || t('systemUser')),
            h('small', { class: 'muted mono' }, r.username || '—')),
        },
        { key: 'module', label: t('module'), render: (r) => tag(t(r.module, r.module)) },
        { key: 'action', label: t('action'), render: (r) => tag(r.action, actionKind(r.action)) },
        { key: 'entity_type', label: t('entity'), render: (r) => h('span', { class: 'small muted' }, r.entity_type || '—') },
        { key: 'entity_label', label: t('details'), render: (r) => h('span', { class: 'small' }, r.entity_label || '—') },
        { key: 'status', label: t('status'), render: (r) => tag(r.status, r.status === 'SUCCESS' ? 'ok' : 'danger') },
        { key: 'ip_address', label: t('ipAddress'), class: 'mono small' },
        {
          key: '__a',
          label: '',
          render: (r) => ((r.before_data || r.after_data)
            ? h('button', { class: 'btn sm ghost', onclick: () => showChanges(r) }, t('viewChanges'))
            : ''),
        },
      ],
      rows: data.rows,
    }));
    mount(pagerHost, pager({ page: data.page, pages: data.pages, total: data.total, onPage: (p) => { state.page = p; load(); } }));
  }

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('audit')), h('p', {}, t('auditSubtitle'))),
      h('span', { class: 'spacer' }),
      can('audit.export') ? h('button', {
        class: 'btn',
        onclick: () => api.download('/api/reports/audit_trail', { format: 'csv', ...state }, 'audit-trail.csv'),
      }, t('export')) : null),
    h('div', { class: 'card' },
      h('div', { class: 'filters' },
        h('div', { class: 'field grow' }, textInput({
          placeholder: t('search'),
          oninput: debounce((e) => { state.search = e.target.value; state.page = 1; load(); }, 280),
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('module'),
          options: filters.modules.map((m) => ({ value: m, label: t(m, m) })),
          onchange: (e) => { state.module = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, selectInput({
          placeholder: t('action'),
          options: filters.actions.map((a) => ({ value: a, label: a })),
          onchange: (e) => { state.action = e.target.value; state.page = 1; load(); },
        })),
        h('div', { class: 'field' }, field({
          label: t('from'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateFrom = e.target.value; load(); } }),
        })),
        h('div', { class: 'field' }, field({
          label: t('to'),
          input: h('input', { class: 'input', type: 'date', onchange: (e) => { state.dateTo = e.target.value; load(); } }),
        }))),
      listHost, pagerHost));

  await load();
}

const actionKind = (action) => {
  if (['DELETE', 'VOID', 'CANCEL'].includes(action)) return 'danger';
  if (['CREATE', 'RECEIVE', 'COMPLETE', 'POST', 'PAYMENT'].includes(action)) return 'ok';
  if (['LOGIN', 'LOGOUT'].includes(action)) return 'info';
  return '';
};

function showChanges(entry) {
  const parse = (value) => { try { return JSON.parse(value); } catch { return value; } };
  const before = parse(entry.before_data);
  const after = parse(entry.after_data);
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];

  modal({
    title: `${entry.action} — ${entry.entity_label || entry.entity_type || ''}`,
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${dateTime(entry.created_at)} · ${entry.username} · ${entry.ip_address || ''}`),
      keys.length
        ? dataTable({
          columns: [
            { key: 'k', label: t('fieldName') },
            { key: 'b', label: t('before'), render: (r) => h('span', { class: 'small mono' }, format(r.b)) },
            { key: 'a', label: t('after'), render: (r) => h('span', { class: 'small mono strong' }, format(r.a)) },
          ],
          rows: keys.map((k) => ({ k, b: before?.[k], a: after?.[k] })),
        })
        : h('pre', { class: 'small' }, JSON.stringify(after || before, null, 2))),
  });
}

const format = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

// ---------------------------------------------------------------- settings

/**
 * The storefront hero is a fixed 16:5 crop. Cropping client-side before the
 * upload — rather than compressing whatever rectangle the file happens to be
 * — is what lets the owner answer "does my product end up behind the
 * heading text" before saving, instead of finding out on the live site.
 */
const BANNER_CROP_W = 1600;
const BANNER_CROP_H = 500;
const BANNER_CROP_RATIO = BANNER_CROP_W / BANNER_CROP_H;
const BANNER_JPEG_QUALITY = 0.85;

/**
 * Positions the heading/text box physically (left/right/top/bottom, never
 * inline-start/end): the contract requires the owner's chosen position to
 * render identically in Arabic and English, and logical properties would
 * flip it under dir="rtl".
 */
function bannerContentPositionStyle(align, valign, boxWidth) {
  const style = { position: 'absolute', width: `${boxWidth}%` };
  if (align === 'left') style.left = '0';
  else if (align === 'right') style.right = '0';
  else style.left = '50%';
  if (valign === 'top') style.top = '0';
  else if (valign === 'bottom') style.bottom = '0';
  else style.top = '50%';
  style.transform = `translate(${align === 'center' ? '-50%' : '0'}, ${valign === 'middle' ? '-50%' : '0'})`;
  return style;
}

function clampNum(value, min, max) {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

export async function settingsView(root, route) {
  const settings = await api.get('/api/settings');
  const editable = can('settings.update');
  let activeTab = route?.query?.tab || 'company';
  let devicesPanelInstance = null;

  const company = buildForm([
    { name: 'company.name', label: t('nameEn'), required: true, disabled: !editable },
    { name: 'company.name_ar', label: t('nameAr'), disabled: !editable },
    { name: 'company.phone', label: t('phone'), disabled: !editable },
    { name: 'company.email', label: t('email'), disabled: !editable },
    { name: 'company.tax_number', label: t('taxNumber'), disabled: !editable },
    { name: 'company.currency', label: t('currency'), disabled: !editable },
    { name: 'company.currency_symbol_en', label: t('currencySymbolEn'), disabled: !editable },
    { name: 'company.currency_symbol_ar', label: t('currencySymbolAr'), disabled: !editable },
    { name: 'company.default_tax_rate', label: t('taxRate'), type: 'number', disabled: !editable },
    { name: 'company.address', label: t('address'), type: 'textarea', span: 3, disabled: !editable },
  ], settings, { columns: 3 });

  const operations = buildForm([
    { name: 'inventory.allow_negative_stock', label: t('allowNegativeStock'), type: 'checkbox', disabled: !editable },
    { name: 'inventory.low_stock_alerts', label: t('lowStockAlerts'), type: 'checkbox', disabled: !editable },
    { name: 'loyalty.enabled', label: t('loyaltyEnabled'), type: 'checkbox', disabled: !editable },
    { name: 'loyalty.earn_rate', label: t('loyaltyEarnRate'), type: 'number', disabled: !editable },
    { name: 'loyalty.redeem_value', label: t('loyaltyRedeemValue'), type: 'number', disabled: !editable },
  ], settings, { columns: 3 });

  const returnsForm = buildForm([
    {
      name: 'returns.window_days',
      label: t('returnWindowDays'),
      type: 'number',
      disabled: !editable,
      hint: t('returnWindowHint'),
    },
    {
      name: 'returns.allow_without_receipt',
      label: t('allowNoReceipt'),
      type: 'checkbox',
      disabled: !editable,
    },
    { name: 'returns.require_reason', label: t('requireReason'), type: 'checkbox', disabled: !editable },
    {
      name: 'returns.restocking_fee_percent',
      label: t('restockingFeePercent'),
      type: 'number',
      disabled: !editable,
      hint: t('restockingFeePolicyHint'),
    },
    {
      name: 'returns.store_credit_days',
      label: t('storeCreditDays'),
      type: 'number',
      disabled: !editable,
      hint: t('storeCreditDaysHint'),
    },
  ], settings, { columns: 3 });

  const locationForm = buildForm([
    { name: 'name_en', label: t('shopNameEn'), disabled: !editable },
    { name: 'name_ar', label: t('shopNameAr'), disabled: !editable },
    { name: 'phone', label: t('phone'), disabled: !editable },
    { name: 'address', label: t('address'), type: 'textarea', span: 3, disabled: !editable },
  ], await api.get('/api/location'), { columns: 3 });

  // --- website tab: storefront banner, social links, contact page
  const SOCIAL_NETWORKS = ['facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp', 'x'];
  const SOCIAL_LABEL_KEYS = {
    facebook: 'socialFacebook', instagram: 'socialInstagram', tiktok: 'socialTiktok',
    youtube: 'socialYoutube', whatsapp: 'socialWhatsapp', x: 'socialX',
  };

  const bannerForm = buildForm([
    { name: 'web.banner_heading_en', label: t('bannerHeadingEn'), disabled: !editable },
    { name: 'web.banner_heading_ar', label: t('bannerHeadingAr'), disabled: !editable },
    { name: 'web.banner_text_en', label: t('bannerTextEn'), type: 'textarea', span: 3, disabled: !editable },
    { name: 'web.banner_text_ar', label: t('bannerTextAr'), type: 'textarea', span: 3, disabled: !editable },
    { name: 'web.banner_cta_label_en', label: t('bannerCtaLabelEn'), disabled: !editable },
    { name: 'web.banner_cta_label_ar', label: t('bannerCtaLabelAr'), disabled: !editable },
    { name: 'web.banner_cta_link', label: t('bannerCtaLink'), hint: t('bannerCtaLinkHint'), disabled: !editable },
    {
      name: 'web.banner_overlay', label: t('bannerOverlay'), type: 'number', min: 0, max: 80,
      hint: t('bannerOverlayHint'), disabled: !editable,
    },
    {
      name: 'web.banner_align', label: t('bannerAlign'), type: 'select', required: true, disabled: !editable,
      options: [
        { value: 'right', label: t('alignRight') },
        { value: 'center', label: t('alignCenter') },
        { value: 'left', label: t('alignLeft') },
      ],
    },
    {
      name: 'web.banner_valign', label: t('bannerValign'), type: 'select', required: true, disabled: !editable,
      options: [
        { value: 'top', label: t('valignTop') },
        { value: 'middle', label: t('valignMiddle') },
        { value: 'bottom', label: t('valignBottom') },
      ],
    },
    {
      name: 'web.banner_text_size', label: t('bannerTextSize'), type: 'select', required: true, disabled: !editable,
      options: [
        { value: 'small', label: t('sizeSmall') },
        { value: 'medium', label: t('sizeMedium') },
        { value: 'large', label: t('sizeLarge') },
      ],
    },
    {
      name: 'web.banner_text_color', label: t('bannerTextColor'), type: 'select', required: true, disabled: !editable,
      options: [
        { value: 'light', label: t('colorLight') },
        { value: 'dark', label: t('colorDark') },
      ],
    },
    {
      name: 'web.banner_box_width', label: t('bannerBoxWidth'), type: 'number', min: 30, max: 100,
      hint: t('bannerBoxWidthHint'), disabled: !editable,
    },
  ], settings, { columns: 3 });

  const socialForm = buildForm(SOCIAL_NETWORKS.flatMap((net) => [
    { name: `web.social_${net}_enabled`, label: t('socialShowOnSite'), type: 'checkbox', disabled: !editable },
    {
      name: `web.social_${net}`,
      label: t(SOCIAL_LABEL_KEYS[net]),
      span: 2,
      hint: net === 'whatsapp' ? t('socialWhatsappHint') : undefined,
      disabled: !editable,
    },
  ]), settings, { columns: 3 });

  const contactForm = buildForm([
    { name: 'web.contact_email', label: t('email'), disabled: !editable },
    { name: 'web.contact_phone', label: t('phone'), disabled: !editable },
    { name: 'web.contact_address_en', label: t('contactAddressEn'), type: 'textarea', span: 3, disabled: !editable },
    { name: 'web.contact_address_ar', label: t('contactAddressAr'), type: 'textarea', span: 3, disabled: !editable },
    { name: 'web.contact_hours_en', label: t('contactHoursEn'), disabled: !editable },
    { name: 'web.contact_hours_ar', label: t('contactHoursAr'), disabled: !editable },
    { name: 'web.contact_map_url', label: t('contactMapUrl'), span: 3, disabled: !editable },
  ], settings, { columns: 3 });

  let bannerMeta = { hasImage: false };
  const bannerPreview = h('div', { class: 'banner-preview-frame' });

  function bannerFieldValue(name) { return bannerForm.inputs.get(name)?.input.value || ''; }

  /** Everything the live preview (and the crop modal's mini-preview) need to draw the text over a photo. */
  function bannerTextSpec() {
    const ar = getLanguage() === 'ar';
    const primary = ar ? '_ar' : '_en';
    const fallback = ar ? '_en' : '_ar';
    const pickField = (base) => bannerFieldValue(`web.${base}${primary}`) || bannerFieldValue(`web.${base}${fallback}`);
    return {
      heading: pickField('banner_heading'),
      text: pickField('banner_text'),
      ctaLabel: pickField('banner_cta_label'),
      overlay: clampNum(bannerFieldValue('web.banner_overlay'), 0, 80),
      align: bannerFieldValue('web.banner_align') || 'right',
      valign: bannerFieldValue('web.banner_valign') || 'middle',
      size: bannerFieldValue('web.banner_text_size') || 'medium',
      color: bannerFieldValue('web.banner_text_color') || 'light',
      boxWidth: clampNum(bannerFieldValue('web.banner_box_width'), 30, 100),
    };
  }

  /** The overlay tint + heading/text/CTA nodes, shared by the settings preview and the crop modal's preview. */
  function bannerOverlayNodes(spec) {
    return [
      h('div', { class: 'banner-preview-overlay', style: { background: `rgba(0,0,0,${spec.overlay / 100})` } }),
      h('div', {
        class: `banner-preview-content talign-${spec.align} color-${spec.color} size-${spec.size}`,
        style: bannerContentPositionStyle(spec.align, spec.valign, spec.boxWidth),
      },
        spec.heading ? h('h3', {}, spec.heading) : null,
        spec.text ? h('p', {}, spec.text) : null,
        spec.ctaLabel ? h('span', { class: 'banner-preview-cta' }, spec.ctaLabel) : null),
    ];
  }

  function renderBannerPreview() {
    const spec = bannerTextSpec();
    mount(bannerPreview,
      ...bannerOverlayNodes(spec),
      !bannerMeta.hasImage ? h('div', { class: 'banner-preview-empty' }, t('noBannerPhoto')) : null);
    bannerPreview.style.backgroundImage = bannerMeta.hasImage ? `url(/api/settings/website/banner/raw?_=${Date.now()})` : 'none';
  }

  const BANNER_LIVE_FIELDS = [
    'web.banner_heading_en', 'web.banner_heading_ar', 'web.banner_text_en', 'web.banner_text_ar',
    'web.banner_cta_label_en', 'web.banner_cta_label_ar', 'web.banner_overlay',
    'web.banner_align', 'web.banner_valign', 'web.banner_text_size', 'web.banner_text_color', 'web.banner_box_width',
  ];
  BANNER_LIVE_FIELDS.forEach((name) => {
    const { input } = bannerForm.inputs.get(name);
    // 'input' covers text/number as you type; 'change' covers the <select>
    // controls, which some browsers only fire 'input' for inconsistently.
    input.addEventListener('input', renderBannerPreview);
    input.addEventListener('change', renderBannerPreview);
  });

  async function loadBannerMeta() {
    try { bannerMeta = await api.get('/api/settings/website/banner'); } catch { bannerMeta = { hasImage: false }; }
    bannerRemoveBtn.disabled = !editable || !bannerMeta.hasImage;
    renderBannerPreview();
  }

  /**
   * Opens the crop dialog for a freshly-chosen file. Nothing is uploaded
   * until Save: picking a photo used to compress-and-PUT immediately, which
   * meant the owner only discovered an awkward crop after opening the shop.
   */
  function openBannerCropModal(file) {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onerror = () => { URL.revokeObjectURL(objectUrl); toastError(new Error(t('photoUnreadable'))); };
    image.onload = () => {
      // naturalWidth/naturalHeight already reflect EXIF orientation: Chromium
      // and Firefox decode <img> sources pre-rotated (image-orientation:
      // from-image is the default), so a portrait phone photo needs no
      // manual correction here.
      const naturalW = image.naturalWidth;
      const naturalH = image.naturalHeight;

      const stage = h('div', { class: 'crop-stage' });
      const imgNode = h('img', { class: 'crop-image', src: objectUrl, alt: '', draggable: false });
      const windowBox = h('div', { class: 'crop-window' });
      stage.append(imgNode, windowBox);

      const zoomSlider = h('input', { type: 'range', min: '1', max: '3', step: '0.01', value: '1' });
      const preview = h('div', { class: 'banner-preview-frame crop-live-preview' });

      let frameX = 0;
      let frameY = 0;
      let frameW = 0;
      let frameH = 0;
      let frameFitScale = 1;
      let scale = 1;
      let imgLeft = 0;
      let imgTop = 0;

      // The image must always fully cover the frame — never letterboxed —
      // so imgLeft/imgTop are clamped to keep the frame's window inside it.
      function clamp() {
        const dispW = naturalW * scale;
        const dispH = naturalH * scale;
        imgLeft = Math.min(0, Math.max(frameW - dispW, imgLeft));
        imgTop = Math.min(0, Math.max(frameH - dispH, imgTop));
      }

      function updatePreview() {
        const previewW = preview.clientWidth || frameW;
        const ratio = previewW / frameW;
        preview.style.backgroundRepeat = 'no-repeat';
        preview.style.backgroundImage = `url(${objectUrl})`;
        preview.style.backgroundSize = `${naturalW * scale * ratio}px ${naturalH * scale * ratio}px`;
        preview.style.backgroundPosition = `${imgLeft * ratio}px ${imgTop * ratio}px`;
        mount(preview, ...bannerOverlayNodes(bannerTextSpec()));
      }

      function applyVisual() {
        const dispW = naturalW * scale;
        const dispH = naturalH * scale;
        imgNode.style.width = `${dispW}px`;
        imgNode.style.height = `${dispH}px`;
        imgNode.style.transform = `translate(${frameX + imgLeft}px, ${frameY + imgTop}px)`;
        updatePreview();
      }

      // Sizes the frame window against the stage's actual rendered size (the
      // stage is responsive), then re-centres the photo at the new scale.
      function layoutFrame() {
        const rect = stage.getBoundingClientRect();
        frameW = rect.width * 0.86;
        frameH = frameW / BANNER_CROP_RATIO;
        if (frameH > rect.height * 0.86) {
          frameH = rect.height * 0.86;
          frameW = frameH * BANNER_CROP_RATIO;
        }
        frameX = (rect.width - frameW) / 2;
        frameY = (rect.height - frameH) / 2;
        windowBox.style.left = `${frameX}px`;
        windowBox.style.top = `${frameY}px`;
        windowBox.style.width = `${frameW}px`;
        windowBox.style.height = `${frameH}px`;

        // Scale so the shorter-relative edge covers the frame — a photo
        // narrower or shorter than the frame is scaled up, never letterboxed.
        frameFitScale = Math.max(frameW / naturalW, frameH / naturalH);
        scale = frameFitScale * Number(zoomSlider.value);
        imgLeft = (frameW - naturalW * scale) / 2;
        imgTop = (frameH - naturalH * scale) / 2;
        clamp();
        applyVisual();
      }

      zoomSlider.addEventListener('input', () => {
        // Zoom around the frame's centre so the point the owner is looking
        // at does not jump when the slider moves.
        const cx = frameW / 2;
        const cy = frameH / 2;
        const imgX = (cx - imgLeft) / scale;
        const imgY = (cy - imgTop) / scale;
        scale = frameFitScale * Number(zoomSlider.value);
        imgLeft = cx - imgX * scale;
        imgTop = cy - imgY * scale;
        clamp();
        applyVisual();
      });

      let dragging = false;
      let dragStart = { x: 0, y: 0, imgLeft: 0, imgTop: 0 };
      stage.addEventListener('pointerdown', (event) => {
        dragging = true;
        stage.classList.add('dragging');
        stage.setPointerCapture(event.pointerId);
        dragStart = { x: event.clientX, y: event.clientY, imgLeft, imgTop };
      });
      stage.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        imgLeft = dragStart.imgLeft + (event.clientX - dragStart.x);
        imgTop = dragStart.imgTop + (event.clientY - dragStart.y);
        clamp();
        applyVisual();
      });
      const endDrag = () => { dragging = false; stage.classList.remove('dragging'); };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);

      const saveBtn = h('button', { class: 'btn primary' }, t('save'));
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          // Map the frame window (in stage pixels) back to the original
          // image's own pixel space, then draw straight into the final size.
          const srcX = -imgLeft / scale;
          const srcY = -imgTop / scale;
          const srcW = frameW / scale;
          const srcH = frameH / scale;
          const canvas = document.createElement('canvas');
          canvas.width = BANNER_CROP_W;
          canvas.height = BANNER_CROP_H;
          canvas.getContext('2d').drawImage(image, srcX, srcY, srcW, srcH, 0, 0, BANNER_CROP_W, BANNER_CROP_H);
          const dataUrl = canvas.toDataURL('image/jpeg', BANNER_JPEG_QUALITY);
          bannerMeta = await api.put('/api/settings/website/banner', { dataUrl });
          renderBannerPreview();
          bannerRemoveBtn.disabled = !editable || !bannerMeta.hasImage;
          toast(t('saved'));
          dialog.close();
        } catch (error) { toastError(error); saveBtn.disabled = false; }
      });

      const dialog = modal({
        title: t('cropBannerTitle'),
        size: 'wide',
        body: h('div', { class: 'crop-body' },
          stage,
          h('div', { class: 'crop-controls' },
            h('span', { class: 'small muted' }, t('cropZoom')),
            zoomSlider),
          h('p', { class: 'crop-hint' }, t('cropDragHint')),
          h('div', { class: 'crop-preview-wrap' },
            h('small', { class: 'muted' }, t('cropPreviewLabel')),
            preview)),
        footer: [
          h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
          saveBtn,
        ],
        onClose: () => URL.revokeObjectURL(objectUrl),
      });

      layoutFrame();
    };
    image.src = objectUrl;
  }

  function onBannerFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toastError(new Error(t('photoNotAnImage'))); return; }
    openBannerCropModal(file);
  }

  async function removeBannerPhoto() {
    if (!await confirmDialog({ title: t('removeBannerPhoto'), message: t('bannerRemoveConfirm'), danger: true })) return;
    try {
      bannerMeta = await api.del('/api/settings/website/banner');
      renderBannerPreview();
      bannerRemoveBtn.disabled = true;
      toast(t('deleted'));
    } catch (error) { toastError(error); }
  }

  const bannerFileInput = h('input', {
    type: 'file', accept: 'image/*', style: { display: 'none' }, disabled: !editable, onchange: onBannerFileChosen,
  });
  const bannerUploadBtn = h('button', {
    class: 'btn sm', disabled: !editable, onclick: () => bannerFileInput.click(),
  }, t('uploadPhoto'));
  const bannerRemoveBtn = h('button', {
    class: 'btn sm ghost', disabled: true, onclick: removeBannerPhoto,
  }, t('removeBannerPhoto'));

  // --- shipping: same mode/fields split the storefront basket and the
  // order service both live by (see src/shared/delivery.js) — flat charges a
  // fee, percent charges goodsTotal * percent with an optional floor/cap,
  // and free_delivery_over overrides either one above a threshold.
  const SHIPPING_EXAMPLE_ORDER = 500;

  const shippingForm = buildForm([
    {
      name: 'shop.delivery_mode', label: t('deliveryMode'), type: 'select', required: true, disabled: !editable,
      options: [
        { value: 'flat', label: t('deliveryModeFlat') },
        { value: 'percent', label: t('deliveryModePercent') },
      ],
    },
    { name: 'shop.delivery_fee', label: t('deliveryFeeAmount'), type: 'number', min: 0, disabled: !editable },
    { name: 'shop.delivery_percent', label: t('deliveryPercent'), type: 'number', min: 0, max: 100, disabled: !editable },
    {
      name: 'shop.delivery_min', label: t('deliveryMin'), type: 'number', min: 0,
      hint: t('deliveryMinHint'), disabled: !editable,
    },
    {
      name: 'shop.delivery_max', label: t('deliveryMax'), type: 'number', min: 0,
      hint: t('deliveryMaxHint'), disabled: !editable,
    },
    {
      name: 'shop.free_delivery_over', label: t('freeDeliveryOverLabel'), type: 'number', min: 0,
      hint: t('freeDeliveryOverHint'), disabled: !editable,
    },
  ], settings, { columns: 3 });

  const shippingExample = h('p', { class: 'shipping-example' });

  /**
   * Mirrors the rule in src/shared/delivery.js (and its storefront twin in
   * public/shop/js/core/store.js) for the worked-example line only — this is
   * illustrative, not authoritative, so it reads straight off the raw form
   * values where 0 means "not set", exactly as the settings themselves store it.
   */
  function deliveryForExample(goodsTotal, s) {
    const freeOver = Number(s['shop.free_delivery_over']) || 0;
    if (freeOver > 0 && goodsTotal >= freeOver) return 0;
    if (s['shop.delivery_mode'] === 'percent') {
      let value = Math.round(goodsTotal * (Number(s['shop.delivery_percent']) || 0) / 100 * 100) / 100;
      const min = Number(s['shop.delivery_min']) || 0;
      const max = Number(s['shop.delivery_max']) || 0;
      if (min > 0 && value < min) value = min;
      if (max > 0 && value > max) value = max;
      return Math.max(0, value);
    }
    return Math.max(0, Math.round((Number(s['shop.delivery_fee']) || 0) * 100) / 100);
  }

  function renderShippingCard() {
    const values = shippingForm.values();
    const mode = values['shop.delivery_mode'] || 'flat';
    const flatOnly = ['shop.delivery_fee'];
    const percentOnly = ['shop.delivery_percent', 'shop.delivery_min', 'shop.delivery_max'];
    flatOnly.forEach((name) => {
      shippingForm.inputs.get(name).holder.style.display = mode === 'flat' ? '' : 'none';
    });
    percentOnly.forEach((name) => {
      shippingForm.inputs.get(name).holder.style.display = mode === 'percent' ? '' : 'none';
    });
    const fee = deliveryForExample(SHIPPING_EXAMPLE_ORDER, values);
    mount(shippingExample, `${t('shippingExamplePrefix')} ${money(SHIPPING_EXAMPLE_ORDER)} → ${t('shippingExampleLabel')} ${fee > 0 ? money(fee) : t('freeDelivery')}`);
  }

  for (const [, { input }] of shippingForm.inputs) {
    input.addEventListener('input', renderShippingCard);
    input.addEventListener('change', renderShippingCard);
  }

  async function saveWebsite() {
    try {
      await api.put('/api/settings', {
        ...bannerForm.values(), ...socialForm.values(), ...contactForm.values(), ...shippingForm.values(),
      });
      toast(t('saved'));
    } catch (error) { toastError(error); }
  }

  const backupsHost = h('div', { class: 'card-body tight' });
  async function loadBackups() {
    if (!can('settings.backup')) return;
    const { rows } = await api.get('/api/settings/backups');
    mount(backupsHost, dataTable({
      columns: [
        { key: 'file', label: t('fileName'), class: 'mono small' },
        { key: 'createdAt', label: t('date'), render: (r) => dateTime(r.createdAt) },
        { key: 'size', label: t('fileSize'), type: 'number', render: (r) => `${(r.size / 1024 / 1024).toFixed(2)} MB` },
        {
          key: '__a',
          label: '',
          render: (r) => h('div', { class: 'row nowrap', style: { justifyContent: 'flex-end', gap: '4px' } },
            h('button', {
              class: 'btn sm',
              onclick: () => api.download(`/api/settings/backups/${r.file}/download`, null, r.file),
            }, t('downloadBackup')),
            h('button', {
              class: 'btn sm',
              onclick: async () => {
                if (!await confirmDialog({ title: t('restore'), message: t('restoreWarning'), danger: true, confirmLabel: t('restore') })) return;
                try { await api.post(`/api/settings/backups/${r.file}/restore`, {}); toast(t('restartRequired'), 'warn', 9000); } catch (e) { toastError(e); }
              },
            }, t('restore')),
            h('button', {
              class: 'btn sm ghost',
              onclick: async () => {
                if (!await confirmDialog({ title: t('delete'), message: t('deleteConfirm'), danger: true })) return;
                await api.del(`/api/settings/backups/${r.file}`);
                loadBackups();
              },
            }, '🗑')),
        },
      ],
      rows,
    }));
  }

  async function saveGeneral() {
    try {
      await api.put('/api/settings', {
        ...company.values(), ...operations.values(), ...returnsForm.values(),
      });
      const location = locationForm.values();
      if (location.name_en) await api.put('/api/location', location);
      await loadSession();
      toast(t('saved'));
    } catch (error) { toastError(error); }
  }

  const TABS = [
    { key: 'company', label: t('company') },
    { key: 'operations', label: t('operatingRules') },
    { key: 'returns', label: t('returnsPolicy') },
    ...(can('settings.view') ? [{ key: 'website', label: t('websiteTab') }] : []),
    { key: 'devices', label: t('devices') },
    ...(can('settings.backup') ? [{ key: 'backups', label: t('backups') }] : []),
  ];

  const body = h('div');

  function renderTab() {
    devicesPanelInstance?.destroy();
    devicesPanelInstance = null;

    if (activeTab === 'devices') {
      devicesPanelInstance = devicesPanel();
      mount(body, devicesPanelInstance.node);
      return;
    }
    if (activeTab === 'backups') {
      mount(body, h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', {}, t('backups')),
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted small' }, t('restoreWarning')),
          h('button', {
            class: 'btn sm primary',
            onclick: async () => {
              try { await api.post('/api/settings/backups', {}); toast(t('saved')); loadBackups(); } catch (e) { toastError(e); }
            },
          }, t('createBackup'))),
        backupsHost));
      loadBackups();
      return;
    }
    if (activeTab === 'website') {
      loadBannerMeta();
      renderShippingCard();
      mount(body,
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('bannerCard'))),
          h('div', { class: 'card-body stack' },
            h('div', {},
              h('small', { class: 'muted' }, t('bannerPreviewLabel')),
              bannerPreview),
            h('div', { class: 'row' },
              bannerUploadBtn, bannerRemoveBtn, bannerFileInput),
            bannerForm.node)),
        h('div', { class: 'card', style: { marginTop: '14px' } },
          h('div', { class: 'card-head' }, h('h3', {}, t('socialCard'))),
          h('div', { class: 'card-body' },
            h('p', { class: 'social-row-hint' }, t('socialHint')),
            socialForm.node)),
        h('div', { class: 'card', style: { marginTop: '14px' } },
          h('div', { class: 'card-head' }, h('h3', {}, t('contactCard'))),
          h('div', { class: 'card-body' },
            h('p', { class: 'contact-note' }, t('contactNote')),
            contactForm.node)),
        h('div', { class: 'card', style: { marginTop: '14px' } },
          h('div', { class: 'card-head' }, h('h3', {}, t('shippingCard'))),
          h('div', { class: 'card-body' },
            shippingForm.node,
            shippingExample)),
        editable ? h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'flex-end' } },
          h('button', { class: 'btn primary', onclick: saveWebsite }, t('save'))) : null);
      return;
    }

    const forms = {
      company: [t('company'), company.node, t('shopLocation'), locationForm.node],
      operations: [t('operatingRules'), operations.node],
      returns: [t('returnsPolicy'), returnsForm.node],
    }[activeTab];

    const cards = [];
    for (let i = 0; i < forms.length; i += 2) {
      cards.push(h('div', { class: 'card', style: i ? { marginTop: '14px' } : undefined },
        h('div', { class: 'card-head' }, h('h3', {}, forms[i])),
        h('div', { class: 'card-body' }, forms[i + 1])));
    }
    mount(body,
      ...cards,
      editable ? h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn primary', onclick: saveGeneral }, t('save'))) : null);
  }

  const tabBar = h('div', { class: 'row', style: { gap: '6px' } },
    ...TABS.map((tab) => h('button', {
      class: `btn ${activeTab === tab.key ? 'primary' : ''}`,
      onclick: () => { activeTab = tab.key; renderShell(); },
    }, tab.label)));

  function renderShell() {
    mount(root,
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', {}, t('settings')), h('p', {}, t('settingsSubtitle'))),
        h('span', { class: 'spacer' })),
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '14px' } },
        ...TABS.map((tab) => h('button', {
          class: `btn ${activeTab === tab.key ? 'primary' : ''}`,
          onclick: () => { activeTab = tab.key; renderShell(); },
        }, tab.label))),
      body);
    renderTab();
  }

  renderShell();
  return () => devicesPanelInstance?.destroy();
}
