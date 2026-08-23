/**
 * The fleet overview, read instead of computed.
 *
 * ── The problem this replaces ────────────────────────────────────────────────
 * `FleetService.overviewLive()` builds the owner's landing screen by opening
 * every shop's database — four at a time, with a deadline, and its own comment
 * says what it fears: *"a fleet of eighty shops must not open eighty sockets."*
 * At six shops it was fine. At eighty, every page load costs eighty connections
 * on a metered database and the console is unusable.
 *
 * So each shop's figures are written down, once, into one control-plane table
 * (`tenant_summaries`), and the console reads that table. One query, no shop
 * connections, the same answer whether the fleet is six shops or eight hundred.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT MAY BE OLD, AND WHAT MAY NOT
 * ══════════════════════════════════════════════════════════════════════════════
 * The console shows two different kinds of thing, and only one of them is safe
 * to read from a summary.
 *
 *   STATISTICS — takings, orders, seats used, products, pending web orders, the
 *   thirty-day trend. These describe what happened. A few hours old is fine as
 *   long as the reader is told how old, which is why every figure on that screen
 *   travels with the moment it was computed.
 *
 *   DECISIONS — is this shop active or suspended, is its website on, which
 *   modules does it have, what are its limits, how many shops exist. These are
 *   things the owner acts on, and an old answer is not an old answer, it is a
 *   wrong one: "suspend this shop" pressed against a stale status suspends the
 *   wrong thing. Every one of them is read LIVE from `tenants` on the same page
 *   load — the same query that lists the shops — so they cost nothing extra and
 *   can never be stale. Nothing in this file is allowed to cache them.
 *
 * The one figure that sits awkwardly between the two is `webOrdersPending`: a
 * queue is arguably a decision. It is a statistic *here* on purpose — the shop's
 * own ERP badge is the live one and is what staff work from, and the console's
 * copy exists to tell an owner which shop needs a look, not to be picked from.
 * It carries its age like everything else.
 *
 * ── "Today" and "this month" ─────────────────────────────────────────────────
 * A summary computed at 23:50 still says "today: 4,200" at 00:10, and that is a
 * lie of a different kind — not old, but about the wrong day. Each row records
 * the day and month it was computed for, and a reader on a later day reports
 * those two figures as unknown rather than as a number. The thirty-day window
 * has no such edge: it is a window, and an old one is simply an old one.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHEN A SUMMARY IS WRITTEN — three writers, three costs
 * ══════════════════════════════════════════════════════════════════════════════
 *   1. THE SWEEP (`/api/cron/summaries`, hourly). The guarantee. Staleness
 *      order — the shop that has gone longest without a good read goes first —
 *      bounded concurrency, and a budget, so a fleet too big for one invocation
 *      still makes progress on every run and never starves one shop. This is the
 *      only writer that reaches a shop nobody is using and nobody is looking at.
 *
 *   2. THE SHOP'S OWN TRAFFIC (`noteTenantRequest`, below). Free-riding on a
 *      connection that is already open. Three rules make it safe to put anywhere
 *      near a till: it runs only AFTER the response has been written, it is
 *      rate-limited per shop in this instance's memory so the ordinary case is
 *      one `Map` lookup and no I/O at all, and it only ever REFRESHES a summary
 *      that has already gone stale — it never creates one. A shop nobody has
 *      looked at in the console does not need its till writing summaries, and a
 *      brand-new shop's first figures should be the ones the console computes
 *      when it is first opened, not whatever was true at the moment somebody
 *      logged in. Writing on every request would be a tax on the till and is
 *      not what this is.
 *
 *   3. THE OWNER (`refreshFleet`, "Refresh now"). The rebuild. A summary table
 *      with no way to rebuild it is a summary table that drifts and can never be
 *      trusted again, so the old fan-out is kept and is one button away — and it
 *      is audited, because it opens every shop's database on purpose.
 *
 * plus a fourth, deliberately small: BACKFILL. A shop with no summary AT ALL is
 * read when the console first asks for it, up to `BACKFILL_MAX` shops per page
 * load. That bound is the point — the page can never open more than eight
 * databases however many shops have never been measured, and the rest render
 * honestly as "not measured yet" until the sweep or the button reaches them.
 *
 * ── What the console shows for an old summary ────────────────────────────────
 * Never a bare number. Fresh figures are shown with the time they were read;
 * past `STALE_MS` the row is flagged and counted in a banner; a shop whose last
 * read FAILED shows its last good figures next to the moment the read failed,
 * because the last true numbers are the only thing anybody can act on; and a
 * shop that has never been measured shows dashes and the words "not measured
 * yet" — never a zero, because a zero is a claim that the shop sold nothing.
 */
