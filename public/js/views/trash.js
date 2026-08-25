/**
 * سلة المهملات — the recycle bin screen.
 *
 * What a person needs from this page, in order:
 *   1. how full it is, and how much of it is about to be destroyed;
 *   2. what is in it, what it was, who deleted it and when it goes;
 *   3. the way back — and, for whoever is allowed, the way to end it early.
 *
 * The list shows what is still IN the bin by default. Restored and destroyed
 * entries stay in the register and can be shown, because "who deleted the
 * September invoice, and did anyone put it back?" is a question this page
 * should answer rather than a question it should erase.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, toast, toastError, tag, modal, textInput, selectInput, field,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { dateTime, date } from '../core/format.js';
import { can } from '../core/store.js';

const camel = (value) => String(value || '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** How many days are left before this entry may be destroyed. */
function daysLeft(purgeAfter) {
  const ms = new Date(purgeAfter).getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}

export default async function trashView(root) {
  const state = { status: 'in_bin', module: '', search: '' };
  const summaryHost = h('div', { class: 'kpis' }, spinner());
  const listHost = h('div', { class: 'card-body tight' }, spinner());

  const filters = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
    field(t('status'), selectInput({
      value: state.status,
      options: [
        { value: 'in_bin', label: t('trashInBin') },
        { value: 'restored', label: t('trashRestored') },
        { value: 'purged', label: t('trashPurged') },
        { value: 'all', label: t('all') },
      ],
      onchange: (e) => { state.status = e.target.value; load(); },
    })),
    field(t('search'), textInput({
      value: state.search,
      placeholder: t('search'),
      oninput: (e) => { state.search = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') load(); },
    })));

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('trash')),
        h('p', {}, t('trashHint'))),
      h('span', { class: 'spacer' }),
      can('trash.purge')
        ? h('button', { class: 'btn', onclick: () => sweep() }, t('trashSweep'))
        : null),
    summaryHost,
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-body tight' }, filters),
      listHost));

  async function sweep() {
    try {
      const result = await api.post('/api/trash/sweep', {});
      toast(t('trashSwept').replace('{n}', result.purged));
      if (result.kept?.length) {
        // Said out loud rather than swallowed: an entry that could not be
        // destroyed is still in the bin, and the reason matters.
        toast(t('trashSweepKept').replace('{n}', result.kept.length), 'warn', 6000);
      }
      await load();
    } catch (error) { toastError(error); }
  }

  async function load() {
    mount(listHost, spinner());
    try {
      const [summary, data] = await Promise.all([
        api.get('/api/trash/summary'),
        api.get('/api/trash', {
          status: state.status,
          module: state.module || undefined,
          search: state.search || undefined,
        }),
      ]);
      renderSummary(summary);
      renderList(data);
    } catch (error) {
      toastError(error);
      mount(listHost, h('div', { class: 'empty' }, error.message));
    }
  }

  function renderSummary(summary) {
    const kpi = (label, value, sub, tone) => h('div', { class: `kpi${tone ? ' accent' : ''}` },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value),
      sub ? h('div', { class: 'sub' }, sub) : null);
    mount(summaryHost,
      kpi(t('trashInBin'), String(summary.inBin),
        t('trashRetention').replace('{n}', summary.retentionDays)),
      // The one number worth a colour: these disappear this week.
      kpi(t('trashDueSoon'), String(summary.dueWithin7Days), t('trashDueSoonHint'),
        summary.dueWithin7Days > 0),
      ...summary.byModule.slice(0, 4).map((row) => kpi(
        t(camel(row.module), row.module), String(row.count), '',
      )));
  }

  function renderList(data) {
    mount(listHost, dataTable({
      columns: [
        {
          key: 'label',
          label: t('name'),
          render: (row) => h('div', {},
            h('div', { class: 'strong' }, row.label),
            row.detail ? h('div', { class: 'muted small' }, row.detail) : null),
        },
        {
          key: 'module',
          label: t('module'),
          render: (row) => tag(t(camel(row.module), row.module)),
        },
        { key: 'deletedAt', label: t('deletedAt'), render: (row) => dateTime(row.deletedAt) },
        { key: 'deletedByName', label: t('user'), render: (row) => row.deletedByName || '—' },
        { key: 'reason', label: t('reason'), render: (row) => h('span', { class: 'small muted' }, row.reason || '—') },
        {
          key: 'purgeAfter',
          label: t('trashGoesOn'),
          render: (row) => {
            if (row.status !== 'in_bin') return statusOf(row);
            const left = daysLeft(row.purgeAfter);
            return h('div', {},
              h('div', {}, date(row.purgeAfter)),
              h('div', { class: `small ${left <= 7 ? 'danger' : 'muted'}` },
                t('trashDaysLeft').replace('{n}', Math.max(left, 0))));
          },
        },
        {
          key: '__actions',
          label: '',
          width: '1%',
          render: (row) => (row.status !== 'in_bin' ? null : h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
            can('trash.restore')
              ? h('button', {
                class: 'btn sm', title: t('restore'), onclick: () => restore(row),
              }, `↩ ${t('restore')}`)
              : null,
            can('trash.purge')
              ? h('button', {
                class: 'btn sm ghost danger', title: t('purgeNow'), onclick: () => purge(row),
              }, '✕')
              : null)),
        },
      ],
      rows: data.rows,
      empty: t('trashEmpty'),
    }));
  }

  const statusOf = (row) => (row.status === 'restored'
    ? tag(t('trashRestored'), 'ok')
    : tag(t('trashPurged'), 'danger'));

  async function restore(row) {
    try {
      const result = await api.post(`/api/trash/${row.id}/restore`, {});
      // A document comes back in the state its deletion left it in, and the
      // toast says which — "restored" on its own would be a half-truth.
      toast(result.result?.state
        ? t('trashRestoredAs').replace('{state}', t(camel(result.result.state), result.result.state))
        : t('restored'));
      await load();
    } catch (error) { toastError(error); }
  }

  function purge(row) {
    const early = daysLeft(row.purgeAfter) > 0;
    const dialog = modal({
      title: t('purgeNow'),
      body: h('div', { class: 'stack' },
        h('p', {}, t('purgeConfirm').replace('{name}', row.label)),
        // The one irreversible button in this system, and it says so.
        h('p', { class: 'danger strong' }, t('purgeWarning')),
        early ? h('p', { class: 'muted small' }, t('purgeEarly').replace('{date}', date(row.purgeAfter))) : null),
      footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            try {
              await api.del(`/api/trash/${row.id}?force=1`);
              toast(t('purged'));
              dialog.close();
              await load();
            } catch (error) { toastError(error); }
          },
        }, t('purgeNow'))),
    });
  }

  await load();
}

