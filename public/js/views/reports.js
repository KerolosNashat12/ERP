/** Report centre — one screen driving every report definition on the server. */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, selectInput, field, toastError, printNode,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { byType, isoDate, daysAgoIso, startOfMonthIso } from '../core/format.js';
import { session, can, lookup } from '../core/store.js';
import { navigate } from '../core/router.js';

const PRESETS = [
  { key: 'today', label: () => t('today'), range: () => [isoDate(), isoDate()] },
  { key: 'week', label: () => t('thisWeek'), range: () => [daysAgoIso(6), isoDate()] },
  { key: 'month', label: () => t('thisMonth'), range: () => [startOfMonthIso(), isoDate()] },
  { key: 'days90', label: () => '90d', range: () => [daysAgoIso(89), isoDate()] },
];

export async function reportsView(root, route) {
  const catalogue = (await api.get('/api/reports')).rows;
  const [brands, categories] = await Promise.all([
    lookup('brands', '/api/brands/options'),
    lookup('categories', '/api/categories/options'),
  ]);

  const state = {
    key: route.segments[1] || catalogue[0]?.key,
    filters: { dateFrom: startOfMonthIso(), dateTo: isoDate() },
    report: null,
  };

  const resultHost = h('div', { class: 'card-body tight' }, spinner());
  const summaryHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });
  const titleHost = h('h2', {});

  async function run() {
    mount(resultHost, spinner());
    try {
      const report = await api.get(`/api/reports/${state.key}`, state.filters);
      state.report = report;
      mount(titleHost, getLanguage() === 'ar' ? report.titleAr : report.titleEn);

      mount(summaryHost, ...Object.entries(report.summary || {}).map(([key, value]) => h('div', { class: 'kpi' },
        h('div', { class: 'label' }, key.replace(/_/g, ' ')),
        h('div', { class: 'value' }, formatSummary(key, value)))));

      mount(resultHost, dataTable({
        columns: report.columns.map((column) => ({
          key: column.key,
          label: getLanguage() === 'ar' ? column.labelAr : column.labelEn,
          type: column.type,
          render: (row) => byType(row[column.key], column.type),
        })),
        rows: report.rows,
        emptyMessage: t('noReportData'),
      }));
    } catch (error) {
      toastError(error);
      mount(resultHost, h('div', { class: 'empty' }, error.message));
    }
  }

  const setFilter = (key, value) => { state.filters[key] = value; run(); };

  const filterBar = () => h('div', { class: 'filters' },
    h('div', { class: 'field' }, field({
      label: t('from'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateFrom,
        onchange: (e) => setFilter('dateFrom', e.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('to'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateTo,
        onchange: (e) => setFilter('dateTo', e.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('brand'),
      input: selectInput({
        placeholder: t('all'),
        options: brands.map((b) => ({ value: b.id, label: pick(b, 'name') })),
        onchange: (e) => setFilter('brandId', e.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('category'),
      input: selectInput({
        placeholder: t('all'),
        options: categories.map((c) => ({ value: c.id, label: pick(c, 'name') })),
        onchange: (e) => setFilter('categoryId', e.target.value),
      }),
    })),
    h('div', { class: 'row', style: { alignSelf: 'end' } },
      ...PRESETS.map((preset) => h('button', {
        class: 'btn sm',
        onclick: () => {
          const [from, to] = preset.range();
          state.filters.dateFrom = from;
          state.filters.dateTo = to;
          render();
          run();
        },
      }, preset.label()))));

  const sidebar = () => h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, t('reportCatalogue'))),
    h('div', { class: 'card-body', style: { display: 'grid', gap: '4px' } },
      ...catalogue.map((definition) => h('button', {
        class: `btn ${state.key === definition.key ? 'primary' : 'ghost'}`,
        style: { justifyContent: 'flex-start' },
        onclick: () => {
          state.key = definition.key;
          navigate(`reports/${definition.key}`);
          render();
          run();
        },
      }, getLanguage() === 'ar' ? definition.titleAr : definition.titleEn))));

  function render() {
    mount(root,
      h('div', { class: 'page-head' },
        h('div', {}, titleHost, h('p', {}, t('reports'))),
        h('span', { class: 'spacer' }),
        can('reports.export') ? h('button', {
          class: 'btn',
          onclick: () => api.download(`/api/reports/${state.key}`,
            { ...state.filters, format: 'csv', lang: getLanguage() }, `${state.key}.csv`),
        }, '⭳ ' + t('export')) : null,
        h('button', { class: 'btn', onclick: () => printNode(printableReport(state.report)) }, '🖨 ' + t('print')),
        h('button', { class: 'btn primary', onclick: run }, t('refresh'))),
      h('div', { class: 'grid', style: { gridTemplateColumns: '250px 1fr', alignItems: 'start' } },
        sidebar(),
        h('div', {},
          summaryHost,
          h('div', { class: 'card' }, filterBar(), resultHost))));
  }

  render();
  await run();
}

function formatSummary(key, value) {
  if (typeof value !== 'number') return String(value);
  if (/value|cost|revenue|profit|discount|outstanding|receivab|purchased|refunded|collected/i.test(key)) {
    return byType(value, 'money');
  }
  return byType(value, 'number');
}

function printableReport(report) {
  if (!report) return h('div', {}, t('noReportData'));
  const ar = getLanguage() === 'ar';
  return h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', {},
        h('div', { class: 'doc-title' }, session.settings['company.name'] || t('appName')),
        h('div', { class: 'doc-meta' }, ar ? report.titleAr : report.titleEn)),
      h('div', { class: 'right doc-meta' },
        h('div', {}, `${t('generatedAt')}: ${byType(report.generatedAt, 'datetime')}`),
        h('div', {}, `${report.rows.length} ${t('rows')}`),
        h('div', {}, Object.entries(report.filters || {})
          .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')))),
    h('table', {},
      h('thead', {}, h('tr', {}, report.columns.map((c) => h('th', {}, ar ? c.labelAr : c.labelEn)))),
      h('tbody', {}, report.rows.map((row) => h('tr', {},
        report.columns.map((c) => h('td', {}, byType(row[c.key], c.type))))))),
    h('div', { class: 'doc-totals' },
      Object.entries(report.summary || {}).map(([key, value]) => h('div', { class: 'line' },
        h('span', {}, key.replace(/_/g, ' ')),
        h('span', {}, formatSummary(key, value))))));
}
