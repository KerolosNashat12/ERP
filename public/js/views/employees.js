/**
 * الموظفين والمرتبات — the people the shop pays.
 *
 * A separate list from Users & Roles, and the screen says so: a delivery man
 * has a salary and no login, and no account is created here.
 *
 * What an owner actually needs to see is what this screen is arranged around:
 *
 *   · who is owed money — complete periods since the last one paid for, at the
 *     top, in one figure and per person;
 *   · what was paid this month — the range at the top of the list drives it;
 *   · what one person has been paid over time — open them and every payment is
 *     there, with the photograph of each slip.
 *
 * Every payment written here is a COST. It lands in the costs ledger beside the
 * rent, comes off the same profit, and is stored exactly once — the row opened
 * from the costs page and the row opened from here are the same row, so there
 * is nothing to keep in step and nothing to double-count.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, toast, toastError, textInput, field, modal,
  debounce, buildForm, tag,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, date, isoDate, startOfMonthIso } from '../core/format.js';
import { session, can, invalidate } from '../core/store.js';
import { proofThumbs, proofPicker } from '../core/proof.js';
import { confirmDelete } from './trash.js';

const METHODS = ['cash', 'card', 'transfer', 'wallet', 'cheque'];
const PERIODS = [
  { value: 'day', label: () => t('perDay') },
  { value: 'week', label: () => t('perWeek') },
  { value: 'month', label: () => t('perMonth') },
];

const periodLabel = (period) => (
  PERIODS.find((p) => p.value === period)?.label() || period
);

export async function employeesView(root, route) {
  const state = {
    dateFrom: route.query.dateFrom || startOfMonthIso(),
    dateTo: route.query.dateTo || isoDate(),
    search: '',
    data: null,
  };

  const kpiHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const branches = session.branches || [];

  async function load() {
    mount(listHost, spinner());
    try {
      const data = await api.get('/api/employees/payroll', {
        dateFrom: state.dateFrom, dateTo: state.dateTo,
      });
      state.data = data;
      renderKpis(data.summary);
      renderTable(data.rows);
    } catch (error) {
      toastError(error);
      mount(listHost, h('div', { class: 'empty' }, error.message));
    }
  }

  function renderKpis(summary) {
    mount(kpiHost,
      h('div', { class: 'kpi accent' },
        h('div', { class: 'label' }, t('owedNow')),
        h('div', { class: 'value' }, money(summary.owed)),
        h('div', { class: 'sub' }, summary.owed > 0 ? t('owedHint') : t('nobodyOwed'))),
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('paidInPeriod')),
        h('div', { class: 'value' }, money(summary.paid_in_range)),
        h('div', { class: 'sub' }, `${date(state.dateFrom)} → ${date(state.dateTo)}`)),
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('wageBill')),
        h('div', { class: 'value' }, money(summary.monthly_wage_bill)),
        h('div', { class: 'sub' }, `${number(summary.active)} / ${number(summary.employees)}`)));
  }

  function visible(rows) {
    const term = state.search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => [row.name, row.job_title, row.phone, row.code]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(term)));
  }

  function renderTable(rows) {
    mount(listHost, dataTable({
      columns: [
        {
          key: 'name',
          label: t('employeeName'),
          render: (row) => h('div', {},
            h('div', { class: 'strong' }, row.name),
            h('small', { class: 'muted' }, [row.code, row.job_title].filter(Boolean).join(' · '))),
        },
        { key: 'phone', label: t('employeePhone'), class: 'mono small' },
        {
          key: 'salary',
          label: t('salary'),
          type: 'money',
          render: (row) => h('div', {},
            h('div', {}, money(row.salary_amount)),
            h('small', { class: 'muted' }, `/ ${periodLabel(row.salary_period)}`)),
        },
        {
          key: 'paid_up_to',
          label: t('paidUpTo'),
          render: (row) => (row.paid_up_to ? date(row.paid_up_to) : '—'),
        },
        {
          key: 'owed_amount',
          label: t('owed'),
          type: 'money',
          render: (row) => (row.owed_amount > 0
            ? h('div', {},
              h('div', { class: 'strong' }, money(row.owed_amount)),
              h('small', { class: 'muted' }, `${number(row.owed_periods)} × ${periodLabel(row.salary_period)}`))
            : h('span', { class: 'muted' }, '—')),
        },
        {
          key: 'paid_in_range',
          label: t('paidInPeriod'),
          type: 'money',
          render: (row) => money(row.paid_in_range),
        },
        {
          key: 'is_active',
          label: t('status'),
          render: (row) => (row.is_active ? tag(t('active'), 'ok') : tag(t('inactive'), 'danger')),
        },
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (row) => h('div', { class: 'row-actions' },
            can('employees.pay') && row.is_active
              ? h('button', { class: 'btn sm primary', onclick: () => openPayment(row) }, t('paySalary'))
              : null,
            can('employees.update')
              ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => openEmployeeForm(row) }, '✎')
              : null,
            can('employees.delete')
              ? h('button', {
                class: 'btn sm ghost',
                title: t('delete'),
                onclick: () => confirmDelete({
                  entityType: 'employee', entityId: row.id, onDone: load,
                }),
              }, '🗑')
              : null),
        },
      ],
      rows: visible(rows),
      onRowClick: (row) => openHistory(row),
      rowClass: (row) => (row.is_active ? '' : 'payment-reversed'),
      emptyMessage: t('noEmployees'),
    }));
  }

  // ------------------------------------------------------ one person's history

  /** Everything this person has been paid, with the photograph of each slip. */
  async function openHistory(employee) {
    const body = h('div', { class: 'stack' }, spinner());
    const dialog = modal({
      title: `${employee.name} — ${employee.job_title || ''}`,
      size: 'wide',
      body,
    });
    try {
      const [detail, history] = await Promise.all([
        api.get(`/api/employees/${employee.id}`),
        api.get(`/api/employees/${employee.id}/payments`),
      ]);
      mount(body,
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' },
            h('div', { class: 'label' }, t('salary')),
            h('div', { class: 'value' }, money(detail.salary_amount)),
            h('div', { class: 'sub' }, `/ ${periodLabel(detail.salary_period)}`)),
          h('div', { class: 'kpi' },
            h('div', { class: 'label' }, t('paidTotal')),
            h('div', { class: 'value' }, money(history.paid_total)),
            h('div', { class: 'sub' }, `${number(history.rows.length)} ${t('salaryPayments')}`)),
          h('div', { class: 'kpi' },
            h('div', { class: 'label' }, t('paidUpTo')),
            h('div', { class: 'value' }, history.paid_up_to ? date(history.paid_up_to) : '—'),
            h('div', { class: 'sub' }, detail.hired_on ? `${t('hiredOn')}: ${date(detail.hired_on)}` : '')),
          h('div', { class: 'kpi accent' },
            h('div', { class: 'label' }, t('owed')),
            h('div', { class: 'value' }, money(detail.owed_amount)),
            h('div', { class: 'sub' }, detail.owed_periods
              ? `${date(detail.owed_from)} → ${date(detail.owed_to)}`
              : t('nobodyOwed')))),
        h('p', { class: 'muted small' }, t('salaryIsACost')),
        dataTable({
          columns: [
            { key: 'spent_on', label: t('paidOn'), render: (row) => date(row.spent_on) },
            {
              key: 'period',
              label: t('periodCovered'),
              render: (row) => `${date(row.period_start)} → ${date(row.period_end)}`,
            },
            { key: 'amount', label: t('costAmount'), type: 'money', render: (row) => money(row.amount) },
            { key: 'payment_method', label: t('paymentMethod'), render: (row) => t(row.payment_method, row.payment_method) },
            { key: 'reference', label: t('costReference'), class: 'mono small' },
            { key: 'description', label: t('paymentNote') },
            { key: 'created_by_name', label: t('recordedBy') },
            {
              key: 'proof',
              label: t('salaryPaymentPhoto'),
              render: (row) => proofThumbs(row.attachments, `${employee.name} — ${money(row.amount)}`),
            },
            {
              key: '__open',
              label: '',
              class: 'nowrap',
              // The same row, opened where it is edited. There is no second
              // copy of this payment anywhere, so there is nowhere else it
              // could be corrected.
              render: () => h('button', {
                class: 'btn sm ghost',
                title: t('editSalaryInCosts'),
                onclick: () => { dialog.close(); window.location.hash = '#/costs'; },
              }, t('openInCosts')),
            },
          ],
          rows: history.rows,
          emptyMessage: t('noSalaryPayments'),
        }));
    } catch (error) {
      toastError(error);
      mount(body, h('div', { class: 'empty' }, error.message));
    }
  }

  // ---------------------------------------------------------- record a payment

  function openPayment(employee) {
    const suggested = employee.owed_from
      ? { start: employee.owed_from, end: employee.owed_to }
      : null;

    const form = buildForm([
      { name: 'amount', label: t('costAmount'), type: 'number', required: true, value: employee.salary_amount },
      { name: 'paid_on', label: t('paidOn'), type: 'date', required: true },
      { name: 'period_start', label: t('periodFrom'), type: 'date' },
      { name: 'period_end', label: t('periodTo'), type: 'date' },
      {
        name: 'payment_method',
        label: t('paymentMethod'),
        type: 'select',
        options: METHODS.map((m) => ({ value: m, label: t(m) })),
      },
      { name: 'reference', label: t('costReference') },
      { name: 'note', label: t('paymentNote'), span: 2 },
    ], {
      paid_on: isoDate(),
      payment_method: 'cash',
      period_start: suggested?.start || '',
      period_end: suggested?.end || '',
    }, { columns: 2 });

    const proof = proofPicker({ hint: t('billPhotoHint'), alt: t('salaryPaymentPhoto') });

    const dialog = modal({
      title: `${t('paySalary')} — ${employee.name}`,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, t('salaryIsACost')),
        employee.owed_amount > 0
          ? h('div', { class: 'muted small' },
            `${t('owed')}: ${money(employee.owed_amount)} · ${number(employee.owed_periods)} × ${periodLabel(employee.salary_period)}`)
          : null,
        form.node,
        field({ label: t('salaryPaymentPhoto'), input: proof.node })),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            if (proof.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
            const values = form.values();
            try {
              await api.post(`/api/employees/${employee.id}/payments`, {
                // Typed and sent; rounded by the server.
                amount: Number(values.amount),
                paid_on: values.paid_on,
                period_start: values.period_start || null,
                period_end: values.period_end || null,
                payment_method: values.payment_method || 'cash',
                reference: values.reference || null,
                note: values.note || null,
                photo: proof.value(),
              });
              toast(t('salaryPaid'));
              dialog.close();
              load();
            } catch (error) {
              if (error.details?.length) form.setErrors(error.details);
              toastError(error);
            }
          },
        }, t('save')),
      ],
    });
  }

  // -------------------------------------------------------------- the person

  function openEmployeeForm(record = null) {
    const form = buildForm([
      { name: 'name', label: t('employeeName'), required: true },
      { name: 'job_title', label: t('jobTitle') },
      { name: 'phone', label: t('employeePhone') },
      { name: 'salary_amount', label: t('salaryAmount'), type: 'number', required: true },
      {
        name: 'salary_period',
        label: t('salaryPeriod'),
        type: 'select',
        required: true,
        options: PERIODS.map((p) => ({ value: p.value, label: p.label() })),
      },
      { name: 'hired_on', label: t('hiredOn'), type: 'date' },
      {
        name: 'warehouse_id',
        label: t('branch'),
        type: 'select',
        options: branches.map((b) => ({ value: b.id, label: pick(b, 'name') })),
      },
      { name: 'code', label: t('code'), hint: t('autoIfBlank') },
      { name: 'notes', label: t('employeeNotes'), type: 'textarea', span: 2 },
      { name: 'is_active', label: t('active'), type: 'checkbox', value: 1 },
    ], record || { salary_period: 'month', is_active: 1, hired_on: isoDate() }, { columns: 2 });

    const dialog = modal({
      title: record ? `${t('editEmployee')} — ${record.name}` : t('newEmployee'),
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, t('payrollNoLoginHint')),
        form.node),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            const values = form.values();
            const payload = {
              ...values,
              salary_amount: Number(values.salary_amount),
              warehouse_id: values.warehouse_id ? Number(values.warehouse_id) : null,
            };
            try {
              if (record) await api.put(`/api/employees/${record.id}`, payload);
              else await api.post('/api/employees', payload);
              toast(t('employeeSaved'));
              dialog.close();
              invalidate('employees');
              load();
            } catch (error) {
              if (error.details?.length) form.setErrors(error.details);
              toastError(error);
            }
          },
        }, t('save')),
      ],
    });
  }

  const filterBar = () => h('div', { class: 'filters' },
    h('div', { class: 'field grow' }, textInput({
      placeholder: t('search'),
      oninput: debounce((event) => {
        state.search = event.target.value;
        if (state.data) renderTable(state.data.rows);
      }, 220),
    })),
    h('div', { class: 'field' }, field({
      label: t('from'),
      input: h('input', {
        class: 'input', type: 'date', value: state.dateFrom,
        onchange: (event) => { state.dateFrom = event.target.value; load(); },
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('to'),
      input: h('input', {
        class: 'input', type: 'date', value: state.dateTo,
        onchange: (event) => { state.dateTo = event.target.value; load(); },
      }),
    })));

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, t('employees')), h('p', {}, t('employeesSubtitle'))),
      h('span', { class: 'spacer' }),
      can('employees.create')
        ? h('button', { class: 'btn primary', onclick: () => openEmployeeForm(null) }, `＋ ${t('newEmployee')}`)
        : null),
    h('p', { class: 'muted small' }, t('employeeNotAUser')),
    kpiHost,
    h('div', { class: 'card' }, filterBar(), listHost));

  await load();
  if (route.segments[1] === 'new' && can('employees.create')) openEmployeeForm(null);
}
