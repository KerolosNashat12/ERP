/**
 * Overview — the console's landing screen, and the answer to "how did we do".
 *
 * One request (`GET /api/platform/overview`) carries the whole fleet: the
 * totals, thirty days of trend, and a row per shop. Three things about the way
 * it is drawn are deliberate:
 *
 *   - A shop whose database could not be read arrives with `error: true` and
 *     null figures, and is drawn that way: an empty cell and the word
 *     "unreachable", never a zero. A zero is a claim that the shop sold
 *     nothing, and nobody here knows that.
 *   - The headline figures are the last thirty days, because that is the
 *     window the chart underneath covers. The calendar month sits beside them
 *     as the quieter comparison rather than as a second headline.
 *   - Every number in the chart is also in a table, because a hover readout is
 *     not a way to look something up twice.
 */
import api from '../core/api.js';
import { h, mount, frag, dataTable } from '../core/dom.js';
import { t, pickName, getLanguage } from '../core/i18n.js';
import { navigate } from '../core/router.js';
import {
  pageHead, card, kpi, kpiRow, metricStrip, amountCell, statusCell, iconButton,
} from '../ui/page.js';
import {
  loadInto, skKpis, skRows, skBlock, skCard, emptyState,
} from '../ui/states.js';
import { trendChart, dailyTable, sparkline } from '../ui/chart.js';
import {
  int, money, moneyBig, relative, timeOfDay,
} from '../ui/format.js';
import icons from '../ui/icons.js';

const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

export async function overviewView(root) {
  const asOf = h('span', { class: 'as-of' });
  let reload = () => {};
  const refresh = iconButton({
    icon: 'refresh',
    label: t('refresh'),
    onClick: () => reload(),
  });

  const host = h('div', { class: 'stack' });

  mount(root,
    pageHead({
      title: t('overview'),
      subtitle: t('overviewSubtitle'),
      actions: [asOf, refresh],
    }),
    host);

  reload = loadInto(host, {
    // The same shapes at the same heights as the answer: four tiles, the strip,
    // the chart card and the table. Nothing on this page moves when it lands.
    skeleton: () => frag(
      skKpis(4),
      h('div', { class: 'metric-strip' }, Array.from({ length: 6 }, () => h('div', { class: 'metric' },
        skBlock(19), h('span', { style: { display: 'block', height: '6px' } }), skBlock(10)))),
      skCard(skBlock(324)),
      skCard(skRows(4, 6), true),
    ),
    load: async () => {
      const [fleet, tenants] = await Promise.all([
        api.get('/overview'),
        /**
         * Only for the names. `/overview` reports a shop's English name (it is
         * reading the control-plane row, not the shop's own settings), and an
         * owner who works in Arabic should see the Arabic one. Enrichment: if
         * this fails, every figure on the page is still right.
         */
        api.get('/tenants').catch(() => null),
      ]);
      const names = new Map((tenants?.rows || []).map((row) => [row.slug, row]));
      return { ...fleet, shops: (fleet.shops || []).map((shop) => ({ ...shop, tenant: names.get(shop.slug) })) };
    },
    render: (data) => {
      asOf.textContent = t('asOf', { time: timeOfDay() });
      return render(data);
    },
  });
}

