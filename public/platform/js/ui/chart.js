/**
 * The fleet trend, drawn by hand.
 *
 * No library, no CDN — thirty points do not need one, and a chart that is a
 * few dozen lines of SVG is a chart whose every pixel was chosen. Two panels
 * on one shared time axis: revenue as a line above, orders as bars below.
 * They are stacked rather than overlaid because money and counts share no
 * scale, and a second y axis pretending they do is the most common way a
 * dashboard lies.
 *
 * Three things this file takes seriously:
 *
 *   - RTL. In Arabic the axis runs right to left, like everything else on the
 *     page. Every x is computed through `xAt`, which is the only place that
 *     knows which way time flows.
 *   - Reading a number without a mouse. Hover is a convenience; the readout
 *     also follows the arrow keys, and `dailyTable()` puts the same thirty
 *     numbers underneath in a table anyone can read.
 *   - Never blank. With no hover the readout shows the most recent day, so
 *     there is no empty box waiting to be understood.
 */
import { h } from '../core/dom.js';
import { t, isRtl } from '../core/i18n.js';
import { compact, dayShort, int, money } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** A number line's top: rounded up to something a human would have chosen. */
function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((f) => value <= f * magnitude) || 10;
  return step * magnitude;
}

/**
 * The 30-day fleet trend.
 *
 * `trend` is the server's array of { date, revenue, orders } — already
 * zero-filled, so a day the fleet did not trade is a zero on the axis and not
 * a hole in it.
 */
