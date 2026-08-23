/** Report centre — one screen driving every report definition on the server. */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, selectInput, field, toastError, printNode,
} from '../core/ui.js';
import { t, tCode, pick, getLanguage } from '../core/i18n.js';
import { byType, isoDate, daysAgoIso, startOfMonthIso } from '../core/format.js';
import { session, can, lookup } from '../core/store.js';
import { navigate } from '../core/router.js';

const PRESETS = [
  { key: 'today', label: () => t('today'), range: () => [isoDate(), isoDate()] },
  { key: 'week', label: () => t('thisWeek'), range: () => [daysAgoIso(6), isoDate()] },
  { key: 'month', label: () => t('thisMonth'), range: () => [startOfMonthIso(), isoDate()] },
  { key: 'days90', label: () => '90d', range: () => [daysAgoIso(89), isoDate()] },
  // Two empty dates. `api.get` drops empty values, so the server sees no range
  // at all and answers for the shop's whole history — which is the question
  // "how much have I spent on this shop" is actually asking.
  { key: 'all', label: () => t('allTime'), range: () => ['', ''] },
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
    range: 'month',
    report: null,
  };

  const definitionOf = (key) => catalogue.find((entry) => entry.key === key) || null;

  /**
   * The window a report opens on.
   *
   * Almost every report here answers a question with a month in it, and "this
   * month so far" is the right thing to show. Two of them do not: "how much
   * have I put into this shop" and "what has the shop made" are lifetime
   * questions, and opening them on the current month answers a question nobody
   * asked with a number that looks like an answer to the one they did.
   *
   * So a report declares which kind it is and the screen follows — but only
   * when the kind CHANGES. Somebody who has typed a date range and is moving
   * between two lifetime reports keeps his dates; the filters are never taken
   * away from him, only defaulted differently.
   */
  function applyDefaultRange(key) {
    const wanted = definitionOf(key)?.defaultRange === 'all' ? 'all' : 'month';
    if (wanted === state.range) return;
    state.range = wanted;
    state.filters.dateFrom = wanted === 'all' ? '' : startOfMonthIso();
    state.filters.dateTo = wanted === 'all' ? '' : isoDate();
  }
  applyDefaultRange(state.key);

  const resultHost = h('div', { class: 'card-body tight' }, spinner());
  const noteHost = h('div');
  const summaryHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });
  const titleHost = h('h2', {});

  async function run() {
    mount(resultHost, spinner());
    try {
      const report = await api.get(`/api/reports/${state.key}`, state.filters);
      state.report = report;
      mount(titleHost, getLanguage() === 'ar' ? report.titleAr : report.titleEn);

      // What this report means, when it needs saying, and what this run of it
      // could not see. The first is how a reader of the sales summary finds
      // out that its "profit" column is before costs; the second is how the
      // owner of a shop that had stock before it had a system finds out that
      // the money he paid for it is in none of these totals. A number can
      // change meaning without changing value, and a total can be missing
      // something without looking like it is — a report that lets somebody
      // assume either is worse than one that explains itself.
      mount(noteHost, ...callouts(report));

      // The summary keys arrive from the server in snake_case (`net_profit`)
      // and used to be printed with the underscores swapped for spaces — which
      // is English, in the middle of an otherwise Arabic screen. `tCode` is the
      // one conversion; a key nobody has written a word for yet still reads as
      // it always did rather than disappearing.
      // A report may name the one figure that IS its answer — "how much have I
      // spent on this shop" has exactly one — and that tile is marked so it
      // does not arrive as the first of seven identical boxes.
      mount(summaryHost, ...Object.entries(report.summary || {}).map(([key, value]) => h('div', {
        class: `kpi${key === report.headline ? ' accent headline' : ''}`,
      },
      h('div', { class: 'label' }, tCode(key, key.replace(/_/g, ' '))),
      h('div', { class: 'value' }, formatSummary(key, value)))));

      mount(resultHost, dataTable({
        columns: report.columns.map((column) => ({
          key: column.key,
          label: getLanguage() === 'ar' ? column.labelAr : column.labelEn,
          type: column.type,
          render: (row) => byType(cell(row, column.key), column.type),
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
          state.range = preset.key === 'all' ? 'all' : 'month';
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
          applyDefaultRange(definition.key);
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
      // Same reason as the dashboard's `span-2`: a fixed 250 px sidebar beside
      // `1fr` cannot fit a phone, and the breakpoint in app.css stacks it.
      h('div', { class: 'grid report-layout' },
        sidebar(),
        h('div', {},
          // The answer, then what it means, then what it is missing, then the
          // detail. The note used to come first, which on a phone meant the
          // owner scrolled through a paragraph about the report to reach the
          // number the report exists to give him.
          summaryHost,
          noteHost,
          h('div', { class: 'card' }, filterBar(), resultHost))));
  }

  render();
  await run();
}

const note = (report) => (getLanguage() === 'ar' ? report?.noteAr : report?.noteEn);

/**
 * One cell, in the reader's language.
 *
 * A column key ending in `_en` names the English half of a pair the row
 * carries both halves of — a supplier, a cost category, the group a spend row
 * belongs to. The server has been sending `category_name_ar` beside
 * `category_name_en` on the costs reports since they were written and nothing
 * ever printed it; the CSV export does the same lookup on the same keys, so an
 * exported Arabic report and the screen it was exported from say the same
 * words. `ReportService.localised` is the twin of this function.
 */
function cell(row, key) {
  if (getLanguage() !== 'ar' || !key.endsWith('_en')) return row[key];
  const arabic = row[`${key.slice(0, -3)}_ar`];
  return arabic === undefined || arabic === null || arabic === '' ? row[key] : arabic;
}

/** The note, then everything this run could not see. */
function callouts(report) {
  const out = [];
  if (note(report)) {
    out.push(h('div', { class: 'callout' },
      h('p', {}, h('strong', {}, `${t('reportNote')}: `), note(report))));
  }
  const warnings = report?.warnings || [];
  if (warnings.length) {
    out.push(h('div', { class: 'callout blind' },
      h('p', {}, h('strong', {}, t('whatThisCannotSee'))),
      ...warnings.map((warning) => h('p', {}, getLanguage() === 'ar' ? warning.ar : warning.en))));
  }
  return out;
}

function formatSummary(key, value) {
  if (typeof value !== 'number') return String(value);
  if (/value|cost|cogs|revenue|profit|discount|outstanding|receivab|purchased|refund|collected|paid|owed|wage|spent|committed/i.test(key)) {
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
        report.columns.map((c) => h('td', {}, byType(cell(row, c.key), c.type))))))),
    h('div', { class: 'doc-totals' },
      Object.entries(report.summary || {}).map(([key, value]) => h('div', { class: 'line' },
        h('span', {}, tCode(key, key.replace(/_/g, ' '))),
        h('span', {}, formatSummary(key, value))))),
    // A printed total that is missing something must say so on the paper. A
    // sheet handed to an accountant outlives the screen it came from.
    ...(report.warnings || []).length
      ? [h('div', { class: 'callout blind' },
        h('p', {}, h('strong', {}, t('whatThisCannotSee'))),
        ...report.warnings.map((warning) => h('p', {}, ar ? warning.ar : warning.en)))]
      : []);
}