function render(data) {
  const currency = data.currency || 'EGP';
  const totals = data.totals || {};
  const trend = data.trend || [];
  const shops = data.shops || [];
  const revenue30d = sum(trend, 'revenue');
  const orders30d = sum(trend, 'orders');
  const unreadable = shops.filter((shop) => shop.error);

  /**
   * A console with no shops on it yet is not a dashboard of zeros — every tile
   * would read 0 and the chart would draw a flat line along an axis it invented.
   * It is one screen with one thing to do on it.
   */
  if (!shops.length) {
    return card({
      body: emptyState({
        icon: 'shop',
        title: t('noTenantsTitle'),
        message: t('noTenantsBody'),
        action: h('a', { class: 'btn primary lg', href: '#/tenants' }, h('span', { class: 'plus' }, '+'), ' ', t('newTenant')),
      }),
    });
  }

  return frag(
    kpiRow(
      kpi({
        tone: 'accent',
        label: t('kpiRevenue30d'),
        value: moneyBig(revenue30d, currency),
        title: money(revenue30d, currency),
        sub: h('span', {}, `${t('thisMonth')} `, h('b', {}, moneyBig(totals.revenueMonth, currency))),
        spark: sparkline(trend.map((point) => point.revenue)),
      }),
      kpi({
        label: t('kpiRevenueToday'),
        value: moneyBig(totals.revenueToday, currency),
        title: money(totals.revenueToday, currency),
        sub: h('span', {}, h('b', {}, int(totals.salesToday)), ` ${t('salesToday')}`),
      }),
      kpi({
        label: t('kpiOrders30d'),
        value: int(orders30d),
        sub: h('span', {}, `${t('thisMonth')} `, h('b', {}, int(totals.salesMonth))),
      }),
      kpi({
        tone: totals.webOrdersPending > 0 ? 'warn' : '',
        label: t('kpiPending'),
        value: int(totals.webOrdersPending),
        sub: totals.webOrdersPending > 0 ? t('kpiPendingSub') : t('kpiPendingNone'),
      }),
    ),

    // Colour by meaning: the fleet's own counts in indigo, the shops that are
    // trading in green, the ones that were stopped in orange, and anything the
    // console could not read at all in red.
    metricStrip([
      { label: t('shops'), value: int(totals.shops), tone: 'primary' },
      { label: t('active'), value: int(totals.activeShops), tone: 'ok' },
      { label: t('suspended'), value: int(totals.suspendedShops), tone: totals.suspendedShops > 0 ? 'warn' : '' },
      { label: t('unreachable'), value: int(unreadable.length), tone: unreadable.length > 0 ? 'danger' : '' },
      { label: t('usersTotal'), value: int(totals.users), tone: 'primary' },
      { label: t('productsTotal'), value: int(totals.products), tone: 'primary' },
    ]),

    unreadable.length
      ? h('div', { class: 'inline-error' },
        h('span', { style: { display: 'inline-flex', width: '16px' }, html: icons.offline }),
        h('span', {},
          h('b', {}, t('unreachableTitle')),
          ' ',
          t('unreachableHint'),
          ' ',
          h('span', { class: 'mono' }, unreadable.map((shop) => shop.slug).join(', '))))
      : null,

    card({
      className: 'chart-card',
      title: t('fleetTrend'),
      subtitle: t('fleetTrendSubtitle', { currency }),
      body: frag(
        trendChart({ trend, currency }),
        dailyTable(trend, currency),
      ),
    }),

    card({
      title: t('shopsByRevenue'),
      subtitle: t('shopsByRevenueSubtitle'),
      tight: true,
      actions: [h('a', { class: 'btn sm', href: '#/tenants' }, t('shops'))],
      body: shops.length ? shopsTable(shops, currency) : emptyState({
        icon: 'shop',
        title: t('noTenantsTitle'),
        message: t('noTenantsBody'),
        action: h('a', { class: 'btn primary', href: '#/tenants' }, h('span', { class: 'plus' }, '+'), ' ', t('newTenant')),
      }),
    }),
  );
}

/**
 * The fleet, one row per shop, sorted by what they took — which the server
 * already did, putting the shops it could not read last rather than at a zero
 * they never earned.
 */
function shopsTable(shops, fleetCurrency) {
  const best = Math.max(...shops.map((shop) => Number(shop.revenue30d) || 0), 0);

  return dataTable({
    rows: shops,
    onRowClick: (shop) => navigate(`tenants/${shop.slug}`),
    rowClass: (shop) => (shop.error ? 'is-error' : ''),
    columns: [
      {
        label: t('shop'),
        // The shop's own name first and bold, then the other language's name
        // and the slug underneath — the same three lines as the shops screen,
        // so one shop looks like one shop on both of them.
        render: (shop) => h('div', { class: 'cell-title' },
          h('span', { class: 'name' }, (shop.tenant ? pickName(shop.tenant) : shop.name) || shop.slug),
          shop.tenant && otherName(shop.tenant) ? h('span', { class: 'sub' }, otherName(shop.tenant)) : null,
          h('span', { class: 'sub mono' }, shop.slug)),
      },
      {
        label: t('status'),
        // The status comes from the control plane, which answered; only the
        // shop's own database did not. Both facts are shown, because
        // "suspended" and "unreachable" are different conversations.
        render: (shop) => h('div', { class: 'row tight' },
          statusCell(shop.status),
          shop.error
            ? h('span', { class: 'tag danger', title: shop.errorMessage || t('unreachable') }, t('unreachable'))
            : null),
      },
      {
        label: t('revenue30d'),
        align: 'end',
        render: (shop) => amountCell(
          shop.revenue30d,
          shop.currency || fleetCurrency,
          best > 0 ? (Number(shop.revenue30d) || 0) / best : 0,
        ),
      },
      {
        label: t('orders30d'),
        align: 'end',
        render: (shop) => (shop.error ? dash() : int(shop.orders30d)),
      },
      {
        label: t('usersTotal'),
        align: 'end',
        class: 'col-lo',
        render: (shop) => (shop.error ? dash() : int(shop.users)),
      },
      {
        label: t('productsTotal'),
        align: 'end',
        class: 'col-lo',
        render: (shop) => (shop.error ? dash() : int(shop.products)),
      },
      {
        label: t('lastActivity'),
        render: (shop) => h('span', { class: 'small muted nowrap' },
          shop.lastActivityAt ? relative(shop.lastActivityAt) : t('never')),
      },
      {
        label: '',
        align: 'end',
        render: (shop) => h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm',
            onclick: (event) => { event.stopPropagation(); navigate(`tenants/${shop.slug}`); },
          }, t('open'))),
      },
    ],
  });
}

const dash = () => h('span', { class: 'muted' }, '—');

/** The name the reader is not reading right now — Latin under Arabic, and back. */
const otherName = (tenant) => (getLanguage() === 'ar' ? tenant.nameEn : (tenant.nameAr || '')) || '';

export default overviewView;
