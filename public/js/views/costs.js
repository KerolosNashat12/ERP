/**
 * صفحة التكاليف — what the shop spends.
 *
 * One screen with three things on it, in the order they matter to the person
 * opening it in the morning:
 *
 *   1. What is WAITING. Repeating costs never post themselves, so the months
 *      they owe are at the top, each with its date and amount, to confirm one
 *      at a time or all at once. Come back after six weeks away and the missed
 *      months are all here — nothing was invented while nobody was looking, and
 *      nothing was skipped either.
 *   2. What was spent, filtered by date, branch and category, with the
 *      photograph of each bill.
 *   3. What repeats, and how to stop one.
 *
 * Every string comes through `t()`; there is not a literal in this file, so the
 * screen mirrors into Arabic with the rest of the ERP.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  field, modal, debounce, buildForm, confirmDialog, tag,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money, number, date, isoDate, startOfMonthIso } from '../core/format.js';
import { session, can, lookup, invalidate } from '../core/store.js';
import { proofThumbs, proofPicker } from '../core/proof.js';
import { resourceView } from './resource.js';
import { confirmDelete } from './trash.js';
/*
 * The repeat vocabulary comes from the same module the server's engine and its
 * validator read. A picker with its own hard-coded list is how a browser ends
 * up offering a frequency the engine has never heard of.
 */
import { FREQUENCIES, DEFAULT_FREQUENCY, normalizeFrequency } from '../../shared/recurrence.js';

/** The word for each frequency. The list is theirs; only the words are ours. */
const FREQUENCY_WORD = {
  daily: 'freqDaily', weekly: 'freqWeekly', monthly: 'freqMonthly', yearly: 'freqYearly',
};

/**
 * What a template's schedule says, in one line, in the reader's language.
 *
 * The column used to be «كل شهر يوم» with a bare number under it, which stops
 * being true the moment a template is weekly. Each frequency says the thing
 * that actually identifies it and nothing else.
 */
function repeatSummary(row) {
  const frequency = normalizeFrequency(row.frequency);
  if (frequency === 'daily') return t('everyDayLabel');
  if (frequency === 'weekly') {
    const day = Number.isInteger(Number(row.day_of_week))
      ? Number(row.day_of_week)
      : new Date(`${row.starts_on}T00:00:00Z`).getUTCDay();
    return `${t('everyWeekOn')} ${t(`wd${day}`)}`;
  }
  if (frequency === 'yearly') {
    const month = Number(row.month_of_year) || Number(String(row.starts_on).slice(5, 7)) || 1;
    return `${t('everyYearOn')} ${number(row.day_of_month)} ${t(`mo${month}`)}`;
  }
  return `${t('everyMonthOn')} ${number(row.day_of_month)}`;
}

const METHODS = ['cash', 'card', 'transfer', 'wallet', 'cheque'];

/** A cost's own words, for a photo caption and an audit-ish label. */
const costCaption = (row) => [pick(row, 'category_name'), money(row.amount), date(row.spent_on)]
  .filter(Boolean).join(' — ');