import { platformDb } from './db.js';
import { getDb, runWithTenant } from '../infrastructure/database/connection.js';
import { round2 } from '../shared/money.js';
import config from '../config/index.js';
import {
  overviewForShop, shopFigures, modulesFor, readTenant, mapWithConcurrency, withTimeout, zeroFilled,
  today, daysAgo, DEFAULT_DAYS, FLEET_CONCURRENCY, SHOP_TIMEOUT_MS, UNREACHABLE,
} from './FleetService.js';

/**
 * Older than this and the console says so. Tied to the sweep's hourly schedule
 * with room for a missed run or two: a figure that is one sweep old is simply
 * the current figure, and one that is three hours old means something is not
 * running and the owner should know before he acts on it.
 */
export const STALE_MS = Number(process.env.MM_FLEET_SUMMARY_STALE_MS || 3 * 3_600_000);

/**
 * How many never-measured shops one page load may read. See the header.
 *
 * Read on each call rather than at import, so an operator staring at a slow
 * console on a fleet that has just been provisioned can take it to zero without
 * a redeploy — and so the walkthrough in `tests/fleet-ui-check.mjs` can show
 * what the shops beyond the cap look like on a fleet small enough that they
 * would otherwise all be inside it.
 */
const backfillMax = () => {
  const raw = process.env.MM_FLEET_BACKFILL_MAX;
  return raw === undefined || raw === '' ? 8 : Number(raw);
};

/** Set to '0' to stop shop traffic refreshing summaries at all. */
const ON_REQUEST = process.env.MM_FLEET_SUMMARY_ON_REQUEST !== '0';

const nowIso = () => new Date().toISOString();
const monthOf = (day) => day.slice(0, 7);

/* ────────────────────────────────────────────────────────── writing one shop */

/**
 * The figures, read from a shop's already-open connection.
 *
 * Deliberately `FleetService.overviewForShop`'s own reads rather than a second
 * set of queries: a console that disagreed with itself depending on which path
 * produced the number would be worse than a slow one, and the meaning of
 * "revenue" is written down once, in that file, next to the SQL.
 */
function windowBounds() {
  const trendDays = DEFAULT_DAYS;
  const trendFrom = daysAgo(trendDays - 1);
  return { trendFrom, trendDays, from30: trendFrom };
}

function toRow(slug, tenantId, data, { source, durationMs }) {
  const at = nowIso();
  const day = today();
  return {
    tenant_id: tenantId,
    slug,
    status: 'ok',
    source,
    computed_at: at,
    attempted_at: at,
    computed_day: day,
    computed_month: monthOf(day),
    duration_ms: durationMs,
    users: data.counts.users,
    products: data.counts.products,
    revenue_30d: data.window30.revenue,
    orders_30d: data.window30.orders,
    revenue_today: data.todaySales.revenue,
    sales_today: data.todaySales.orders,
    revenue_month: data.monthSales.revenue,
    sales_month: data.monthSales.orders,
    web_orders_pending: data.pending,
    currency: data.currency,
    last_activity_at: data.activity,
    trend: JSON.stringify(data.trend),
    error: null,
  };
}

/**
 * Write a good summary. One statement on both drivers — the control plane is
 * one row per shop, so an UPSERT is the whole of it and there is no window in
 * which a shop has half a summary.
 */
