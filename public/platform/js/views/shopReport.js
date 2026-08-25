/**
 * One shop's numbers — the tab the owner opens first.
 *
 * `GET /tenants/:slug/report?days=N` answers the whole tab in one request, and
 * the window is the owner's to choose: a week when something has just gone
 * wrong, ninety days when deciding whether a shop is worth keeping open. The
 * server clamps `days`; this screen offers the three that get used.
 *
 * The chart is the fleet's chart, not a second one drawn for this screen: the
 * same component, the same axis, the same hover readout and the same table
 * folded underneath it — a shop's trend and the fleet's trend must be readable
 * as the same picture, because the owner compares them.
 *
 * Two figures deserve their reading:
 *   - Top products is what *sold*, by revenue, in the window. Ten rows, because
 *     the eleventh has never changed anybody's mind.
 *   - Staff lists everyone who works here, including the people who sold
 *     nothing. A list that quietly omits them answers a different question than
 *     the one an owner is asking when they open it.
 */
import api from '../core/api.js';
import { h, frag, dataTable, tag } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { card, kpi, kpiRow, metricStrip, amountCell, segmented } from '../ui/page.js';
import { loadInto, skKpis, skRows, skBlock, skCard, emptyState } from '../ui/states.js';
import { trendChart, dailyTable, sparkline } from '../ui/chart.js';
import { int, money, moneyBig } from '../ui/format.js';
import { roleName } from './shopRoles.js';
import { readShop } from './shopFetch.js';

const RANGES = [7, 30, 90];

/**
 * `days` comes in from the URL and goes back out through `onDays`, so a
 * refresh, a bookmark or a link pasted into a chat opens on the window the
 * owner was actually looking at.
 */
export function reportPanel(slug, { days = 30, onDays = () => {} } = {}) {
  let windowDays = RANGES.includes(Number(days)) ? Number(days) : 30;

  const label = h('span', { class: 'as-of' }, t('reportWindow', { days: windowDays }));
  const host = h('div', { class: 'stack' });
  let reload = () => {};

  const ranges = segmented(
    RANGES.map((value) => ({ value, label: t(`range${value}`) })),
    windowDays,
    (value) => {
      windowDays = Number(value);
      label.textContent = t('reportWindow', { days: windowDays });
      onDays(windowDays);
      reload();
    },
  );

  const panel = h('div', { class: 'stack' },
    h('div', { class: 'row between' }, label, ranges),
    host);

  reload = loadInto(host, {
    skeleton: () => frag(
      skKpis(4),
      h('div', { class: 'metric-strip' }, Array.from({ length: 4 }, () => h('div', { class: 'metric' },
        skBlock(19), h('span', { style: { display: 'block', height: '6px' } }), skBlock(10)))),
      skCard(skBlock(300)),
      h('div', { class: 'grid cols-2' }, skCard(skRows(5, 3), true), skCard(skRows(5, 4), true)),
    ),
    load: () => readShop(api.get(`/tenants/${slug}/report`, { days: windowDays })),
    render: (data) => renderReport(data),
  });

  panel.reload = () => reload();
  return panel;
}

