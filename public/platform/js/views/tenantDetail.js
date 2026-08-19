/** Manage a single tenant: edit, suspend/resume, reset password, jump in. */
import api from '../core/api.js';
import {
  h, mount, toast, toastError, tag, confirmDialog, spinner,
} from '../core/dom.js';
import { t, pickName, getLanguage } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import { buildTenantFields } from './tenantForm.js';
import { showOneTimePassword } from './otp.js';

export async function tenantDetailView(root, route) {
  const slug = route.segments[1];
  mount(root, spinner(t('loading')));

  let tenant;
  try {
    tenant = await api.get(`/tenants/${slug}`);
  } catch (error) {
    toastError(error);
    navigate('tenants', true);
    return;
  }

  await paint(root, tenant);
}

async function paint(root, tenant) {
  const form = buildTenantFields(tenant, { withSlug: false });
  const saveBtn = h('button', { class: 'btn primary' }, t('save'));

  const statsHost = h('div', { class: 'kpis' }, spinner(t('loading')));
  api.get(`/tenants/${tenant.slug}/stats`).then((stats) => {
    mount(statsHost,
      kpi(t('usersStat'), stats.users),
      kpi(t('productsStat'), stats.products),
      kpi(t('sales30dStat'), stats.sales30d),
      kpi(t('lastActive'), stats.lastActivityAt ? formatDateTime(stats.lastActivityAt) : t('never')));
  }).catch(() => { mount(statsHost, h('div', { class: 'muted small' }, t('somethingWrong'))); });

  const erpUrl = `${window.location.origin}/t/${tenant.slug}`;
  const shopUrl = `${window.location.origin}/t/${tenant.slug}/shop`;

  const statusTag = tag(
    tenant.status === 'active' ? t('active') : t('suspended'),
    tenant.status === 'active' ? 'ok' : 'danger',
  );

  const suspendResumeBtn = tenant.status === 'active'
    ? h('button', {
      class: 'btn danger',
      onclick: () => handleSuspendResume(root, tenant, 'suspend'),
    }, t('suspendTenant'))
    : h('button', {
      class: 'btn primary',
      onclick: () => handleSuspendResume(root, tenant, 'resume'),
    }, t('resumeTenant'));

  mount(root,
    h('div', {},
      h('div', {
        class: 'back-link', onclick: () => navigate('tenants'),
      }, getLanguage() === 'ar' ? `${t('backToTenants')} ←` : `← ${t('backToTenants')}`),
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, pickName(tenant), ' ', h('span', { class: 'small mono muted' }, `/t/${tenant.slug}`)),
          h('p', {}, statusTag, ' · ', databaseSummary(tenant), ' · ', t('createdAt'), ' ', formatDateTime(tenant.createdAt))),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn', href: erpUrl, target: '_blank', rel: 'noopener' }, `${t('openErp')} ↗`),
        h('a', { class: 'btn', href: shopUrl, target: '_blank', rel: 'noopener' }, `${t('openStorefront')} ↗`)),

      statsHost,

      h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-head' }, h('h3', {}, t('editTenant'))),
        h('div', { class: 'card-body stack' },
          ...form.nodes,
          h('div', { class: 'row' },
            h('span', { class: 'spacer' }),
            saveBtn))),

      h('div', { class: 'danger-zone', style: { marginTop: '16px' } },
        h('h4', {}, t('dangerZone')),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          suspendResumeBtn,
          h('button', { class: 'btn', onclick: () => handleResetPassword(tenant) }, t('resetAdminPassword')))),
    ));

  saveBtn.addEventListener('click', async () => {
    if (!form.validate()) return;
    const values = form.values();
    saveBtn.disabled = true;
    try {
      const updated = await api.put(`/tenants/${tenant.slug}`, values);
      toast(t('saved'));
      await paint(root, updated);
    } catch (error) {
      toastError(error);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

function kpi(label, value) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value));
}

async function handleSuspendResume(root, tenant, action) {
  const confirmed = await confirmDialog({
    title: t(action === 'suspend' ? 'suspendConfirmTitle' : 'resumeConfirmTitle'),
    message: t(action === 'suspend' ? 'suspendConfirmBody' : 'resumeConfirmBody'),
    confirmLabel: t(action === 'suspend' ? 'suspendTenant' : 'resumeTenant'),
    danger: action === 'suspend',
  });
  if (!confirmed) return;
  try {
    const updated = await api.post(`/tenants/${tenant.slug}/${action}`, {});
    toast(t(action === 'suspend' ? 'suspended_action' : 'resumed_action'));
    await paint(root, updated);
  } catch (error) {
    toastError(error);
  }
}

async function handleResetPassword(tenant) {
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
      adminUsername: result.adminUsername,
      adminPassword: result.adminPassword,
      headline: t('passwordReset'),
    });
  } catch (error) {
    toastError(error);
  }
}

/**
 * Where this shop's data lives, said out loud on the page that manages it —
 * an owner looking at a suspend button should be able to see at a glance
 * whether they are about to affect a file on this machine or a database on the
 * internet. The auth token is reported as set or not set and never printed:
 * the API does not return it, and this line is exactly the kind of place a
 * screenshot gets taken.
 */
function databaseSummary(tenant) {
  const database = tenant.database || {};
  if (database.driver !== 'libsql') return tag(t('dataLocationFileShort'), '');
  return h('span', {},
    tag(t('dataLocationHostedShort'), 'ok'),
    ' ',
    h('span', { class: 'small mono muted', dir: 'ltr' }, database.url || ''),
    ' ',
    h('span', { class: 'small muted' }, database.hasAuthToken ? t('tokenSet') : t('tokenNotSet')));
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(getLanguage() === 'ar' ? 'ar-EG' : 'en-GB', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}
