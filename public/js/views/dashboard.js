/** Home screen: KPIs, 30-day trend, alerts, top products, recent invoices. */
import api from '../core/api.js';
import { h, mount, dataTable, spinner, statusTag, tag } from '../core/ui.js';
import { t, tCode, pick, getLanguage } from '../core/i18n.js';
import { money, number, date, dateTime } from '../core/format.js';
import { session, can } from '../core/store.js';
import { navigate } from '../core/router.js';

export async function dashboardView(root) {
  mount(root, spinner());
  const [data, alerts] = await Promise.all([
    api.get('/api/dashboard'),
    api.get('/api/dashboard/alerts'),
  ]);

  const kpi = (label, value, sub, accent) => h('div', { class: `kpi${accent ? ' accent' : ''}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);

  const k = data.kpis;

  const quickActions = h('div', { class: 'row' },
    can('sales.create') ? h('button', { class: 'btn gold', onclick: () => navigate('pos') }, '＋ ' + t('newSale')) : null,
    can('products.create') ? h('button', { class: 'btn', onclick: () => navigate('products/new') }, t('newProduct')) : null,
    can('purchases.create') ? h('button', { class: 'btn', onclick: () => navigate('purchases/new') }, t('newPurchaseOrder')) : null,
    can('inventory.count') ? h('button', { class: 'btn', onclick: () => navigate('adjustments/new') }, t('newCount')) : null,
    can('labels.print') ? h('button', { class: 'btn', onclick: () => navigate('labels') }, t('labelPrinting')) : null);

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('dashboard')),
        h('p', {}, `${session.user.fullName} · ${date(new Date())}`)),
      h('span', { class: 'spacer' }),
      quickActions),

    h('div', { class: 'kpis' },
      kpi(t('todaysSales'), money(k.todayRevenue), `${k.todayInvoices} ${t('invoice')}`, true),
      // Two profits, both named. The left one is the number this tile always
      // showed — revenue minus what the goods cost — and it now says so out
      // loud, because the shop's rent and wages are in this system and a tile
      // labelled just "profit" would quietly mean the wrong thing to the person
      // reading it. The right one is what he means by the word.
      kpi(t('monthRevenue'), money(k.monthRevenue), `${t('grossProfit')}: ${money(k.monthProfit)}`),
      kpi(t('costsThisMonth'), money(k.monthCosts), `${number(k.monthCostEntries)} ${t('costEntries')}`),
      kpi(t('netProfit'), money(k.monthNetProfit), t('netProfitHint'), true),
      kpi(t('averageBasket'), money(k.averageBasket), t('thisMonth')),
      kpi(t('stockValue'), money(k.stockValue), `${number(k.stockUnits)} ${t('qty')}`),
      kpi(t('lowStockItems'), number(k.lowStockCount), t('inventory')),
      kpi(t('receivables'), money(k.receivables), `${k.receivableInvoices} ${t('invoice')}`),
      kpi(t('openPurchaseOrders'), number(k.openPurchaseOrders), money(k.openPurchaseValue)),
      kpi(t('catalogueSize'), `${number(data.counts.products)} / ${number(data.counts.variants)}`,
        `${t('products')} / ${t('variants')}`)),

    h('div', { class: 'grid cols-3', style: { marginTop: '16px', alignItems: 'start' } },
      // A class rather than an inline `gridColumn`, so the phone breakpoint can
      // undo it: a two-column span inside a one-column grid is what made this
      // card 403 px wide on a 390 px screen and scrolled the whole page
      // sideways.
      h('div', { class: 'card span-2' },
        h('div', { class: 'card-head' }, h('h3', {}, t('salesTrend'))),
        h('div', { class: 'card-body' }, trendChart(data.trend))),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, t('needsAttention'))),
        h('div', { class: 'card-body stack' },
          alerts.rows.length
            ? alerts.rows.map((alert) => h('div', {
              class: `alert-item ${alert.severity}`,
              style: { cursor: 'pointer' },
              onclick: () => { window.location.hash = alert.route; },
            },
            h('div', {},
              h('div', { class: 'strong small' }, getLanguage() === 'ar' ? alert.titleAr : alert.titleEn),
              // The alert's own kind, translated. It used to be
              // `alert.type.replace(/_/g, ' ')`, which printed `low stock` in
              // English underneath a title the API had already localised —
              // the one line on the Arabic dashboard that was not in Arabic.
              h('div', { class: 'muted small' }, tCode(alert.type)))))
            : h('div', { class: 'muted small' }, '✓ ' + t('allClear')))))
    ,

    h('div', { class: 'grid cols-2', style: { marginTop: '16px', alignItems: 'start' } },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', {}, t('topProducts')),
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted small' }, t('thisMonth'))),
        h('div', { class: 'card-body tight' },
          dataTable({
            columns: [
              { key: 'sku', label: t('sku'), class: 'mono small' },
              { key: 'description', label: t('product') },
              { key: 'units', label: t('unitsSold'), type: 'number', render: (r) => number(r.units) },
              { key: 'revenue', label: t('revenue'), type: 'money', render: (r) => money(r.revenue) },
            ],
            rows: data.topProducts,
          }))),

      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', {}, t('recentSales')),
          h('span', { class: 'spacer' }),
          can('sales.view') ? h('button', { class: 'btn sm ghost', onclick: () => navigate('sales') }, t('view') + ' →') : null),
        h('div', { class: 'card-body tight' },
          dataTable({
            columns: [
              { key: 'invoice_no', label: t('invoiceNo'), class: 'mono small' },
              { key: 'customer_name', label: t('customer') },
              { key: 'sale_date', label: t('date'), render: (r) => h('span', { class: 'small muted' }, dateTime(r.sale_date)) },
              { key: 'total_amount', label: t('total'), type: 'money', render: (r) => money(r.total_amount) },
              { key: 'status', label: '', render: (r) => statusTag(r.status) },
            ],
            rows: data.recentSales,
            onRowClick: can('sales.view') ? (row) => navigate(`sales/${row.id}`) : null,
          })))),

    data.lowStock.length ? h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('lowStockItems')),
        h('span', { class: 'spacer' }),
        can('inventory.view') ? h('button', { class: 'btn sm ghost', onclick: () => navigate('inventory?low=1') }, t('view') + ' →') : null),
      h('div', { class: 'card-body tight' },
        dataTable({
          columns: [
            { key: 'sku', label: t('sku'), class: 'mono small' },
            { key: 'product', label: t('product'), render: (r) => `${pick(r, 'product_name')} — ${r.variant_label || ''}` },
            { key: 'quantity', label: t('onHand'), type: 'number', render: (r) => h('span', { class: r.quantity <= 0 ? 'strong' : '' }, number(r.quantity)) },
            { key: 'reorder_level', label: t('reorderLevel'), type: 'number', render: (r) => number(r.reorder_level) },
            { key: 'flag', label: '', render: (r) => (r.quantity <= 0 ? tag(t('outOfStock'), 'danger') : tag(t('lowStockItems'), 'warn')) },
          ],
          rows: data.lowStock,
        }))) : null);
}

/** Inline SVG sparkline — no charting dependency, prints cleanly. */
function trendChart(series) {
  if (!series?.length) return h('div', { class: 'empty' }, t('noResults'));
  const width = 720;
  const height = 200;
  const padding = { top: 14, right: 12, bottom: 24, left: 54 };
  const max = Math.max(...series.map((d) => d.revenue), 1);
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const x = (i) => padding.left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v) => padding.top + innerH - (v / max) * innerH;

  const line = series.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)},${padding.top + innerH} L${x(0).toFixed(1)},${padding.top + innerH} Z`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('preserveAspectRatio', 'none');
  // The chart is drawn left-to-right by `x(i)` in both languages, so its own
  // text has to read that way too. Without this it inherits the page's `rtl`
  // and two things break at once on the Arabic dashboard: `text-anchor="end"`
  // starts meaning the LEFT edge, so the last date is laid out off the canvas
  // and clipped to `20`; and the date itself is bidi-reordered, because a
  // hyphenated numeric string in an RTL run is not the string you wrote.
  // Dates and amounts are LTR content wherever they appear.
  svg.setAttribute('direction', 'ltr');
  svg.innerHTML = `
    <defs>
      <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1f6feb" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#1f6feb" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const gy = padding.top + innerH * ratio;
    return `<line class="grid-line" x1="${padding.left}" y1="${gy}" x2="${width - padding.right}" y2="${gy}"/>
              <text x="${padding.left - 8}" y="${gy + 3}" text-anchor="end">${Math.round(max * (1 - ratio))}</text>`;
  }).join('')}
    <path class="area" d="${area}"/>
    <path class="line" d="${line}"/>
    ${series.map((d, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.revenue).toFixed(1)}" r="2.2"><title>${d.day}: ${d.revenue}</title></circle>`).join('')}
    <text x="${padding.left}" y="${height - 6}">${series[0].day}</text>
    <text x="${width - padding.right}" y="${height - 6}" text-anchor="end">${series[series.length - 1].day}</text>
  `;
  return svg;
}