function renderReport(data) {
  const currency = data.currency || 'EGP';
  const totals = data.totals || {};
  const trend = data.trend || [];
  const days = data.days || 30;

  return frag(
    kpiRow(
      kpi({
        tone: 'accent',
        label: t('kpiRevenueWindow', { days }),
        value: moneyBig(totals.revenue, currency),
        title: money(totals.revenue, currency),
        sub: h('span', {}, h('b', {}, int(totals.orders)), ` ${t('orders')}`),
        // A shop that has not sold anything gets no sparkline: a flat line
        // along the floor of the tile looks like a reading, and it is not one.
        spark: totals.revenue > 0 ? sparkline(trend.map((point) => point.revenue)) : null,
      }),
      kpi({
        label: t('kpiAverageOrder'),
        value: moneyBig(totals.averageOrder, currency),
        title: money(totals.averageOrder, currency),
        sub: t('perSale'),
      }),
      kpi({
        label: t('kpiOrdersWindow', { days }),
        value: int(totals.orders),
        sub: h('span', {}, h('b', {}, int(totals.itemsSold)), ` ${t('itemsSoldSub')}`),
      }),
      kpi({
        tone: totals.webOrdersPending > 0 ? 'warn' : '',
        label: t('kpiPending'),
        value: int(totals.webOrdersPending),
        sub: totals.webOrdersPending > 0 ? t('kpiPendingSub') : t('kpiPendingNone'),
      }),
    ),

    /*
     * What came back, and what was lost.
     *
     * The console showed takings and nothing else, so a shop that refunded most
     * of what it sold looked identical from up here to one that kept all of it.
     * Beside the revenue rather than folded into it: both halves visible, and
     * neither number inferred from the other.
     */
    metricStrip([
      { label: t('fleetKept'), value: money(totals.netRevenue, currency) },
      {
        label: t('fleetRefunds'),
        value: money(totals.refunds, currency),
        tone: totals.refunds > 0 ? 'warn' : '',
      },
      {
        label: t('fleetWastage'),
        value: money(totals.wastage, currency),
        tone: totals.wastage > 0 ? 'warn' : '',
      },
      { label: t('fleetWastageUnits'), value: int(totals.wastageUnits) },
      // The bin, from up here: what is hidden right now, and how much of it is
      // days away from being destroyed for good.
      { label: t('fleetTrashInBin'), value: int(totals.trashInBin) },
      {
        label: t('fleetTrashDueSoon'),
        value: int(totals.trashDueSoon),
        tone: totals.trashDueSoon > 0 ? 'warn' : '',
      },
    ]),

    metricStrip([
      { label: t('usersTotal'), value: int(totals.users) },
      { label: t('productsTotal'), value: int(totals.products) },
      { label: t('lowStockLabel'), value: int(totals.lowStock) },
      { label: t('kpiItemsSold'), value: int(totals.itemsSold) },
    ]),

    card({
      className: 'chart-card',
      title: t('shopTrend'),
      subtitle: t('shopTrendSubtitle', { currency }),
      body: frag(
        trendChart({ trend, currency }),
        // The fleet's own table, relabelled: its summary is written for the
        // Overview's fixed thirty days, and this window is the owner's to set.
        windowTable(trend, currency),
      ),
    }),

    h('div', { class: 'grid cols-2' },
      card({
        title: t('topProducts'),
        subtitle: t('topProductsSubtitle'),
        tight: true,
        body: topProductsTable(data.topProducts || [], currency),
      }),
      card({
        title: t('staffPerformance'),
        subtitle: t('staffPerformanceSubtitle'),
        tight: true,
        body: staffTable(data.staff || [], currency),
      })),
  );
}

function windowTable(trend, currency) {
  const table = dailyTable(trend, currency);
  const summary = table.querySelector('summary');
  if (summary) summary.textContent = t('showWindowAsTable');
  return table;
}

function topProductsTable(rows, currency) {
  if (!rows.length) {
    return emptyState({ icon: 'box', title: t('noSalesTitle'), message: t('noSalesBody') });
  }
  const best = Math.max(...rows.map((row) => Number(row.revenue) || 0), 0);
  return dataTable({
    rows,
    columns: [
      { label: t('product'), render: (row) => h('div', { class: 'cell-title' }, h('span', { class: 'name' }, row.name)) },
      { label: t('quantity'), align: 'end', render: (row) => int(row.quantity) },
      {
        label: t('revenue'),
        align: 'end',
        render: (row) => amountCell(row.revenue, currency, best > 0 ? row.revenue / best : 0),
      },
    ],
  });
}

function staffTable(rows, currency) {
  if (!rows.length) {
    return emptyState({ icon: 'users', title: t('noUsersTitle'), message: t('noUsersBody') });
  }
  const best = Math.max(...rows.map((row) => Number(row.revenue) || 0), 0);
  return dataTable({
    rows,
    columns: [
      {
        label: t('staffMember'),
        render: (row) => h('div', { class: 'cell-title' },
          h('span', { class: 'name' }, row.fullName || row.username),
          // The account name is Latin either way: isolated, so an Arabic row
          // does not reorder it into "mm1@".
          h('span', { class: 'sub mono', dir: 'ltr' }, `@${row.username}`)),
      },
      {
        label: t('roleColumn'),
        class: 'col-lo',
        render: (row) => (row.role ? tag(roleName(row.role), 'quiet') : h('span', { class: 'muted' }, '—')),
      },
      { label: t('salesCount'), align: 'end', render: (row) => int(row.sales) },
      {
        label: t('revenue'),
        align: 'end',
        render: (row) => amountCell(row.revenue, currency, best > 0 ? row.revenue / best : 0),
      },
    ],
  });
}

export default reportPanel;
