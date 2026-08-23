/**
 * One shop's backups: what exists, how to get it, and the one dangerous button
 * on this console.
 *
 * ── Downloading ──────────────────────────────────────────────────────────────
 * Two requests, and the shape is deliberate. `POST …/download-ticket` mints a
 * single-use ticket that lives for two minutes; the browser is then sent to
 * `GET …/backups/download/<ticket>`, which still requires the owner's session as
 * well. So the address that carries the bytes is worth nothing in a chat
 * message, a browser history or a proxy log — which matters more here than
 * anywhere else in this console, because the file at the end of it is the
 * shop's entire book.
 *
 * The navigation is a plain `location.assign` rather than `fetch` + a Blob URL,
 * because a backup can be tens of megabytes: fetching it into JavaScript first
 * would hold the whole thing in the tab's memory and give the reader no
 * progress bar. Handing the URL to the browser lets it stream to disk and show
 * its own.
 *
 * ── Restoring ────────────────────────────────────────────────────────────────
 * Never one click, and never from a file the owner chose. See `restoreDialog`.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, tag, toast, toastError, modal, textInput, field,
} from '../core/dom.js';
import { t } from '../core/i18n.js';
import { card, kpi, kpiRow } from '../ui/page.js';
import {
  loadInto, skCard, skRows, emptyState, state,
} from '../ui/states.js';
import { dateTime, relative, bytes, int } from '../ui/format.js';
import icons from '../ui/icons.js';

const KIND_LABEL = {
  scheduled: 'kindScheduled',
  manual: 'kindManual',
  pre_restore: 'kindPreRestore',
};

const STATE_LABEL = { ready: 'stateReady', failed: 'stateFailed', running: 'stateRunning' };
const STATE_TONE = { ready: 'ok', failed: 'danger', running: 'warn' };

export function backupsPanel(slug) {
  const host = h('div', {});
  let reload = () => {};

  const takeButton = h('button', { class: 'btn primary' },
    h('span', { html: icons.box }), t('takeBackup'));

  takeButton.addEventListener('click', async () => {
    takeButton.disabled = true;
    const label = takeButton.textContent;
    takeButton.textContent = t('takingBackup');
    try {
      await api.post(`/tenants/${slug}/backups`, {});
      toast(t('backupTaken'));
      await reload();
    } catch (error) {
      toastError(error);
    } finally {
      takeButton.disabled = false;
      takeButton.textContent = label;
    }
  });

  reload = loadInto(host, {
    skeleton: () => skCard(skRows(5, 5), true),
    load: () => api.get(`/tenants/${slug}/backups`),
    render: (data, again) => renderBackups(slug, data, again, takeButton),
  });

  const panel = h('div', {}, host);
  panel.reload = () => reload();
  return panel;
}

function renderBackups(slug, data, reload, takeButton) {
  const ready = data.rows.filter((row) => row.status === 'ready');
  const stored = ready.reduce((sum, row) => sum + Number(row.byteSize || 0), 0);
  const newest = ready[0];

  return h('div', { class: 'stack' },
    kpiRow(
      kpi({
        label: t('backupWhen'),
        value: newest ? (relative(newest.takenAt) || dateTime(newest.takenAt)) : t('backupNever'),
        sub: newest ? dateTime(newest.takenAt) : t('noBackupsTitle'),
        tone: newest ? 'accent' : 'danger',
      }),
      kpi({ label: t('backupsStored'), value: bytes(stored), sub: `${int(ready.length)} × ${t('backupsTitle')}` }),
      kpi({
        label: t('backupsKept'),
        value: String(data.keep.scheduled + data.keep.manual + data.keep.pre_restore),
        sub: t('keepRule', data.keep),
      }),
      kpi({ label: t('backupCeiling'), value: bytes(data.maxBytes), sub: t('backupCeilingHint') }),
    ),
    card({
      title: t('backupsTitle'),
      subtitle: t('backupsSubtitle'),
      actions: [takeButton],
      tight: true,
      body: data.rows.length
        ? backupsTable(slug, data.rows, reload)
        : emptyState({
          icon: 'box', title: t('noBackupsTitle'), message: t('noBackupsBody'),
        }),
    }),
    card({
      title: t('downloadCareTitle'),
      body: h('div', { class: 'stack', style: { gap: 'var(--s2)' } },
        h('p', { class: 'small muted', style: { margin: 0 } }, t('downloadCareBody')),
        h('p', { class: 'small muted', style: { margin: 0 } }, t('downloadWhatBody'))),
    }));
}

function backupsTable(slug, rows, reload) {
  return dataTable({
    rows,
    columns: [
      {
        label: t('backupWhen'),
        render: (row) => h('div', { class: 'cell-title' },
          h('span', { class: 'name' }, dateTime(row.takenAt)),
          h('span', { class: 'sub' }, relative(row.takenAt) || '')),
      },
      {
        label: t('backupKind'),
        render: (row) => tag(t(KIND_LABEL[row.kind] || row.kind), row.kind === 'pre_restore' ? 'warn' : 'info'),
      },
      {
        label: t('backupState'),
        render: (row) => h('div', { class: 'stack', style: { gap: '4px' } },
          tag(t(STATE_LABEL[row.status] || row.status), STATE_TONE[row.status] || ''),
          row.status === 'failed'
            ? h('span', { class: 'sub', title: row.error || '' }, row.error || t('backupFailedHint'))
            : null,
          row.truncatedSheets?.length
            ? h('span', { class: 'sub' }, t('backupTruncated'))
            : null),
      },
      {
        label: t('backupSize'),
        align: 'end',
        render: (row) => h('span', { class: 'small', dir: 'ltr' }, bytes(row.byteSize)),
      },
      {
        label: t('backupRows'),
        align: 'end',
        class: 'col-lo',
        render: (row) => h('span', { class: 'small muted', dir: 'ltr' }, int(row.rowCount)),
      },
      {
        label: '',
        align: 'end',
        render: (row) => (row.status !== 'ready' ? h('span', { class: 'muted' }, '—')
          : h('div', { class: 'row-actions' },
            downloadButton(slug, row),
            h('button', {
              class: 'btn sm danger',
              onclick: () => restoreDialog(slug, row, reload),
            }, t('restore')))),
      },
    ],
  });
}

function downloadButton(slug, row) {
  const button = h('button', { class: 'btn sm' }, t('download'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = t('preparingDownload');
    try {
      const ticket = await api.post(`/tenants/${slug}/backups/${row.id}/download-ticket`, {});
      // Handed to the browser, not fetched into this tab: a backup is tens of
      // megabytes and belongs on the reader's disk, streamed, with the
      // browser's own progress bar.
      window.location.assign(`/api/platform/backups/download/${encodeURIComponent(ticket.token)}`);
      toast(t('downloadStarted'));
    } catch (error) {
      toastError(error);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  return button;
}

/**
 * The restore dialog.
 *
 * Three deliberate obstacles, each answering a different way this goes wrong:
 *
 *  1. It opens by ASKING THE SERVER what would happen, and shows the answer —
 *     row counts now against row counts after. "Restore" is a word; "your 412
 *     sales become 380" is a decision. The server's answer carries a ticket
 *     that names this backup and this shop and dies in five minutes, so what
 *     runs is provably what was approved.
 *  2. The shop's short name has to be TYPED. A confirm button says "yes"; the
 *     name says "yes, this shop", which is the question that actually matters
 *     when six shops look alike in a list.
 *  3. The steps are spelled out before the button is reachable — including that
 *     the shop is suspended, that a safety copy is taken first, and that a
 *     failed restore leaves the shop stopped rather than quietly trading.
 *
 * There is no "restore from a file I have" anywhere on this screen. A snapshot
 * can only be chosen from the ones the control plane holds FOR THIS SHOP, which
 * is what makes restoring into the wrong shop structurally impossible rather
 * than merely discouraged — the list a person picks from cannot contain another
 * shop's backup.
 */