async function persist(row) {
  await platformDb().prepare(`
    INSERT INTO tenant_summaries (
      tenant_id, slug, status, source, computed_at, attempted_at, computed_day,
      computed_month, duration_ms, users, products, revenue_30d, orders_30d,
      revenue_today, sales_today, revenue_month, sales_month, web_orders_pending,
      currency, last_activity_at, trend, error
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      slug = excluded.slug, status = excluded.status, source = excluded.source,
      computed_at = excluded.computed_at, attempted_at = excluded.attempted_at,
      computed_day = excluded.computed_day, computed_month = excluded.computed_month,
      duration_ms = excluded.duration_ms, users = excluded.users,
      products = excluded.products, revenue_30d = excluded.revenue_30d,
      orders_30d = excluded.orders_30d, revenue_today = excluded.revenue_today,
      sales_today = excluded.sales_today, revenue_month = excluded.revenue_month,
      sales_month = excluded.sales_month, web_orders_pending = excluded.web_orders_pending,
      currency = excluded.currency, last_activity_at = excluded.last_activity_at,
      trend = excluded.trend, error = NULL
  `).run(
    row.tenant_id, row.slug, row.status, row.source, row.computed_at, row.attempted_at,
    row.computed_day, row.computed_month, row.duration_ms, row.users, row.products,
    row.revenue_30d, row.orders_30d, row.revenue_today, row.sales_today,
    row.revenue_month, row.sales_month, row.web_orders_pending, row.currency,
    row.last_activity_at, row.trend, row.error,
  );
}

/**
 * Record that a shop could not be read.
 *
 * The figures are left exactly as they were. A shop whose database has gone is
 * the shop an owner most needs the last true numbers for, and replacing them
 * with nulls because today's read failed would destroy the only thing he can
 * act on. `status` and `attempted_at` carry the failure; `computed_at` still
 * says when the figures below it were true.
 */
async function persistFailure(tenantId, slug, source, durationMs) {
  const at = nowIso();
  await platformDb().prepare(`
    INSERT INTO tenant_summaries (tenant_id, slug, status, source, attempted_at, duration_ms, error)
    VALUES (?,?,'error',?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      slug = excluded.slug, status = 'error', source = excluded.source,
      attempted_at = excluded.attempted_at, duration_ms = excluded.duration_ms,
      error = excluded.error
  `).run(tenantId, slug, source, at, durationMs, UNREACHABLE);
}

/**
 * Read one shop and write its summary. Opens (or reuses) that shop's connection
 * — the one place in this file that touches a shop's database.
 */
export async function refreshShop(row, { source = 'cron' } = {}) {
  const started = Date.now();
  const modules = await modulesFor(row.id);
  try {
    const data = await withTimeout(
      overviewForShop(row, modules, windowBounds()),
      SHOP_TIMEOUT_MS,
    );
    await persist(toRow(row.slug, row.id, data, { source, durationMs: Date.now() - started }));
    if (source === 'cron') await keepStatisticsFresh(row, modules);
    return { slug: row.slug, ok: true, ms: Date.now() - started };
  } catch {
    // Same rule as `FleetService.overviewLive`: one shop failing is a fact about
    // that shop, not a failure of the run, and the driver's own message never
    // leaves this function — it can quote the database URL.
    await persistFailure(row.id, row.slug, source, Date.now() - started).catch(() => {});
    return { slug: row.slug, ok: false, ms: Date.now() - started };
  }
}

/**
 * `PRAGMA optimize`, once an hour, on a connection the sweep already has open.
 *
 * Migration 014 adds a partial expression index that the summary reads live on,
 * and runs `ANALYZE` so the planner will actually choose it — but a shop that
 * was empty when it was migrated has statistics that say so forever, and will
 * go on full-scanning `sales` as it fills up. `PRAGMA optimize` is SQLite's own
 * answer to that: it is a no-op unless the statistics have drifted far enough
 * to matter, so running it hourly costs nothing on the ordinary run.
 *
 * Deliberately only on the scheduled sweep, never on the request path: it is
 * the one thing here that writes to a shop's database, and the till must never
 * be behind it. Failures are ignored — a driver that does not support the
 * pragma simply keeps the statistics it has.
 */
async function keepStatisticsFresh(row, modules) {
  try {
    await readTenant(row, modules, () => getDb().prepare('PRAGMA optimize').run());
  } catch { /* statistics are an optimisation, never a reason to fail a sweep */ }
}

/* ─────────────────────────────────────────────────── the shop's own traffic */

/**
 * Per-slug, per-instance: the next moment this process will even consider
 * refreshing that shop. A busy till hits this Map and nothing else.
 */
