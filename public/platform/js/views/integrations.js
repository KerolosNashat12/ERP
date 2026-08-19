/**
 * Integrations — today, one: Turso.
 *
 * The screen exists because of a sentence an owner should never have to read:
 * "set TURSO_API_TOKEN on the host". He has the token. He is in the console.
 * The only reason it used to live in an environment variable is that nobody
 * had written this dialog.
 *
 * Two entrances, one dialog. This screen is the one you find by looking; the
 * one that matters is the button inside the create-shop form, at the exact
 * moment the automatic option would otherwise be greyed out. Both call
 * `openTursoDialog`, and neither owns it — which is why it lives here as an
 * export rather than inside either screen.
 *
 * What the dialog never does: show a token back. Not on this screen, not
 * masked, not after a successful connect. There is nothing useful to show, and
 * a masked secret on a screen only teaches an owner that it is safe to have
 * secrets on screens.
 */
import api from '../core/api.js';
import {
  h, mount, modal, toast, toastError, field, passwordInput, selectInput, confirmDialog,
} from '../core/dom.js';
import { t } from '../core/i18n.js';
import { refreshPlatformEnvironment } from '../core/environment.js';
import { pageHead, card } from '../ui/page.js';
import { loadInto, state, skRows } from '../ui/states.js';
import { int, dateTime, DASH } from '../ui/format.js';
import icons from '../ui/icons.js';

/** Where the token is made, said once, in the place it is asked for. */
const TURSO_DASHBOARD = 'https://app.turso.tech';

/**
 * The dialog. `onConnected(status)` is called after the token is verified and
 * stored, and after the console's cached view of what this deployment can do
 * has been refreshed — so a caller can rely on `platformEnvironment()` already
 * telling the truth by the time it runs.
 */
export function openTursoDialog({ onConnected } = {}) {
  const tokenInput = passwordInput({ dir: 'ltr', autocomplete: 'off', placeholder: '••••••••••••••••' });

  /**
   * Only ever built from a list the server has just fetched with this very
   * token. An owner should not have to know what an organisation slug is, and
   * he certainly should not have to remember one — so the choice is only asked
   * for when the token genuinely sees more than one, and then it is a list of
   * what exists, not a text box.
   */
  const orgSelect = selectInput({ options: [], dir: 'ltr' });
  const orgField = field({ label: t('tursoOrgLabel'), input: orgSelect, hint: t('tursoOrgHint') });
  orgField.style.display = 'none';

  const errorSlot = h('div', {});
  const showError = (message) => mount(errorSlot,
    h('div', { class: 'otp-warn' }, message));
  const clearError = () => mount(errorSlot);

  tokenInput.addEventListener('input', clearError);

  const connect = h('button', { class: 'btn primary' }, t('tursoConnectAction'));

  const dialog = modal({
    title: t('tursoDialogTitle'),
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small', style: { margin: 0 } }, t('tursoDialogLead')),
      h('div', { class: 'panel small' },
        h('div', { class: 'row tight' },
          h('a', {
            class: 'btn ghost sm',
            href: TURSO_DASHBOARD,
            target: '_blank',
            rel: 'noopener',
          }, h('span', { html: icons.external }), 'app.turso.tech'),
          h('span', { class: 'muted' }, t('tursoWhereFrom')))),
      field({
        label: `${t('tursoTokenLabel')} *`,
        input: tokenInput,
        hint: t('tursoTokenHint'),
      }),
      orgField,
      errorSlot),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      connect,
    ],
  });

  connect.addEventListener('click', async () => {
    const apiToken = tokenInput.value.trim();
    if (!apiToken) {
      showError(t('tursoTokenRequired'));
      tokenInput.focus();
      return;
    }

    clearError();
    connect.disabled = true;
    const label = connect.textContent;
    connect.textContent = t('tursoVerifying');
    try {
      const body = { apiToken };
      // Only sent once the owner has actually picked from the list below.
      if (orgField.style.display !== 'none' && orgSelect.value) body.org = orgSelect.value;

      const status = await api.put('/integrations/turso', body);
      await refreshPlatformEnvironment();
      dialog.close();
      toast(t('tursoConnectedToast', { org: status.org }));
      if (onConnected) await onConnected(status);
    } catch (error) {
      /**
       * One organisation is adopted silently; several is the only case where
       * the owner is asked anything — and he is asked with the list in front of
       * him, fetched a moment ago by his own token, rather than being told to
       * go and find a slug.
       */
      if (error.code === 'TURSO_MANY_ORGS' && error.details?.organisations?.length) {
        mount(orgSelect, ...error.details.organisations.map((org) => h('option', {
          value: org.slug,
        }, org.name && org.name !== org.slug ? `${org.name} (${org.slug})` : org.slug)));
        orgSelect.value = error.details.organisations[0].slug;
        orgField.style.display = '';
        showError(t('tursoChooseOrg'));
      } else {
        showError(error.message || t('somethingWrong'));
      }
    } finally {
      connect.disabled = false;
      connect.textContent = label;
    }
  });

  return dialog;
}

