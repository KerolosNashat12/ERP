/**
 * Fleet migrations: one button, one request, one report — legible even when
 * half the fleet failed. Nothing here is persisted; it shows the result of the
 * run just made, in this session.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, tag, toast, toastError,
} from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageHead, card } from '../ui/page.js';
import { state, skRows } from '../ui/states.js';
import { int } from '../ui/format.js';
import icons from '../ui/icons.js';

export async function migrateView(root) {
  const resultsHost = h('div', {}, state({
    icon: 'arrows',
    title: t('migrationNotRun'),
    message: t('migrationEmpty'),
  }));

  const runButton = h('button', { class: 'btn primary lg' },
    h('span', { html: icons.arrows }), t('runMigration'));

  mount(root,
    pageHead({ title: t('migrations'), subtitle: t('migrationsSubtitle') }),
    h('div', { class: 'stack' },
      card({
        body: h('div', { class: 'row between' },
          h('div', { class: 'muted small', style: { maxWidth: '58ch' } }, t('migrationHint')),
          runButton),
      }),
      card({ title: t('migrationResults'), tight: true, body: resultsHost })));

  runButton.addEventListener('click', async () => {
    runButton.disabled = true;
    const label = runButton.textContent;
    runButton.textContent = t('runningMigration');
    mount(resultsHost, skRows(4, 4));
    try {
      const { rows } = await api.post('/migrate', {});
      renderResults(resultsHost, rows);
      const failed = rows.filter((row) => row.error).length;
      toast(failed ? t('migrationSummaryWithErrors', { ok: rows.length - failed, total: rows.length, failed })
        : t('migrationSummary', { ok: rows.length, total: rows.length }), failed ? 'warn' : 'ok');
    } catch (error) {
      mount(resultsHost, state({
        kind: 'error', icon: 'alert', title: t('couldNotLoad'), message: error?.message || t('somethingWrong'),
      }));
      toastError(error);
    } finally {
      runButton.disabled = false;
      runButton.textContent = label;
    }
  });
}

function renderResults(host, rows) {
  const total = rows.length;
  const failed = rows.filter((row) => row.error).length;
  const ok = total - failed;

  const summary = h('div', {
    class: 'card-body',
    style: { borderBottom: '1px solid var(--line)' },
  },
  h('div', { class: 'migrate-summary' },
    h('div', {},
      h('div', { class: 'n', style: { color: 'var(--ok)' } }, int(ok)),
      h('div', { class: 'small muted' }, t('migratedOk'))),
    failed ? h('div', {},
      h('div', { class: 'n', style: { color: 'var(--danger)' } }, int(failed)),
      h('div', { class: 'small muted' }, t('migratedError'))) : null,
    h('div', { class: 'small', style: { color: 'var(--ink-2)', paddingBottom: '4px' } },
      failed
        ? t('migrationSummaryWithErrors', { ok, total, failed })
        : t('migrationSummary', { ok, total }))));

  const table = dataTable({
    // Failures sort first — a fleet migration that half-worked must be legible
    // at a glance, not buried under the shops that succeeded.
    rows: [...rows].sort((a, b) => (b.error ? 1 : 0) - (a.error ? 1 : 0)),
    rowClass: (row) => (row.error ? 'is-error' : ''),
    columns: [
      { label: t('tenant'), render: (row) => h('span', { class: 'mono strong' }, row.slug) },
      {
        label: t('outcome'),
        render: (row) => (row.error ? tag(t('migratedError'), 'danger') : tag(t('migratedOk'), 'ok')),
      },
      {
        label: t('applied'),
        render: (row) => (row.applied && row.applied.length
          ? h('span', { class: 'small mono' }, row.applied.join(', '))
          : h('span', { class: 'small muted' }, t('noneApplied'))),
      },
      {
        label: t('error'),
        render: (row) => (row.error
          ? h('span', { class: 'small', style: { color: 'var(--danger)' } }, row.error)
          : h('span', { class: 'muted' }, '—')),
      },
    ],
  });

  mount(host, summary, table);
}

export default migrateView;
