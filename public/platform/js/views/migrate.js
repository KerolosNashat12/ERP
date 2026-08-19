/**
 * Fleet migrations: one button, one request, one report — legible even when
 * half the fleet failed. Nothing here is persisted; it shows the result of
 * the run just made, in this session.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, tag, toast, toastError,
} from '../core/dom.js';
import { t } from '../core/i18n.js';

export async function migrateView(root) {
  const resultsHost = h('div', {}, h('div', { class: 'empty' },
    h('span', { class: 'ico' }, '⇅'),
    h('div', {}, t('migrationEmpty'))));

  const runBtn = h('button', { class: 'btn primary lg' }, t('runMigration'));

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('migrations')),
        h('p', {}, t('migrationsSubtitle')))),
    h('div', { class: 'card' },
      h('div', { class: 'card-body row between' },
        h('div', { class: 'muted small' }, t('migrationHint')),
        runBtn)),
    h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('h3', {}, t('migrationResults'))),
      h('div', { class: 'card-body tight' }, resultsHost)));

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    const originalLabel = runBtn.textContent;
    runBtn.textContent = t('runningMigration');
    try {
      const { rows } = await api.post('/migrate', {});
      renderResults(resultsHost, rows);
      const failed = rows.filter((r) => r.error).length;
      toast(failed ? `${rows.length - failed}/${rows.length}` : t('saved'), failed ? 'warn' : 'ok');
    } catch (error) {
      toastError(error);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = originalLabel;
    }
  });
}

function renderResults(host, rows) {
  const total = rows.length;
  const failed = rows.filter((r) => r.error).length;
  const ok = total - failed;

  const summary = h('div', { class: 'card-body', style: { borderBottom: '1px solid var(--line)' } },
    h('div', { class: 'migrate-summary' },
      h('div', {},
        h('div', { class: 'n', style: { color: 'var(--ok)' } }, ok),
        h('div', { class: 'small muted' }, t('migratedOk'))),
      failed ? h('div', {},
        h('div', { class: 'n', style: { color: 'var(--danger)' } }, failed),
        h('div', { class: 'small muted' }, t('migratedError'))) : null,
      h('div', {},
        h('div', { class: 'small', style: { marginTop: '6px', color: 'var(--ink-2)' } },
          failed
            ? t('migrationSummaryWithErrors', { ok, total, failed })
            : t('migrationSummary', { ok, total })))));

  const table = dataTable({
    // Failures sort first — a fleet migration that half-worked must be
    // legible at a glance, not buried under the shops that succeeded.
    rows: [...rows].sort((a, b) => (b.error ? 1 : 0) - (a.error ? 1 : 0)),
    columns: [
      { label: t('tenant'), render: (row) => h('span', { class: 'tenant-slug strong' }, row.slug) },
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
        render: (row) => (row.error ? h('span', { class: 'small', style: { color: 'var(--danger)' } }, row.error) : '—'),
      },
    ],
  });

  mount(host, summary, table);
}