/**
 * The confirm dialog every DELETE button in the ERP opens.
 *
 * Exported so that products, brands, suppliers and the rest all ask the same
 * question in the same words: what will happen, what cannot be undone, and how
 * long there is to change your mind. A delete that explains itself differently
 * on each screen is a delete nobody learns to trust.
 */
export async function confirmDelete({ entityType, entityId, onDone }) {
  let preview;
  try {
    preview = await api.get(`/api/trash/preview/${entityType}/${entityId}`);
  } catch (error) {
    toastError(error);
    return;
  }

  const blocked = !preview.ok;
  const reason = textInput({ placeholder: t('reasonOptional') });

  const dialog = modal({
    title: `${t('delete')} — ${preview.label}`,
    body: h('div', { class: 'stack' },
      preview.detail ? h('p', { class: 'muted' }, preview.detail) : null,

      // Blockers first and in red: these are the reasons it cannot happen.
      ...(preview.blockers || []).map((item) => h('div', { class: 'notice danger' },
        pick({ name_en: item.en, name_ar: item.ar }, 'name'))),

      // Then what it will cost, which the person may accept.
      ...(preview.warnings || []).map((item) => h('div', { class: 'notice warn' },
        pick({ name_en: item.en, name_ar: item.ar }, 'name'))),

      blocked ? null : h('p', { class: 'muted small' },
        t('trashGoesToBin').replace('{n}', preview.retentionDays)),
      blocked ? null : field(t('reason'), reason)),

    footer: h('div', { class: 'row', style: { gap: '8px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn ghost', onclick: () => dialog.close() }, t('cancel')),
      blocked ? null : h('button', {
        class: 'btn danger',
        onclick: async () => {
          try {
            await api.post('/api/trash', {
              entityType, entityId, reason: reason.value || null,
            });
            toast(t('movedToTrash'));
            dialog.close();
            if (onDone) await onDone();
          } catch (error) { toastError(error); }
        },
      }, t('delete'))),
  });
}