export async function costsView(root, route) {
  const state = {
    filters: {
      dateFrom: route.query.dateFrom || startOfMonthIso(),
      dateTo: route.query.dateTo || isoDate(),
      categoryId: route.query.categoryId || '',
      warehouseId: route.query.warehouseId || '',
      search: '',
    },
    page: 1,
    tab: route.segments[1] === 'repeating' ? 'repeating' : 'ledger',
  };

  const categories = await lookup('costCategories', '/api/cost-categories/options');
  // The branches this shop has. They arrived with the session — a location list
  // is not worth a second round trip, and every screen that files something
  // against a branch reads the same list.
  const branches = session.branches || [];

  const waitingHost = h('div');
  const kpiHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');
  const repeatingHost = h('div', { class: 'card-body tight' }, spinner());

  const query = () => ({
    ...state.filters,
    page: state.page,
    pageSize: 25,
  });

  async function loadLedger() {
    mount(listHost, spinner());
    try {
      const [data, summary] = await Promise.all([
        api.get('/api/costs', query()),
        api.get('/api/costs/summary', state.filters),
      ]);
      renderKpis(summary);
      renderTable(data);
    } catch (error) {
      toastError(error);
      mount(listHost, h('div', { class: 'empty' }, error.message));
    }
  }

  function renderKpis(summary) {
    const biggest = summary.byCategory[0];
    mount(kpiHost,
      h('div', { class: 'kpi accent' },
        h('div', { class: 'label' }, t('totalCosts')),
        h('div', { class: 'value' }, money(summary.total)),
        h('div', { class: 'sub' }, `${number(summary.entries)} ${t('costEntries')}`)),
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('biggestCategory')),
        h('div', { class: 'value' }, biggest ? pick(biggest, 'category_name') : '—'),
        h('div', { class: 'sub' }, biggest ? money(biggest.amount) : '—')),
      ...summary.byBranch.slice(0, 2).map((branch) => h('div', { class: 'kpi' },
        h('div', { class: 'label' }, `${t('branch')} · ${pick(branch, 'branch_name')}`),
        h('div', { class: 'value' }, money(branch.amount)),
        h('div', { class: 'sub' }, `${number(branch.entries)} ${t('costEntries')}`))));
  }

  function renderTable(data) {
    mount(listHost, dataTable({
      columns: [
        { key: 'spent_on', label: t('costDate'), render: (row) => date(row.spent_on) },
        {
          key: 'category',
          label: t('costCategory'),
          render: (row) => h('div', {},
            h('div', {}, pick(row, 'category_name')),
            row.source === 'salary'
              ? h('small', { class: 'muted' }, `${t('sourceSalary')} · ${row.employee_name || ''}`)
              : (row.source === 'recurring' ? h('small', { class: 'muted' }, t('sourceRecurring')) : null)),
        },
        { key: 'branch', label: t('branch'), render: (row) => pick(row, 'branch_name') },
        {
          key: 'description',
          label: t('costDescription'),
          render: (row) => h('div', {},
            h('div', {}, row.description || '—'),
            row.period_start
              ? h('small', { class: 'muted' }, `${t('periodCovered')}: ${date(row.period_start)} → ${date(row.period_end)}`)
              : null),
        },
        { key: 'reference', label: t('costReference'), class: 'mono small' },
        { key: 'payment_method', label: t('paymentMethod'), render: (row) => t(row.payment_method, row.payment_method) },
        {
          key: 'amount', label: t('costAmount'), type: 'money', class: 'amount',
          render: (row) => money(row.amount),
        },
        {
          key: 'proof',
          label: t('photoOfBill'),
          render: (row) => proofThumbs(row.attachments, costCaption(row)),
        },
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (row) => h('div', { class: 'row-actions' },
            can('costs.update')
              ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => openCostForm(row) }, '✎')
              : null,
            can('costs.delete')
              ? h('button', {
                class: 'btn sm ghost',
                title: t('delete'),
                // Through the bin: a cost is money already counted against a
                // month's profit, and the dialog says so before it moves.
                onclick: () => confirmDelete({
                  entityType: 'cost', entityId: row.id, onDone: reload,
                }),
              }, '🗑')
              : null),
        },
      ],
      rows: data.rows,
      emptyMessage: t('noCosts'),
    }));
    mount(pagerHost, pager({
      page: data.page, pages: data.pages, total: data.total,
      onPage: (p) => { state.page = p; loadLedger(); },
    }));
  }

  // ------------------------------------------------- the months that are waiting

  /**
   * Nothing here has been posted. That is the design, not a delay: a repeating
   * cost that silently invents entries nobody checked is worse than typing it.
   * The amount shown is the template's, and confirming one opens it so the
   * electricity bill can be corrected before it becomes a cost.
   */
  async function loadWaiting() {
    if (!can('costs.view')) return;
    try {
      const due = await api.get('/api/costs/recurring/due');
      if (!due.rows.length) { mount(waitingHost); return; }
      mount(waitingHost, h('div', { class: 'card', style: { marginBottom: '14px' } },
        h('div', { class: 'card-head' },
          h('h3', {}, `${t('costsWaiting')} (${due.rows.length})`),
          h('span', { class: 'spacer' }),
          can('costs.create')
            ? h('button', {
              class: 'btn sm primary',
              onclick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const result = await api.post('/api/costs/recurring/generate', {});
                  toast(t('costsPosted').replace('{count}', result.posted));
                  reload();
                } catch (error) { toastError(error); } finally { button.disabled = false; }
              },
            }, t('confirmAllCosts'))
            : null),
        h('div', { class: 'card-body tight' },
          h('p', { class: 'muted small', style: { margin: '0 12px 8px' } }, t('costsWaitingHint')),
          dataTable({
            columns: [
              { key: 'due_on', label: t('dueOn'), render: (row) => date(row.due_on) },
              { key: 'period_key', label: t('forMonth'), class: 'mono' },
              { key: 'category', label: t('costCategory'), render: (row) => pick(row, 'category_name') },
              { key: 'branch', label: t('branch'), render: (row) => pick(row, 'branch_name') },
              { key: 'description', label: t('costDescription') },
              {
                key: 'amount', label: t('costAmount'), type: 'money', class: 'amount',
                render: (row) => money(row.amount),
              },
              {
                key: '__confirm',
                label: '',
                class: 'nowrap',
                render: (row) => (can('costs.create')
                  ? h('button', { class: 'btn sm', onclick: () => openConfirm(row) }, t('confirmCost'))
                  : ''),
              },
            ],
            rows: due.rows,
            emptyMessage: t('nothingWaiting'),
          }))));
    } catch {
      // A waiting list is a courtesy; a failed fetch must not take the ledger
      // down with it.
      mount(waitingHost);
    }
  }

  function openConfirm(occurrence) {
    const form = buildForm([
      {
        name: 'amount',
        label: t('costAmount'),
        type: 'number',
        required: true,
        value: occurrence.amount,
        hint: t('amountFromTemplate'),
      },
      { name: 'spent_on', label: t('costDate'), type: 'date', required: true, value: occurrence.due_on },
    ], {}, { columns: 2 });

    const dialog = modal({
      title: `${t('confirmCostTitle')} — ${occurrence.period_key}`,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' },
          `${pick(occurrence, 'category_name')} · ${occurrence.description || ''}`),
        form.node),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            const values = form.values();
            try {
              await api.post(`/api/costs/recurring/${occurrence.recurring_id}/post`, {
                period_key: occurrence.period_key,
                // Sent as typed; the server rounds it. Nothing the browser
                // calculated is trusted as a total.
                amount: Number(values.amount),
                spent_on: values.spent_on,
              });
              toast(t('costSaved'));
              dialog.close();
              reload();
            } catch (error) { toastError(error); }
          },
        }, t('confirmCost')),
      ],
    });
  }

  // ------------------------------------------------------------ one cost

  function openCostForm(record = null) {
    const form = buildForm([
      {
        name: 'category_id',
        label: t('costCategory'),
        type: 'select',
        required: true,
        options: categories.map((c) => ({ value: c.id, label: pick(c, 'name') })),
      },
      { name: 'amount', label: t('costAmount'), type: 'number', required: true },
      { name: 'spent_on', label: t('costDate'), type: 'date', required: true },
      {
        name: 'warehouse_id',
        label: t('branch'),
        type: 'select',
        options: branches.map((b) => ({ value: b.id, label: pick(b, 'name') })),
      },
      { name: 'description', label: t('costDescription'), span: 2 },
      { name: 'reference', label: t('costReference') },
      {
        name: 'payment_method',
        label: t('paymentMethod'),
        type: 'select',
        options: METHODS.map((m) => ({ value: m, label: t(m) })),
      },
    ], record
      ? { ...record, spent_on: record.spent_on }
      : { spent_on: isoDate(), payment_method: 'cash' }, { columns: 2 });

    const proof = proofPicker({ hint: t('billPhotoHint'), alt: t('photoOfBill') });

    const dialog = modal({
      title: record ? `${t('editCost')} — ${costCaption(record)}` : t('newCost'),
      size: 'narrow',
      body: h('div', { class: 'stack' },
        record?.employee_name
          ? h('div', { class: 'muted small' }, `${t('sourceSalary')}: ${record.employee_name} · ${t('salaryIsACost')}`)
          : null,
        form.node,
        record?.attachments?.length
          ? field({ label: t('photoOfBill'), input: proofThumbs(record.attachments, costCaption(record)) })
          : null,
        field({ label: record ? t('addPhoto') : t('photoOfBill'), input: proof.node })),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            // A photograph still being compressed is a photograph a save that
            // went now would leave behind.
            if (proof.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
            const values = form.values();
            const payload = {
              category_id: Number(values.category_id),
              amount: Number(values.amount),
              spent_on: values.spent_on,
              warehouse_id: values.warehouse_id ? Number(values.warehouse_id) : null,
              description: values.description || null,
              reference: values.reference || null,
              payment_method: values.payment_method || 'cash',
              photo: proof.value(),
            };
            try {
              if (record) await api.put(`/api/costs/${record.id}`, payload);
              else await api.post('/api/costs', payload);
              toast(t('costSaved'));
              dialog.close();
              reload();
            } catch (error) {
              if (error.details?.length) form.setErrors(error.details);
              toastError(error);
            }
          },
        }, t('save')),
      ],
    });
  }

  // ------------------------------------------------------- what repeats

  async function loadRepeating() {
    mount(repeatingHost, spinner());
    try {
      const data = await api.get('/api/costs/recurring');
      mount(repeatingHost, dataTable({
        columns: [
          {
            key: 'description',
            label: t('costDescription'),
            render: (row) => h('div', {},
              h('div', {}, row.description || pick(row, 'category_name')),
              h('small', { class: 'muted' }, `${pick(row, 'category_name')} · ${pick(row, 'branch_name')}`)),
          },
          {
            key: 'frequency',
            label: t('repeatsColumn'),
            render: (row) => repeatSummary(row),
          },
          { key: 'amount', label: t('costAmount'), type: 'money', render: (row) => money(row.amount) },
          {
            key: 'window',
            label: t('startsOn'),
            render: (row) => h('div', {},
              h('div', {}, date(row.starts_on)),
              row.ends_on ? h('small', { class: 'muted' }, `→ ${date(row.ends_on)}`) : null),
          },
          {
            key: 'posted_count',
            label: t('postedCount'),
            render: (row) => h('div', {},
              h('div', {}, number(row.posted_count)),
              row.last_period ? h('small', { class: 'muted' }, `${t('lastPosted')}: ${row.last_period}`) : null),
          },
          {
            key: 'status',
            label: t('status'),
            render: (row) => (row.is_active
              ? h('div', {},
                tag(t('repeatingActive'), 'ok'),
                row.due_count
                  ? h('small', { class: 'muted' }, ` ${row.due_count} · ${t('costsWaiting')}`)
                  : null)
              : tag(t('repeatingStopped'), 'danger')),
          },
          {
            key: '__actions',
            label: t('actions'),
            class: 'nowrap',
            render: (row) => h('div', { class: 'row-actions' },
              can('costs.update')
                ? h('button', {
                  class: 'btn sm ghost',
                  title: row.is_active ? t('stopRepeating') : t('resumeRepeating'),
                  onclick: async () => {
                    try {
                      await api.post(`/api/costs/recurring/${row.id}/${row.is_active ? 'stop' : 'resume'}`, {});
                      toast(row.is_active ? t('stoppedRepeating') : t('resumedRepeating'));
                      reload();
                    } catch (error) { toastError(error); }
                  },
                }, row.is_active ? '⏸' : '▶')
                : null,
              can('costs.update')
                ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => openRepeatingForm(row) }, '✎')
                : null,
              can('costs.delete')
                ? h('button', {
                  class: 'btn sm ghost',
                  title: t('delete'),
                  onclick: async () => {
                    const ok = await confirmDialog({
                      title: t('delete'), message: t('deleteRepeatingConfirm'), danger: true, confirmLabel: t('delete'),
                    });
                    if (!ok) return;
                    try {
                      await api.del(`/api/costs/recurring/${row.id}`);
                      toast(t('deleted'));
                      reload();
                    } catch (error) { toastError(error); }
                  },
                }, '🗑')
                : null),
          },
        ],
        rows: data.rows,
        rowClass: (row) => (row.is_active ? '' : 'payment-reversed'),
        emptyMessage: t('noRepeatingCosts'),
      }));
    } catch (error) {
      toastError(error);
      mount(repeatingHost, h('div', { class: 'empty' }, error.message));
    }
  }

  function openRepeatingForm(record = null) {
    const form = buildForm([
      {
        name: 'category_id',
        label: t('costCategory'),
        type: 'select',
        required: true,
        // Wages repeat per person and are recorded when they are handed over,
        // so the salary category is deliberately not offered here.
        options: categories.filter((c) => c.kind !== 'salary')
          .map((c) => ({ value: c.id, label: pick(c, 'name') })),
      },
      { name: 'amount', label: t('costAmount'), type: 'number', required: true },
      {
        name: 'frequency',
        label: t('repeatEvery'),
        type: 'select',
        required: true,
        options: FREQUENCIES.map((value) => ({ value, label: t(FREQUENCY_WORD[value]) })),
      },
      /*
       * The three fields below pin the repeat to a calendar, and WHICH of them
       * applies is the frequency's business: a weekly cost has a weekday and
       * no day of the month, a yearly one has both a month and a day, a daily
       * one has neither. They are all built and then shown or hidden by
       * `applyFrequency()` rather than the form being rebuilt, so a half-typed
       * amount survives changing your mind about how often it repeats.
       */
      {
        name: 'day_of_week',
        label: t('dayOfWeek'),
        type: 'select',
        required: true,
        hint: t('dayOfWeekHint'),
        // Saturday first: that is where the week starts here, and a list that
        // starts on Sunday is a list an Egyptian shopkeeper reads twice.
        options: [6, 0, 1, 2, 3, 4, 5].map((value) => ({ value, label: t(`wd${value}`) })),
      },
      {
        name: 'month_of_year',
        label: t('monthOfYear'),
        type: 'select',
        required: true,
        options: Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: t(`mo${i + 1}`) })),
      },
      {
        name: 'day_of_month',
        label: t('dayOfMonth'),
        type: 'number',
        required: true,
        min: 1,
        max: 31,
        hint: t('dayOfMonthHint'),
      },
      { name: 'starts_on', label: t('startsOn'), type: 'date', required: true },
      { name: 'ends_on', label: t('endsOn'), type: 'date', hint: t('endsOnHint') },
      {
        name: 'warehouse_id',
        label: t('branch'),
        type: 'select',
        options: branches.map((b) => ({ value: b.id, label: pick(b, 'name') })),
      },
      { name: 'description', label: t('costDescription'), span: 2 },
      {
        name: 'payment_method',
        label: t('paymentMethod'),
        type: 'select',
        options: METHODS.map((m) => ({ value: m, label: t(m) })),
      },
    ], record || {
      starts_on: isoDate(),
      // Monthly, because rent and the bills are what most of these are, and
      // because it is what every template made before today already is.
      frequency: DEFAULT_FREQUENCY,
      day_of_month: 1,
      day_of_week: new Date().getDay(),
      month_of_year: new Date().getMonth() + 1,
      payment_method: 'cash',
    }, { columns: 2 });

    /*
     * Show only the fields this frequency actually uses.
     *
     * `holder.hidden` rather than removing the field: the value stays in the
     * form, so switching weekly → monthly → weekly gives back the weekday that
     * was chosen rather than silently resetting it, and `buildForm.validate()`
     * skips hidden fields so nothing can demand an answer to a question that
     * is not on screen.
     *
     * The server does not trust any of this. `CostService.saveRecurring`
     * stores NULL for the fields the chosen frequency does not use, so a
     * weekday left over from a change of mind is never written and can never
     * be read back by mistake.
     */
    const show = (name, on) => {
      const entry = form.inputs.get(name);
      if (entry) entry.holder.hidden = !on;
    };
    const dayOfMonthHint = form.inputs.get('day_of_month')?.holder.querySelector('.hint');
    function applyFrequency() {
      const frequency = form.inputs.get('frequency').input.value || DEFAULT_FREQUENCY;
      show('day_of_week', frequency === 'weekly');
      show('month_of_year', frequency === 'yearly');
      show('day_of_month', frequency === 'monthly' || frequency === 'yearly');
      // On a yearly repeat the number means "the day of THAT month", which is
      // a different sentence from the monthly one.
      if (dayOfMonthHint) {
        dayOfMonthHint.textContent = frequency === 'yearly' ? t('dayOfMonthYearHint') : t('dayOfMonthHint');
      }
    }
    form.inputs.get('frequency').input.addEventListener('change', applyFrequency);
    applyFrequency();

    const dialog = modal({
      title: record ? t('editRepeatingCost') : t('newRepeatingCost'),
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, t('costsWaitingHint')),
        form.node),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            const values = form.values();
            const payload = {
              category_id: Number(values.category_id),
              amount: Number(values.amount),
              frequency: values.frequency || DEFAULT_FREQUENCY,
              day_of_month: Number(values.day_of_month) || 1,
              // Sent as typed; the server decides which of the two it keeps
              // and nulls the other, so the row can never carry a weekday it
              // does not use.
              day_of_week: values.day_of_week === null ? null : Number(values.day_of_week),
              month_of_year: values.month_of_year === null ? null : Number(values.month_of_year),
              starts_on: values.starts_on,
              ends_on: values.ends_on || null,
              warehouse_id: values.warehouse_id ? Number(values.warehouse_id) : null,
              description: values.description || null,
              payment_method: values.payment_method || 'cash',
            };
            try {
              if (record) await api.put(`/api/costs/recurring/${record.id}`, payload);
              else await api.post('/api/costs/recurring', payload);
              toast(t('saved'));
              dialog.close();
              reload();
            } catch (error) {
              if (error.details?.length) form.setErrors(error.details);
              toastError(error);
            }
          },
        }, t('save')),
      ],
    });
  }

  // --------------------------------------------------------------- shell

  function reload() {
    invalidate('costCategories');
    loadWaiting();
    if (state.tab === 'ledger') loadLedger(); else loadRepeating();
  }

  const setFilter = (key, value) => { state.filters[key] = value; state.page = 1; loadLedger(); };

  const filterBar = () => h('div', { class: 'filters' },
    h('div', { class: 'field grow' }, textInput({
      placeholder: t('search'),
      oninput: debounce((event) => setFilter('search', event.target.value), 280),
    })),
    h('div', { class: 'field' }, field({
      label: t('from'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateFrom,
        onchange: (event) => setFilter('dateFrom', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('to'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateTo,
        onchange: (event) => setFilter('dateTo', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('costCategory'),
      input: selectInput({
        placeholder: t('all'),
        value: state.filters.categoryId,
        options: categories.map((c) => ({ value: c.id, label: pick(c, 'name') })),
        onchange: (event) => setFilter('categoryId', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('branch'),
      input: selectInput({
        placeholder: t('allBranches'),
        value: state.filters.warehouseId,
        options: branches.map((b) => ({ value: b.id, label: pick(b, 'name') })),
        onchange: (event) => setFilter('warehouseId', event.target.value),
      }),
    })));

  const tabButton = (key, label) => h('button', {
    class: `btn ${state.tab === key ? 'primary' : 'ghost'}`,
    onclick: () => { state.tab = key; render(); reload(); },
  }, label);

  function render() {
    mount(root,
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', {}, t('costs')), h('p', {}, t('costsSubtitle'))),
        h('span', { class: 'spacer' }),
        can('costs.view')
          ? h('button', {
            class: 'btn',
            onclick: () => { window.location.hash = '#/reports/profit_and_costs'; },
          }, t('profitAfterCosts'))
          : null,
        can('costs.update')
          ? h('button', { class: 'btn', onclick: () => { window.location.hash = '#/cost-categories'; } }, t('manageCategories'))
          : null,
        can('costs.create') && state.tab === 'repeating'
          ? h('button', { class: 'btn primary', onclick: () => openRepeatingForm(null) }, `＋ ${t('newRepeatingCost')}`)
          : null,
        can('costs.create') && state.tab === 'ledger'
          ? h('button', { class: 'btn primary', onclick: () => openCostForm(null) }, `＋ ${t('newCost')}`)
          : null),
      waitingHost,
      h('div', { class: 'row', style: { gap: '6px', marginBottom: '12px' } },
        tabButton('ledger', t('costs')),
        tabButton('repeating', t('repeatingCosts'))),
      state.tab === 'ledger'
        ? h('div', {}, kpiHost, h('div', { class: 'card' }, filterBar(), listHost, pagerHost))
        : h('div', { class: 'card' },
          h('div', { class: 'card-head' },
            h('h3', {}, t('repeatingCosts')),
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted small' }, t('repeatingCostsSubtitle'))),
          repeatingHost));
  }

  render();
  reload();
}

/**
 * The categories themselves — ordinary master data, so this is the same generic
 * screen suppliers and brands use. Seeded bilingual and extendable: the owner's
 * shop spends money on something the seed did not think of, and he adds it.
 */
export const costCategoriesView = resourceView({
  endpoint: '/api/cost-categories',
  module: 'costs',
  title: t('costCategories'),
  subtitle: t('costsSubtitle'),
  createLabel: t('newCategory'),
  emptyMessage: t('noResults'),
  columns: () => [
    { key: 'code', label: t('code'), class: 'mono small' },
    { key: 'name', label: t('name'), render: (row) => pick(row, 'name') },
    {
      key: 'name_other',
      label: getLanguage() === 'ar' ? t('english') : t('arabic'),
      render: (row) => (getLanguage() === 'ar' ? row.name_en : row.name_ar) || '—',
    },
    {
      key: 'kind',
      label: t('status'),
      render: (row) => (row.kind === 'salary'
        ? tag(t('salaries'), 'info')
        : (row.is_active ? tag(t('active'), 'ok') : tag(t('inactive'), 'danger'))),
    },
  ],
  label: (row) => pick(row, 'name'),
  fields: () => [
    { name: 'name_en', label: t('nameEn'), required: true },
    { name: 'name_ar', label: t('nameAr') },
    { name: 'code', label: t('code'), hint: t('autoIfBlank') },
    { name: 'display_order', label: t('displayOrder'), type: 'number' },
    { name: 'is_active', label: t('active'), type: 'checkbox' },
  ],
  defaults: { is_active: 1, display_order: 100 },
});