async function restoreDialog(slug, row, reload) {
  const body = h('div', {}, state({ icon: 'clock', title: t('planning') }));
  const confirm = h('button', { class: 'btn danger', disabled: true }, t('restoreConfirm'));
  const dialog = modal({
    title: t('restoreTitle', { when: dateTime(row.takenAt) }),
    size: 'wide',
    body,
    footer: [h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')), confirm],
  });

  let ticket = null;
  try {
    const planned = await api.post(`/tenants/${slug}/backups/${row.id}/restore-plan`, {});
    ticket = planned.token;
    mount(body, planPanel(slug, planned.plan, confirm));
  } catch (error) {
    mount(body, state({ kind: 'error', icon: 'alert', title: t('couldNotLoad'), message: error.message }));
    return;
  }

  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    confirm.textContent = t('restoreRunning');
    try {
      const result = await api.post(`/tenants/${slug}/backups/restore`, {
        ticket,
        confirmSlug: body.querySelector('[data-slug-confirm]')?.value || '',
      });
      dialog.close();
      toast(t('restoreDone', { rows: int(result.rows), tables: int(result.tables) }), 'ok', 6000);
      toast(t('restoreSafety'), 'ok', 7000);
      await reload();
    } catch (error) {
      confirm.textContent = t('restoreConfirm');
      confirm.disabled = false;
      toastError(error);
    }
  });
}