const nextConsider = new Map();
const inFlight = new Set();

/**
 * Called from the tenant middleware once a request has been resolved.
 *
 * Everything here is arranged so that a request pays nothing: the check is a
 * Map lookup, the work is scheduled with `setImmediate` from the response's
 * `finish` event — so the customer has their answer before any of it starts —
 * and every failure is silence. If the instance is recycled before it runs, the
 * sweep still has the shop; nothing depends on this happening.
 */
export function noteTenantRequest(res, tenant, connection) {
  if (!ON_REQUEST || !tenant?.id) return;
  const slug = tenant.slug;
  const now = Date.now();
  const due = nextConsider.get(slug);
  if (due && due > now) return;
  // Claimed before the response even finishes, so a burst of concurrent
  // requests schedules one refresh between them, not one each.
  nextConsider.set(slug, now + STALE_MS);
  if (inFlight.has(slug)) return;

  const run = () => {
    inFlight.add(slug);
    setImmediate(() => {
      refreshIfStale(tenant, connection)
        .catch(() => { /* a summary is never worth an error in a shop's request */ })
        .finally(() => inFlight.delete(slug));
    });
  };
  if (res.writableEnded) run(); else res.once('finish', run);
}

/**
 * The control plane is asked how old the summary is before the shop is read.
 *
 * That one indexed row-read is what stops eight instances each recomputing the
 * same shop the first time they see it, and it is also why this can never
 * create a summary: with no row there is nothing that has gone stale, and the
 * console's own backfill is a better first reading than a login is.
 */
async function refreshIfStale(tenant, connection) {
  const existing = await platformDb()
    .prepare('SELECT attempted_at FROM tenant_summaries WHERE tenant_id = ?')
    .get(tenant.id);
  if (!existing) return;

  // `attempted_at`, for the same reason the sweep schedules on it: this is
  // "when did anybody last try", which is the question a rate limit asks.
  const age = Date.now() - Date.parse(existing.attempted_at);
  if (!(age >= STALE_MS)) {
    // Somebody else refreshed it; wait out the rest of the window here too.
    nextConsider.set(tenant.slug, Date.now() + Math.max(0, STALE_MS - age));
    return;
  }

  const started = Date.now();
  const data = await runWithTenant(
    { slug: tenant.slug, name: tenant.name, modules: tenant.modules, limits: tenant.limits },
    connection,
    () => shopFigures(windowBounds()),
  );
  await persist(toRow(tenant.slug, tenant.id, data, { source: 'request', durationMs: Date.now() - started }));
}

/* ─────────────────────────────────────────────────────────── the whole fleet */

async function tenantRows() {
  const db = platformDb();
  const rows = await db.prepare('SELECT * FROM tenants ORDER BY slug').all();
  const moduleRows = await db.prepare('SELECT tenant_id, module FROM tenant_modules').all();
  const byTenant = new Map();
  for (const r of moduleRows) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r.module);
  }
  return { rows, byTenant };
}

/**
 * Rebuild every summary — the fan-out, kept and made explicit.
 *
 * `budgetMs` is a wall clock rather than a promise of completeness: an owner
 * pressing a button on a page has a timeout, and half a fleet refreshed now
 * beats a request that dies at the proxy. Whatever is left is the top of the
 * next sweep's queue, because that queue is in staleness order.
 */
export async function refreshFleet({
  slugs = null, source = 'console', budgetMs = 20_000, concurrency = FLEET_CONCURRENCY,
} = {}) {
  const db = platformDb();
  const rows = slugs?.length
    ? await Promise.all(slugs.map((s) => db.prepare('SELECT * FROM tenants WHERE slug = ?').get(s)))
    : (await db.prepare('SELECT * FROM tenants ORDER BY slug').all());

  const started = Date.now();
  const wanted = rows.filter(Boolean);
  const done = [];
  let skipped = 0;

  await mapWithConcurrency(wanted, concurrency, async (row) => {
    if (Date.now() - started > budgetMs) { skipped += 1; return; }
    done.push(await refreshShop(row, { source }));
  });

  return {
    refreshed: done.length,
    ok: done.filter((d) => d.ok).length,
    failed: done.filter((d) => !d.ok).length,
    skipped,
    elapsedMs: Date.now() - started,
  };
}