export function trendChart({ trend = [], currency = 'EGP' } = {}) {
  const points = trend.length ? trend : [];
  const latest = points[points.length - 1] || null;

  const readoutDay = h('span', { class: 'day' });
  const readoutRevenue = h('span', { class: 'rev' }, t('revenue'), h('b', {}));
  const readoutOrders = h('span', { class: 'ord' }, t('orders'), h('b', {}));
  const readout = h('div', {
    class: 'chart-readout', role: 'status', 'aria-live': 'polite',
  }, readoutDay, readoutRevenue, readoutOrders);

  const legend = h('div', { class: 'chart-legend' },
    h('span', {}, h('i', { style: { background: 'var(--primary)' } }), t('revenue')),
    h('span', {}, h('i', { class: 'bar', style: { background: 'var(--warn)' } }), t('orders')));

  const svg = s('svg', {
    class: 'chart-canvas',
    tabindex: '0',
    role: 'img',
    'aria-label': `${t('fleetTrend')} — ${t('last30Days')}`,
  });

  const wrap = h('div', { class: 'chart' },
    h('div', { class: 'chart-head' }, legend, readout),
    svg);

  let hovered = points.length - 1;

  function setReadout(index) {
    const point = points[index] || latest;
    if (!point) return;
    readoutDay.textContent = dayShort(point.date);
    readoutRevenue.querySelector('b').textContent = money(point.revenue, currency);
    readoutOrders.querySelector('b').textContent = int(point.orders);
  }

  function draw() {
    const width = Math.max(280, Math.round(wrap.clientWidth || 640));
    const compactLayout = width < 560;
    const height = compactLayout ? 210 : 252;
    const rtl = isRtl();

    const gutter = compactLayout ? 40 : 52;
    const edge = 10;
    const padTop = 12;
    const labelBand = 20;
    const gap = 26;

    const plotStart = rtl ? edge : gutter;                 // physical left
    const plotEnd = rtl ? width - gutter : width - edge;   // physical right
    const plotW = Math.max(10, plotEnd - plotStart);

    const bodyH = height - padTop - labelBand - gap;
    const revH = Math.round(bodyH * 0.68);
    const ordH = bodyH - revH;
    const revTop = padTop;
    const revBottom = revTop + revH;
    const ordTop = revBottom + gap;
    const ordBottom = ordTop + ordH;

    const n = points.length;
    const peakRevenue = Math.max(...points.map((p) => p.revenue), 0);
    const peakOrders = Math.max(...points.map((p) => p.orders), 0);
    // Nothing sold in the whole window. Rather than invent an axis (a scale of
    // 0 to 1 with a flat line on it looks like a chart, and says nothing), the
    // panel says so in words.
    const silent = peakRevenue === 0 && peakOrders === 0;
    const revMax = niceMax(peakRevenue);
    const ordMax = niceMax(peakOrders);

    /** The only place that knows which way time runs. */
    const xAt = (i) => {
      const fraction = n <= 1 ? 0.5 : i / (n - 1);
      return rtl ? plotEnd - fraction * plotW : plotStart + fraction * plotW;
    };
    const indexAt = (x) => {
      if (n <= 1) return 0;
      const fraction = rtl ? (plotEnd - x) / plotW : (x - plotStart) / plotW;
      return Math.max(0, Math.min(n - 1, Math.round(fraction * (n - 1))));
    };
    const yRev = (v) => revBottom - (Math.max(0, v) / revMax) * revH;
    const yOrd = (v) => ordBottom - (Math.max(0, v) / ordMax) * ordH;

    const axisX = rtl ? plotEnd + 8 : plotStart - 8;
    const axisAnchor = rtl ? 'start' : 'end';

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.replaceChildren();

    const defs = s('defs', {},
      s('linearGradient', { id: 'kjRevFill', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0%', 'stop-color': 'var(--primary)', 'stop-opacity': '.22' }),
        s('stop', { offset: '100%', 'stop-color': 'var(--primary)', 'stop-opacity': '0' })));
    svg.append(defs);

    // ── revenue panel: three grid lines and their labels ──────────────────
    for (const fraction of [0, 0.5, 1]) {
      const y = Math.round(revBottom - fraction * revH) + 0.5;
      svg.append(s('line', {
        class: `c-grid${fraction === 0 ? ' base' : ''}`, x1: plotStart, x2: plotEnd, y1: y, y2: y,
      }));
      if (silent && fraction > 0) continue;
      svg.append(s('text', {
        class: 'c-axis', x: axisX, y: y + 3.5, 'text-anchor': axisAnchor,
      }, compact(revMax * fraction)));
    }

    if (silent) {
      svg.append(s('text', {
        class: 'c-axis', x: plotStart + plotW / 2, y: revTop + revH / 2, 'text-anchor': 'middle',
        style: 'font-size:13px',
      }, t('noSalesWindow')));
    }

    // ── revenue area + line ───────────────────────────────────────────────
    if (n) {
      const line = points.map((p, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yRev(p.revenue).toFixed(1)}`).join(' ');
      svg.append(s('path', {
        class: 'c-area',
        d: `${line} L${xAt(n - 1).toFixed(1)} ${revBottom} L${xAt(0).toFixed(1)} ${revBottom} Z`,
      }));
      svg.append(s('path', { class: 'c-line', d: line }));
    }

    // ── orders panel: bars, a baseline, and its own top label ─────────────
    const baseY = Math.round(ordBottom) + 0.5;
    svg.append(s('line', {
      class: 'c-grid base', x1: plotStart, x2: plotEnd, y1: baseY, y2: baseY,
    }));
    if (!silent) {
      svg.append(s('text', {
        class: 'c-axis', x: axisX, y: ordTop + 4, 'text-anchor': axisAnchor,
      }, compact(ordMax)));
    }

    const barW = Math.max(3, Math.min(14, (plotW / Math.max(n, 1)) * 0.62));
    const bars = [];
    points.forEach((p, i) => {
      const y = yOrd(p.orders);
      const barH = Math.max(p.orders > 0 ? 2 : 0, ordBottom - y);
      const bar = s('rect', {
        class: 'c-bar',
        x: (xAt(i) - barW / 2).toFixed(1),
        y: (ordBottom - barH).toFixed(1),
        width: barW.toFixed(1),
        height: barH.toFixed(1),
        rx: Math.min(2, barW / 2),
      });
      bars.push(bar);
      svg.append(bar);
    });

    // ── the time axis ─────────────────────────────────────────────────────
    const ticks = compactLayout ? 3 : 5;
    for (let k = 0; k < ticks; k += 1) {
      const i = Math.round((k / (ticks - 1)) * (n - 1));
      if (!points[i]) continue;
      const x = xAt(i);
      const anchor = k === 0 ? (rtl ? 'end' : 'start') : (k === ticks - 1 ? (rtl ? 'start' : 'end') : 'middle');
      svg.append(s('text', {
        class: 'c-axis', x: x.toFixed(1), y: height - 5, 'text-anchor': anchor,
      }, dayShort(points[i].date)));
    }

    // ── the hover furniture, drawn last so it sits on top ─────────────────
    const cross = s('line', {
      class: 'c-cross', y1: revTop, y2: ordBottom, x1: 0, x2: 0, style: 'opacity:0',
    });
    const dot = s('circle', { class: 'c-dot', r: 4, cx: 0, cy: 0, style: 'opacity:0' });
    svg.append(cross, dot);

    function highlight(index) {
      const point = points[index];
      if (!point) return;
      hovered = index;
      const x = xAt(index);
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.style.opacity = '1';
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', yRev(point.revenue));
      dot.style.opacity = '1';
      bars.forEach((bar, i) => bar.classList.toggle('on', i === index));
      setReadout(index);
    }

    const overlay = s('rect', {
      x: plotStart, y: revTop, width: plotW, height: ordBottom - revTop, fill: 'transparent',
    });
    overlay.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      highlight(indexAt(((event.clientX - box.left) / box.width) * width));
    });
    overlay.addEventListener('pointerleave', () => {
      cross.style.opacity = '0';
      dot.style.opacity = '0';
      bars.forEach((bar) => bar.classList.remove('on'));
      hovered = n - 1;
      setReadout(hovered);
    });
    svg.append(overlay);

    svg.onkeydown = (event) => {
      // Arrow keys walk the series for anyone who cannot hover: the readout is
      // live, so a screen reader announces each day as it is stepped onto.
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const direction = isRtl() && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') ? -step : step;
      highlight(Math.max(0, Math.min(n - 1, hovered + direction)));
    };

    setReadout(hovered);
  }

  // The chart is redrawn at the width it actually has, rather than stretched
  // by a viewBox — text scaled non-uniformly is the tell of a chart that was
  // not really drawn for the space it is in.
  if (typeof ResizeObserver === 'function') {
    let last = 0;
    const observer = new ResizeObserver(() => {
      const width = Math.round(wrap.clientWidth);
      if (width && Math.abs(width - last) > 4) { last = width; draw(); }
    });
    observer.observe(wrap);
  } else {
    window.addEventListener('resize', draw);
  }
  requestAnimationFrame(draw);
  draw();

  return wrap;
}

/**
 * The same thirty numbers as a table, folded away under the chart.
 *
 * Not an afterthought for accessibility: it is the answer to "what exactly did
 * we take on the 12th", which no hover readout survives being asked twice.
 */
export function dailyTable(trend = [], currency = 'EGP') {
  const rows = [...trend].reverse();
  return h('details', { class: 'chart-table' },
    h('summary', {}, t('showAsTable')),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('day')),
          h('th', { class: 'num' }, t('revenue')),
          h('th', { class: 'num' }, t('orders')))),
        h('tbody', {}, rows.map((point) => h('tr', {},
          h('td', { dataset: { label: t('day') } }, dayShort(point.date)),
          h('td', { class: 'num', dataset: { label: t('revenue') } }, money(point.revenue, currency)),
          h('td', { class: 'num', dataset: { label: t('orders') } }, int(point.orders))))))));
}

/**
 * A KPI tile's sparkline: the same series, thirty pixels tall, no axis. It is
 * shape only — the figure above it is the number.
 */
export function sparkline(values = [], { width = 220, height = 30 } = {}) {
  const svg = s('svg', {
    class: 'spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true',
  });
  const series = values.map((v) => Number(v) || 0);
  if (series.length < 2) return svg;
  const max = Math.max(...series, 1);
  const rtl = isRtl();
  const x = (i) => {
    const fraction = i / (series.length - 1);
    return (rtl ? 1 - fraction : fraction) * width;
  };
  const y = (v) => height - 1.5 - (v / max) * (height - 3);
  const d = series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  svg.append(s('path', { class: 'a', d: `${d} L${x(series.length - 1)} ${height} L${x(0)} ${height} Z` }));
  svg.append(s('path', { class: 'l', d }));
  return svg;
}

export default { trendChart, dailyTable, sparkline };