const COMPARE = ['users', 'products', 'customers', 'sales', 'purchase_orders'];
const COMPARE_LABEL = {
  users: 'usersTotal',
  products: 'productsTotal',
  customers: 'customers',
  sales: 'sales',
  purchase_orders: 'purchases',
};

function planPanel(slug, plan, confirm) {
  const confirmInput = textInput({ placeholder: slug, autocomplete: 'off', spellcheck: 'false' });
  confirmInput.dataset.slugConfirm = '1';
  confirmInput.dir = 'ltr';

  const hint = h('span', { class: 'small muted' });
  confirmInput.addEventListener('input', () => {
    const match = confirmInput.value.trim() === slug;
    confirm.disabled = !match;
    hint.textContent = confirmInput.value && !match ? t('restoreSlugMismatch') : '';
  });

  return h('div', { class: 'stack' },
    h('p', { style: { margin: 0 } }, t('restoreLead', { slug })),

    card({
      title: t('restoreCompare'),
      tight: true,
      body: dataTable({
        rows: COMPARE.filter((key) => plan.before[key] !== undefined),
        columns: [
          { label: '', render: (key) => h('span', { class: 'small strong' }, t(COMPARE_LABEL[key] || key)) },
          {
            label: t('restoreNow'),
            align: 'end',
            render: (key) => h('span', { dir: 'ltr' }, plan.before[key] === null ? '—' : int(plan.before[key])),
          },
          {
            label: t('restoreAfter'),
            align: 'end',
            render: (key) => h('span', {
              dir: 'ltr',
              class: plan.before[key] !== plan.after[key] ? 'strong' : 'muted',
            }, plan.after[key] === null ? '—' : int(plan.after[key])),
          },
        ],
      }),
    }),

    card({
      title: t('restoreStepsTitle'),
      body: h('ol', { class: 'small', style: { margin: 0, paddingInlineStart: '18px', lineHeight: '1.9' } },
        h('li', {}, t('restoreStep1')),
        h('li', {}, t('restoreStep2')),
        h('li', {}, t('restoreStep3')),
        h('li', {}, t('restoreStep4'))),
    }),

    h('div', { class: 'danger-zone' },
      field({ label: t('restoreTypeSlug'), input: confirmInput }),
      hint));
}

export default backupsPanel;