/**
 * The shops the sweep should take, worst first: never asked at all, then least
 * recently asked. `LIMIT` and the caller's budget are what keep one invocation
 * inside a function's lifetime.
 *
 * Scheduled on `attempted_at` — when the shop was last ASKED — and not on
 * `computed_at`, which is when it last answered. The difference is a shop whose
 * database has gone: its `computed_at` never moves, so scheduling on it would
 * put that shop at the head of the queue on every single run, retrying a
 * failure every few seconds and starving every healthy shop behind it. On
 * `attempted_at` it is retried once per sweep like everything else, which is
 * exactly as often as a shop that might have come back needs to be tried.
 */
export async function staleShops({ olderThanMs, limit }) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return platformDb().prepare(`
    SELECT t.*
      FROM tenants t
      LEFT JOIN tenant_summaries s ON s.tenant_id = t.id
     WHERE s.tenant_id IS NULL
        OR s.attempted_at < ?
     ORDER BY (s.tenant_id IS NOT NULL), s.attempted_at
     LIMIT ?
  `).all(cutoff, limit);
}

/* ─────────────────────────────────────────────────────────────── the reading */

const parseTrend = (json) => {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

/**
 * The console's landing screen, from one table.
 *
 * Live from `tenants`: name, slug, status, website switch, modules, and the
 * shop/active/suspended counts. From `tenant_summaries`: every figure. Nothing
 * here opens a shop's database except the bounded backfill below.
 */
export async function overview({ backfill = true } = {}) {
  const db = platformDb();
  const { rows, byTenant } = await tenantRows();

  let summaries = new Map(
    (await db.prepare('SELECT * FROM tenant_summaries').all()).map((s) => [s.tenant_id, s]),
  );

  /**
   * Shops that have never been measured at all, up to a hard cap. Ordered by id
   * so the answer is the same on every instance, and so the shops that have been
   * waiting longest go first.
   */
  let backfilled = 0;
  const cap = backfillMax();
  if (backfill && cap > 0) {
    const missing = rows.filter((r) => !summaries.has(r.id)).slice(0, cap);
    if (missing.length) {
      await mapWithConcurrency(missing, FLEET_CONCURRENCY, (row) => refreshShop(row, { source: 'backfill' }));
      backfilled = missing.length;
      summaries = new Map(
        (await db.prepare('SELECT * FROM tenant_summaries').all()).map((s) => [s.tenant_id, s]),
      );
    }
  }

  const trendDays = DEFAULT_DAYS;
  const trendFrom = daysAgo(trendDays - 1);
  const day = today();
  const month = monthOf(day);
  const now = Date.now();

  const totals = {
    // Live, always: these are the fleet, not a measurement of it.
    shops: rows.length,
    activeShops: rows.filter((r) => r.status === 'active').length,
    suspendedShops: rows.filter((r) => r.status === 'suspended').length,
    users: 0,
    products: 0,
    salesToday: 0,
    salesMonth: 0,
    revenueToday: 0,
    revenueMonth: 0,
    webOrdersPending: 0,
    // How much of the above is actually founded on something.
    measuredShops: 0,
    unmeasuredShops: 0,
    staleShops: 0,
    unreachableShops: 0,
    todayShops: 0,
  };

  const trendByDay = new Map();
  const currencies = new Set();
  const shops = [];
  let oldestAt = null;
  let newestAt = null;

  for (const row of rows) {
    const base = {
      slug: row.slug,
      name: row.name_en,
      status: row.status,
      websiteEnabled: Boolean(row.website_enabled),
      modules: (byTenant.get(row.id) || []).sort(),
    };
    const s = summaries.get(row.id);

    if (!s || !s.computed_at) {
      /**
       * Never measured — or asked once and unreachable before a single good
       * read. Dashes, not zeros: a zero is a claim that this shop sold nothing,
       * and nobody has ever looked.
       */
      totals.unmeasuredShops += 1;
      if (s && s.status === 'error') totals.unreachableShops += 1;
      shops.push({
        ...base,
        users: null, products: null, revenue30d: null, orders30d: null,
        lastActivityAt: null, currency: null,
        measured: false,
        summaryAt: null,
        summaryAgeMs: null,
        summaryAttemptedAt: s?.attempted_at || null,
        summarySource: s?.source || null,
        stale: false,
        error: Boolean(s && s.status === 'error'),
        errorMessage: s && s.status === 'error' ? UNREACHABLE : null,
      });
      continue;
    }

    const ageMs = now - Date.parse(s.computed_at);
    const stale = ageMs > STALE_MS;
    const failed = s.status === 'error';
    if (stale) totals.staleShops += 1;
    if (failed) totals.unreachableShops += 1;
    totals.measuredShops += 1;
    if (!oldestAt || s.computed_at < oldestAt) oldestAt = s.computed_at;
    if (!newestAt || s.computed_at > newestAt) newestAt = s.computed_at;

    totals.users += Number(s.users || 0);
    totals.products += Number(s.products || 0);
    totals.revenueMonth = s.computed_month === month
      ? round2(totals.revenueMonth + Number(s.revenue_month || 0)) : totals.revenueMonth;
    totals.salesMonth += s.computed_month === month ? Number(s.sales_month || 0) : 0;
    if (s.computed_day === day) {
      totals.todayShops += 1;
      totals.revenueToday = round2(totals.revenueToday + Number(s.revenue_today || 0));
      totals.salesToday += Number(s.sales_today || 0);
    }
    totals.webOrdersPending += Number(s.web_orders_pending || 0);
    if (s.currency) currencies.add(s.currency);

    // Summed onto the CURRENT axis: a summary read three days ago contributes
    // the days it has that still fall inside the window, and nothing else.
    for (const point of parseTrend(s.trend)) {
      if (!point || point.date < trendFrom || point.date > day) continue;
      const bucket = trendByDay.get(point.date) || { revenue: 0, orders: 0 };
      bucket.revenue = round2(bucket.revenue + Number(point.revenue || 0));
      bucket.orders += Number(point.orders || 0);
      trendByDay.set(point.date, bucket);
    }

    shops.push({
      ...base,
      users: Number(s.users || 0),
      products: Number(s.products || 0),
      revenue30d: round2(s.revenue_30d || 0),
      orders30d: Number(s.orders_30d || 0),
      revenueToday: s.computed_day === day ? round2(s.revenue_today || 0) : null,
      lastActivityAt: s.last_activity_at || null,
      currency: s.currency || null,
      measured: true,
      summaryAt: s.computed_at,
      summaryAgeMs: ageMs,
      summaryAttemptedAt: s.attempted_at,
      summarySource: s.source,
      stale,
      error: failed,
      errorMessage: failed ? UNREACHABLE : null,
    });
  }

  // Unmeasured and unreachable shops sort last rather than as if they earned
  // zero — the same rule the live fan-out has always used.
  shops.sort((a, b) => (b.revenue30d ?? -1) - (a.revenue30d ?? -1));

  const trend = zeroFilled(
    [...trendByDay.entries()].map(([d, v]) => ({ day: d, ...v })),
    trendFrom,
    trendDays,
  );

  return {
    /**
     * The currency the fleet totals above are expressed in. Adding two shops
     * that price in different currencies is not a sum anybody should act on, so
     * this is the shops' own currency when they agree, and the deployment's
     * default when they do not — each shop row carries its own either way.
     */
    currency: currencies.size === 1 ? [...currencies][0] : (config.business.currency || 'EGP'),
    totals,
    shops,
    trend,
    /**
     * Everything a reader needs to judge how much to trust the numbers above,
     * in one place, so the console does not have to derive it from the rows.
     */
    summary: {
      source: 'summaries',
      readAt: nowIso(),
      oldestAt,
      newestAt,
      staleAfterMs: STALE_MS,
      measured: totals.measuredShops,
      unmeasured: totals.unmeasuredShops,
      stale: totals.staleShops,
      unreachable: totals.unreachableShops,
      backfilled,
      /** Shops whose figures were computed today, so "today's takings" is theirs. */
      todayShops: totals.todayShops,
    },
  };
}

export default {
  overview, refreshShop, refreshFleet, staleShops, noteTenantRequest, STALE_MS,
};
