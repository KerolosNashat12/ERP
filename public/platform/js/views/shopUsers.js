/**
 * Who works in this shop, and the one thing the owner can do about it from
 * here: hand somebody a password.
 *
 * `GET /tenants/:slug/users` is a read of that shop's own `users` table with
 * `password_hash` never selected. The reset is the only write on this tab, and
 * it is deliberately not a hover-only affordance — this gets used on a laptop
 * trackpad at 1am, when a cashier is standing at a till that will not let them
 * in, so the button is a button and it is always there.
 *
 * The reset returns a password that exists exactly once, in the dialog it is
 * shown in. `withLinks: false` on that dialog: the person reading it is fixing
 * one member of staff, not opening a shop, and the two links would be noise.
 */
import api from '../core/api.js';
import {
  h, dataTable, tag, toastError, confirmDialog,
} from '../core/dom.js';
import { t } from '../core/i18n.js';
import { card } from '../ui/page.js';
import { loadInto, skCard, skRows, emptyState } from '../ui/states.js';
import { relative, dateTime } from '../ui/format.js';
import { showOneTimePassword } from './otp.js';
import { roleName } from './shopRoles.js';
import { readShop } from './shopFetch.js';

export function usersPanel(slug) {
  const host = h('div', {});
  let reload = () => {};

  reload = loadInto(host, {
    skeleton: () => skCard(skRows(6, 5), true),
    load: () => readShop(api.get(`/tenants/${slug}/users`)),
    render: (data) => card({
      title: t('usersTitle'),
      subtitle: t('usersSubtitle'),
      tight: true,
      body: usersTable(slug, data.rows || [], () => reload()),
    }),
  });

  const panel = h('div', {}, host);
  panel.reload = () => reload();
  return panel;
}

function usersTable(slug, rows, reload) {
  if (!rows.length) {
    return emptyState({ icon: 'users', title: t('noUsersTitle'), message: t('noUsersBody') });
  }

  return dataTable({
    rows,
    columns: [
      {
        label: t('userColumn'),
        render: (row) => h('div', { class: 'cell-title' },
          h('span', { class: 'name' }, row.fullName || row.username),
          h('span', { class: 'sub mono', dir: 'ltr' }, `@${row.username}`)),
      },
      {
        label: t('roleColumn'),
        render: (row) => (row.role
          ? tag(roleName(row.role), row.role === 'admin' ? 'brand' : 'quiet')
          : h('span', { class: 'muted' }, '—')),
      },
      {
        label: t('status'),
        render: (row) => h('div', { class: 'row tight' },
          h('span', { class: 'status-cell' },
            h('span', { class: `status-dot ${row.isActive ? 'active' : 'suspended'}` }),
            row.isActive ? t('active') : t('inactiveUser')),
          // A one-time password still in play is the answer to "they say they
          // cannot get in" often enough to earn its own chip.
          row.mustChangePassword
            ? h('span', { class: 'tag warn', title: t('mustChangePasswordHint') }, t('mustChangePasswordTag'))
            : null),
      },
      {
        label: t('email'),
        class: 'col-lo',
        render: (row) => (row.email
          ? h('span', { class: 'small muted mono', dir: 'ltr' }, row.email)
          : h('span', { class: 'muted' }, '—')),
      },
      {
        label: t('lastSignIn'),
        render: (row) => (row.lastLoginAt
          ? h('span', { class: 'small nowrap', title: dateTime(row.lastLoginAt) }, relative(row.lastLoginAt))
          : h('span', { class: 'small muted nowrap' }, t('neverSignedIn'))),
      },
      {
        label: '',
        align: 'end',
        render: (row) => h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm',
            onclick: (event) => {
              event.stopPropagation();
              resetPassword(slug, row, reload);
            },
          }, t('resetPassword'))),
      },
    ],
  });
}

async function resetPassword(slug, user, reload) {
  const name = user.fullName || user.username;
  const confirmed = await confirmDialog({
    title: t('resetUserConfirmTitle'),
    message: t('resetUserConfirmBody', { name }),
    confirmLabel: t('resetPassword'),
    danger: true,
  });
  if (!confirmed) return;

  try {
    const result = await api.post(`/tenants/${slug}/users/${user.id}/reset-password`, {});
    showOneTimePassword({
      slug,
      username: result.username || user.username,
      password: result.oneTimePassword,
      headline: t('staffPasswordReset', { name }),
      withLinks: false,
    });
    // `must_change_password` is now set on that row, and the chip that says so
    // is half the point of the table.
    reload();
  } catch (error) {
    toastError(error);
  }
}

export default usersPanel;
