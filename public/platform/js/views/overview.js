/**
 * Overview — the console's landing screen, and the answer to "how did we do".
 *
 * One request (`GET /api/platform/overview`) carries the whole fleet: the
 * totals, thirty days of trend, and a row per shop. Three things about the way
 * it is drawn are deliberate:
 *
 *   - A shop whose database could not be read arrives with `error: true` and
 *     is drawn that way: the last figures that could be read, next to the word
 *     "unreachable" and when the read failed — or an empty cell if there never
 *     were any. Never a zero. A zero is a claim that the shop sold nothing, and
 *     nobody here knows that.
 *   - The headline figures are the last thirty days, because that is the
 *     window the chart underneath covers. The calendar month sits beside them
 *     as the quieter comparison rather than as a second headline.
 *   - Every number in the chart is also in a table, because a hover readout is
 *     not a way to look something up twice.
 *
 * ── The figures are now READ, not computed ───────────────────────────────────
 * This screen used to open every shop's database on every load. It reads one
 * control-plane table instead (see `platform/FleetSummaryService.js`), which is
 * what makes it the same page at six shops and at eighty. The whole cost of
 * that trade is that a figure can be old, so this file's job is to make sure
 * nobody is ever fooled by one:
 *
 *   - the page says, at the top, when its figures were read and how many of the
 *     fleet's shops are behind them;
 *   - a shop read more than a few hours ago is tagged, and the tagged shops are
 *     named in a banner rather than left for somebody to notice;
 *   - a shop nobody has ever read shows dashes and "not measured yet" — never
 *     a zero, and never blended into a total as if it were one;
 *   - "today's takings" is only shown for the shops whose figures were read
 *     today. A summary taken at 23:50 is not this morning's takings, and
 *     saying so is worse than saying nothing;
 *   - and "Refresh now" opens every shop on purpose, so the answer to "is this
 *     number real" is one button rather than an argument.
 *
 * What is NOT read from a summary, and is live on every load: how many shops
 * there are, which are active, which are suspended, and each shop's status and
 * website switch. Those are decisions the owner acts on, and an old one is not
 * an old answer but a wrong one.
 */
import api from '../core/api.js';
import {
  h, mount, frag, dataTable, toast, toastError,
} from '../core/dom.js';
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
  int, money, moneyBig, relative, dateTime,
} from '../ui/format.js';
import icons from '../ui/icons.js';

const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

export async function overviewView(root) {
  const asOf = h('span', { class: 'as-of' });
  let reload = () => {};
  /** Re-read the summary table. Cheap: one control-plane query, no shop opened. */
  const refresh = iconButton({
    icon: 'refresh',
    label: t('refresh'),
    onClick: () => reload(),
  });

  /**
   * The rebuild. This one DOES open every shop, which is why it is a labelled
   * button rather than an icon and why the server audits it — pressing it is a
   * deliberate act with a cost, not a page reload.
   */
  const rebuild = h('button', { class: 'btn' }, t('refreshNow'));
  rebuild.addEventListener('click', async () => {
    rebuild.disabled = true;
    const label = rebuild.textContent;
    rebuild.textContent = t('refreshingFleet');
    try {
      const result = await api.post('/overview/refresh');
      toast(result.failed
        ? t('refreshedFleetWithErrors', { ok: result.ok, failed: result.failed })
        : t('refreshedFleet', { ok: result.ok }), result.failed ? 'warn' : 'ok');
      reload();
    } catch (error) {
      toastError(error);
    } finally {
      rebuild.disabled = false;
      rebuild.textContent = label;
    }
  });

  const host = h('div', { class: 'stack' });

  mount(root,
    pageHead({
      title: t('overview'),
      subtitle: t('overviewSubtitle'),
      actions: [asOf, rebuild, refresh],
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
      const [fleet, tenants, sweep] = await Promise.all([
        api.get('/overview'),
        /**
         * Only for the names. `/overview` reports a shop's English name (it is
         * reading the control-plane row, not the shop's own settings), and an
         * owner who works in Arabic should see the Arabic one. Enrichment: if
         * this fails, every figure on the page is still right.
         */
        api.get('/tenants').catch(() => null),
        /**
         * Whether anything is refreshing these figures on a schedule. Also
         * enrichment: without it the page simply does not show the "nothing is
         * refreshing this" banner, and every figure it does show is unchanged.
         */
        api.get('/summaries').catch(() => null),
      ]);
      const names = new Map((tenants?.rows || []).map((row) => [row.slug, row]));
      return {
        ...fleet,
        sweep,
        shops: (fleet.shops || []).map((shop) => ({ ...shop, tenant: names.get(shop.slug) })),
      };
    },
    render: (data) => {
      /**
       * The clock in the page head is the age of the FIGURES, not the moment
       * the page was drawn. Those were the same thing when this screen computed
       * everything it showed; now they are not, and showing the second one
       * would be the most convincing possible way to hide the first.
       */
      const readAt = data.summary?.newestAt;
      asOf.textContent = readAt
        ? t('figuresAsOf', { ago: relative(readAt) })
        : t('notMeasured');
      asOf.title = readAt ? dateTime(readAt) : '';
      return render(data);
    },
  });
}