/**
 * One fact, labelled — the same shape the shop-detail screen uses for "where
 * this shop's data lives", because this card answers the same kind of question
 * and an owner reading both in one sitting should not have to learn two
 * layouts. Deliberately not a KPI tile or a metric strip: those are for
 * figures being compared, and none of these three is.
 */
const factRow = (label, value) => h('div', { class: 'row between tight' },
  h('span', { class: 'small muted' }, label),
  value instanceof Node ? value : h('span', { class: 'small strong' }, value));

/** The card, connected or not. `reload` is the screen's own loader. */
function tursoCard(status, reload) {
  if (!status.connected) {
    return card({
      title: t('tursoTitle'),
      subtitle: t('tursoSubtitle'),
      body: state({
        icon: 'box',
        title: t('tursoNotConnectedTitle'),
        message: t('tursoNotConnectedBody'),
        action: h('button', {
          class: 'btn primary lg',
          onclick: () => openTursoDialog({ onConnected: () => reload() }),
        }, t('tursoConnect')),
      }),
    });
  }

  const disconnect = h('button', { class: 'btn danger sm' }, t('tursoDisconnect'));
  disconnect.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('tursoDisconnectConfirmTitle'),
      message: t('tursoDisconnectConfirmBody'),
      confirmLabel: t('tursoDisconnect'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del('/integrations/turso');
      await refreshPlatformEnvironment();
      toast(t('tursoDisconnectedToast'), 'warn');
      reload();
    } catch (error) {
      toastError(error);
    }
  });

  return card({
    title: t('tursoTitle'),
    subtitle: t('tursoSubtitle'),
    actions: [
      h('span', { class: 'tag ok' }, t('tursoConnected')),
      h('button', {
        class: 'btn ghost sm',
        onclick: () => openTursoDialog({ onConnected: () => reload() }),
      }, t('tursoReplace')),
      disconnect,
    ],
    body: h('div', { class: 'stack' },
      h('div', { class: 'panel stack', style: { gap: 'var(--s2)' } },
        factRow(t('tursoOrg'), h('span', { class: 'mono small strong', dir: 'ltr' }, status.org)),
        factRow(t('tursoGroup'), h('span', { class: 'mono small', dir: 'ltr' }, status.group || DASH)),
        // Null means the live count could not be taken — the reason is printed
        // below rather than a zero being invented, which would read as "your
        // account is empty" when it means "we could not ask".
        factRow(t('tursoDatabases'), h('span', { class: 'small strong', dir: 'ltr' },
          status.databases === null ? DASH : int(status.databases)))),
      status.error
        ? h('div', { class: 'otp-warn' }, status.error)
        : h('div', { class: 'otp-note' }, t('tursoWorkingNote')),
      status.source === 'environment'
        ? h('div', { class: 'small muted' }, t('tursoFromEnvironment'))
        : h('div', { class: 'small muted' }, t('tursoSecretNote')),
      status.checkedAt
        ? h('div', { class: 'as-of' }, t('tursoCheckedAt', { time: dateTime(status.checkedAt) }))
        : null),
  });
}

export async function integrationsView(root) {
  const body = h('div', {});
  mount(root,
    pageHead({ title: t('integrations'), subtitle: t('integrationsSubtitle') }),
    body);

  loadInto(body, {
    skeleton: () => skRows(3, 3),
    load: () => api.get('/integrations/turso'),
    render: (status, reload) => tursoCard(status, reload),
  });
}

export default integrationsView;