function render(data) {
  const currency = data.currency || 'EGP';
  const totals = data.totals || {};
  const trend = data.trend || [];
  const shops = data.shops || [];
  const info = data.summary || {};
  const revenue30d = sum(trend, 'revenue');
  const orders30d = sum(trend, 'orders');
  const unreadable = shops.filter((shop) => shop.error);
  const stale = shops.filter((shop) => shop.stale && !shop.error);
  const unmeasured = shops.filter((shop) => !shop.measured && !shop.error);
  const staleHours = Math.round((info.staleAfterMs || 0) / 3_600_000);

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
      /**
       * Today's takings, and how much of the fleet is actually in it.
       *
       * A summary read yesterday evening holds yesterday's day-total, so the
       * server leaves those shops out of this figure entirely rather than
       * adding an old day to a new one. That makes the number right and makes
       * it incomplete, so the tile says which of the two it is: with no shop
       * read today it shows dashes, not a zero.
       */
      kpi({
        tone: totals.todayShops === 0 ? 'warn' : '',
        label: t('kpiRevenueToday'),
        value: totals.todayShops === 0 ? DASH : moneyBig(totals.revenueToday, currency),
        title: totals.todayShops === 0 ? t('todayUnknown') : money(totals.revenueToday, currency),
        sub: totals.todayShops === 0
          ? h('span', {}, t('todayUnknown'))
          : h('span', {},
            h('b', {}, int(totals.salesToday)), ` ${t('salesToday')} · `,
            t('todayFromShops', { shops: int(totals.todayShops), total: int(totals.shops) })),
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
      // Shops whose figures nobody has ever read. Beside "unreachable" because
      // they are the two reasons a row below is blank, and they are different
      // reasons: one was asked and did not answer, one was never asked.
      { label: t('notMeasuredShort'), value: int(unmeasured.length), tone: unmeasured.length > 0 ? 'warn' : '' },
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

    /**
     * The three things a reader has to be told before trusting the numbers
     * above, each only when it is true. Naming the shops matters more than the
     * count does: "four shops are stale" is a statistic, "these four" is
     * something the owner can act on.
     */
    data.sweep && data.sweep.scheduleArmed === false
      ? banner('warn', 'alert', t('sweepOffTitle'), t('sweepOffHint'))
      : null,

    stale.length
      ? banner('warn', 'clock', t('staleTitle'),
        t('staleHint', { hours: staleHours }), stale.map((shop) => shop.slug))
      : null,

    unmeasured.length
      ? banner('warn', 'clock', t('neverMeasuredTitle'),
        t('neverMeasuredHint'), unmeasured.map((shop) => shop.slug))
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
      // The subtitle is where "these figures were read, not computed" is said
      // in words, on the card that holds them, rather than only in a tooltip.
      subtitle: info.newestAt
        ? `${t('shopsByRevenueSubtitle')} · ${t('figuresReadAt', { ago: relative(info.newestAt) })}`
        : t('shopsByRevenueSubtitle'),
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
        /**
         * The status comes from the control plane and is read live on this
         * page load — it is a decision, never a summary. The other two tags
         * are about the figures beside it: "unreachable" means the last read
         * of this shop's database failed, "stale" means the last one that
         * worked was a while ago. Three different facts, three different
         * conversations, so all three are shown rather than merged.
         */
        render: (shop) => h('div', { class: 'row tight' },
          statusCell(shop.status),
          shop.error
            ? h('span', {
              class: 'tag danger',
              title: shop.summaryAttemptedAt
                ? t('unreachableSince', { ago: relative(shop.summaryAttemptedAt) })
                : (shop.errorMessage || t('unreachable')),
            }, t('unreachable'))
            : null,
          !shop.measured && !shop.error
            ? h('span', { class: 'tag warn', title: t('notMeasuredHint') }, t('notMeasured'))
            : null,
          shop.stale && shop.measured && !shop.error
            ? h('span', { class: 'tag warn', title: t('lastRead') + ': ' + dateTime(shop.summaryAt) }, t('staleTag'))
            : null),
      },
      {
        label: t('revenue30d'),
        align: 'end',
        // `measured: false` is a dash, never a bar of length zero: an empty
        // meter next to a real one reads as "this shop sold nothing".
        render: (shop) => (shop.measured
          ? amountCell(
            shop.revenue30d,
            shop.currency || fleetCurrency,
            best > 0 ? (Number(shop.revenue30d) || 0) / best : 0,
          )
          : dash()),
      },
      {
        label: t('orders30d'),
        align: 'end',
        render: (shop) => (shop.measured ? int(shop.orders30d) : dash()),
      },
      {
        label: t('usersTotal'),
        align: 'end',
        class: 'col-lo',
        render: (shop) => (shop.measured ? int(shop.users) : dash()),
      },
      {
        label: t('productsTotal'),
        align: 'end',
        class: 'col-lo',
        render: (shop) => (shop.measured ? int(shop.products) : dash()),
      },
      {
        label: t('lastActivity'),
        render: (shop) => h('span', { class: 'small muted nowrap' },
          shop.lastActivityAt ? relative(shop.lastActivityAt) : t('never')),
      },
      {
        /**
         * When this row was read, on the row itself. The banner above says
         * which shops are stale; this says how old every shop is, including
         * the fresh ones — without it "stale" is a word with no scale behind
         * it, and an owner cannot tell four minutes from four hours.
         */
        label: t('lastRead'),
        class: 'col-lo',
        render: (shop) => (shop.summaryAt
          ? h('span', {
            class: `small nowrap ${shop.stale ? 'warn-text' : 'muted'}`,
            // For a shop whose database has gone, this column is the age of the
            // FIGURES, not of the last attempt — the two are different dates and
            // conflating them is how "unreachable for a week" reads as "fine".
            // Both are in the tooltip, and the row's tag carries the failure.
            title: [
              `${dateTime(shop.summaryAt)} · ${t('summarySource')} ${sourceLabel(shop.summarySource)}`,
              shop.error && shop.summaryAttemptedAt
                ? `${t('unreachableSince', { ago: relative(shop.summaryAttemptedAt) })} · ${t('lastGoodFigures')}`
                : null,
            ].filter(Boolean).join('\n'),
          }, relative(shop.summaryAt))
          : h('span', { class: 'small muted nowrap' }, t('notMeasured'))),
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

const DASH = '—';
const dash = () => h('span', { class: 'muted' }, DASH);

/** Which of the three writers produced a row — shown in the column's tooltip. */
const sourceLabel = (source) => ({
  cron: t('sourceCron'),
  request: t('sourceRequest'),
  console: t('sourceConsole'),
  backfill: t('sourceBackfill'),
}[source] || DASH);

/**
 * One line of explanation with the shops it is about named after it. Same shape
 * as the "unreachable" strip above so the page has one way of saying "before
 * you read the numbers, know this", rather than three.
 */
function banner(tone, icon, title, body, slugs = []) {
  return h('div', { class: `inline-error ${tone}` },
    h('span', { style: { display: 'inline-flex', width: '16px' }, html: icons[icon] || icons.alert }),
    h('span', {},
      h('b', {}, title),
      ' ',
      body,
      slugs.length ? ' ' : null,
      slugs.length ? h('span', { class: 'mono' }, slugs.join(', ')) : null));
}

/** The name the reader is not reading right now — Latin under Arabic, and back. */
const otherName = (tenant) => (getLanguage() === 'ar' ? tenant.nameEn : (tenant.nameAr || '')) || '';

export default overviewView;
