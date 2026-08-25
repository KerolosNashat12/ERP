/**
 * The fleet, read.
 *
 * Everything the owner's console shows about *inside* a shop is read here, and
 * every one of those reads happens on that shop's own connection, inside
 * `runWithTenant`, through `getDb()`. There is no query in this file that names
 * a database, and no join that spans two shops: cross-shop figures are summed
 * in JavaScript from per-shop answers, which is the only way to add up numbers
 * that live in separate databases.
 *
 * ── What "revenue" means here ────────────────────────────────────────────────
 * Exactly what it means in the shop's own reports, because a console that
 * disagrees with the ERP it manages is worse than one that says nothing:
 *
 *   revenue = SUM(sales.total_amount) WHERE sales.status = 'completed'
 *
 * which is `ReportService.sales_summary`, `SalesRepository.salesTotals` and
 * `DashboardService.overview` byte for byte. Consequences, all deliberate:
 *
 *   - A VOIDED sale contributes nothing. `status` is 'completed' or 'void', and
 *     a void is a sale that never happened.
 *   - Tax is INCLUDED and discounts are already deducted: `total_amount` is
 *     what the customer paid, which is the number an owner means by "takings".
 *   - A RETURNED line still counts in the period it was sold in. The ERP posts
 *     a return as its own document (`sales_returns`) and never rewrites the
 *     invoice, so `sales_summary` does not net refunds off revenue either.
 *     Netting them here would make KJ Admin and the shop's own Sales Summary
 *     disagree on the same day — refunds are a separate question, answered by
 *     the returns report, not by quietly shrinking a past day's takings.
 *   - Delivery fees are excluded, because they are not on the invoice: a
 *     delivered web order raises a sale for the goods only (`WebOrderService`
 *     charges the fee on the order, not the sale).
 *
 * ── Web orders ───────────────────────────────────────────────────────────────
 * A web order is never revenue. Delivering one is what raises a sale, and that
 * sale is already in `sales` — counting the order as well would bill the owner's
 * dashboard twice for one transaction. So web orders appear here only as
 * pipeline, and `webOrdersPending` uses the ERP's own definition
 * (`WebOrderService.pendingCount()`: `status = 'pending'`) so the console's
 * badge and the shop's badge always show the same number.
 *
 * ── Cost control ─────────────────────────────────────────────────────────────
 * A dashboard must not be able to take a shop down. Every date range is bounded
 * (`MAX_DAYS`), every list has a LIMIT, shops are read a few at a time rather
 * than all at once, and each shop's read is given a deadline. A shop that fails
 * or times out inside `/overview` comes back as one flagged row; the page still
 * renders for every shop that answered.
 *
 * ── Who calls the fan-out now ────────────────────────────────────────────────
 * `overviewLive()` is no longer what the console's landing screen loads. That
 * screen reads one control-plane table — see `platform/FleetSummaryService.js`
 * — because at eighty shops a page load that opened eighty databases was both
 * unusable and, on a metered database, expensive. The fan-out stays, and stays
 * exercised, as the two things a summary table cannot do without: the way each
 * summary is computed in the first place (`shopFigures`, below, is the single
 * definition both paths read through), and an explicit "rebuild everything"
 * that an owner can press. A summary table with no way to rebuild it is a
 * summary table that drifts and can never be trusted again.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { platformDb } from './db.js';
import { getDb, openConnection, runWithTenant } from '../infrastructure/database/connection.js';
import { connectionFor } from '../infrastructure/database/connections.js';
import { NotFoundError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';

/** The widest window any endpoint will read, however large a `days` is asked for. */
const MAX_DAYS = 365;
export const DEFAULT_DAYS = 30;

/** Row caps. Long enough to answer the question, short enough to never be a scan. */
const TOP_PRODUCTS_LIMIT = 10;
const STAFF_LIMIT = 100;
const USERS_LIMIT = 500;
const ROLES_LIMIT = 100;

/** How many shops are read at once, and how long any one of them may take. */
export const FLEET_CONCURRENCY = Number(process.env.MM_FLEET_CONCURRENCY || 4);
export const SHOP_TIMEOUT_MS = Number(process.env.MM_FLEET_TIMEOUT_MS || 8000);

/**
 * What a shop row says when its database did not answer. Deliberately a fixed
 * string: a driver's message can quote the database URL back at us, and a URL
 * is half of a credential. The owner needs "this shop is unreachable, retry",
 * not a stack trace with a token in it.
 */
export const UNREACHABLE = 'This shop\'s database could not be read';

const isoDay = (date) => date.toISOString().slice(0, 10);
export const today = () => isoDay(new Date());
export const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86_400_000));
const monthStart = () => `${today().slice(0, 7)}-01`;

/** 1..MAX_DAYS, whatever the query string said. */
export function clampDays(value, fallback = DEFAULT_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), MAX_DAYS);
}

/**
 * A continuous series, whether or not the shop traded every day. A chart with
 * holes in the axis lies about the shape of a trend, so absent days are zero.
 */
export function zeroFilled(rows, fromDay, days) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const start = Date.parse(`${fromDay}T00:00:00.000Z`);
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const date = isoDay(new Date(start + i * 86_400_000));
    const hit = byDay.get(date);
    out.push({ date, revenue: round2(hit?.revenue || 0), orders: Number(hit?.orders || 0) });
  }
  return out;
}

/** Bounded parallelism: a fleet of eighty shops must not open eighty sockets. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * A deadline, so one hung database cannot hold the whole page open. The work
 * itself is not cancellable — a driver has no abort — but nothing waits on it
 * any more, and the shop degrades to its flagged row.
 */
export function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function tenantRow(slug) {
  return platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

async function requireTenantRow(slug) {
  const row = await tenantRow(slug);
  // A slug that does not exist is a 404. A *suspended* shop is not: its owner
  // may be suspended for not paying, and these numbers are exactly what that
  // conversation needs.
  if (!row) throw new NotFoundError('Tenant', slug);
  return row;
}

export async function modulesFor(tenantId) {
  const rows = await platformDb()
    .prepare('SELECT module FROM tenant_modules WHERE tenant_id = ?').all(tenantId);
  return rows.map((r) => r.module).sort();
}

/**
 * Open (or reuse) this shop's connection and run `fn` with it installed as the
 * database `getDb()` returns — the same mechanism every tenant-scoped request
 * in the codebase uses, so the reads below are ordinary single-shop SQL.
 */
export async function readTenant(row, modules, fn) {
  const connection = await connectionFor(row.slug, () => openConnection({
    driver: row.driver || 'sqlite',
    file: row.db_file,
    url: row.db_url,
    authToken: row.db_auth_token,
  }));
  return runWithTenant({
    slug: row.slug,
    name: row.name_en,
    modules: new Set(modules),
    limits: { maxUsers: row.max_users, maxProducts: row.max_products },
    websiteEnabled: Boolean(row.website_enabled),
  }, connection, fn);
}

/** The shop's own currency, with the same fallback its settings already use. */
async function currencyOf() {
  const row = await getDb().prepare("SELECT value FROM settings WHERE key = 'company.currency'").get();
  return row?.value || config.business.currency || 'EGP';
}

/**
 * The most recent thing that actually happened in this shop.
 *
 * Deliberately not the control-plane row's `updated_at`, which only moves when
 * the *owner* edits the tenant and would show a busy shop as idle and a dormant
 * one as active the moment its plan was touched. The four sources below are the
 * events an owner can act on: a sale rang up, a customer's order placed, a staff
 * member signing in, and any audited change inside the ERP.
 */
async function lastActivityAt() {
  const db = getDb();
  const [sale, order, login, audit] = await Promise.all([
    db.prepare('SELECT MAX(sale_date) AS at FROM sales').get(),
    db.prepare('SELECT MAX(created_at) AS at FROM web_orders').get(),
    db.prepare('SELECT MAX(last_login_at) AS at FROM users').get(),
    db.prepare('SELECT MAX(created_at) AS at FROM audit_logs').get(),
  ]);
  const stamps = [sale?.at, order?.at, login?.at, audit?.at].filter(Boolean);
  if (!stamps.length) return null;
  // ISO-8601 UTC throughout the schema, so lexicographic order is chronological.
  return stamps.sort().at(-1);
}

/** Completed sales only — see the file header on what counts as revenue. */
const REVENUE_SELECT = `
  COUNT(*) AS orders,
  COALESCE(SUM(total_amount), 0) AS revenue
`;

async function salesBetween(fromDay, toDay) {
  const row = await getDb().prepare(`
    SELECT ${REVENUE_SELECT}
    FROM sales
    WHERE status = 'completed'
      AND date(sale_date) >= date(?) AND date(sale_date) <= date(?)
  `).get(fromDay, toDay);
  return { orders: Number(row?.orders || 0), revenue: round2(row?.revenue || 0) };
}

async function dailyTrend(fromDay, toDay, days) {
  const rows = await getDb().prepare(`
    SELECT date(sale_date) AS day, COUNT(*) AS orders,
           COALESCE(SUM(total_amount), 0) AS revenue
    FROM sales
    WHERE status = 'completed'
      AND date(sale_date) >= date(?) AND date(sale_date) <= date(?)
    GROUP BY day ORDER BY day
  `).all(fromDay, toDay);
  return zeroFilled(rows, fromDay, days);
}

/**
 * `WebOrderService.pendingCount()`'s definition, so the console's badge and the
 * shop's own badge can never disagree. Delivered orders are absent on purpose:
 * they became sales, and are already counted as such.
 */
async function pendingWebOrders() {
  const row = await getDb().prepare("SELECT COUNT(*) AS n FROM web_orders WHERE status = 'pending'").get();
  return Number(row?.n || 0);
}

/**
 * Seats and slots, counted the way the *limits* count them: every row, active
 * or not. `AdminService` and `CatalogService` refuse a new user or product on
 * `SELECT COUNT(*)`, so a console showing a smaller number next to the same
 * limit would tell the owner they have room they do not have.
 */
async function seatCounts() {
  const db = getDb();
  const [users, products] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM users').get(),
    db.prepare('SELECT COUNT(*) AS n FROM products').get(),
  ]);
  return { users: Number(users?.n || 0), products: Number(products?.n || 0) };
}

// ---------------------------------------------------------------- /overview

/**
 * Everything `/overview` needs from one shop, in one pass over its database —
 * read from whatever connection is already in scope.
 *
 * Split out from `overviewForShop` below so that the same reads serve two
 * callers with two different connections: the console's fan-out, which opens
 * the shop, and `platform/FleetSummaryService.js`, which is handed a connection
 * a shop's own request already has open. One definition, so the summary a shop
 * writes about itself and the figures the fan-out computes can never differ.
 */
export async function shopFigures({ trendFrom, trendDays, from30 }) {
  const [counts, window30, todaySales, monthSales, trend, pending, activity, currency] = await Promise.all([
    seatCounts(),
    salesBetween(from30, today()),
    salesBetween(today(), today()),
    salesBetween(monthStart(), today()),
    dailyTrend(trendFrom, today(), trendDays),
    pendingWebOrders(),
    lastActivityAt(),
    currencyOf(),
  ]);
  return { counts, window30, todaySales, monthSales, trend, pending, activity, currency };
}

/** The same, for a shop that has to be opened first. */
export async function overviewForShop(row, modules, bounds) {
  return readTenant(row, modules, () => shopFigures(bounds));
}

/**
 * The whole fleet, computed now, by opening every shop.
 *
 * Costs one connection per shop and is bounded by `FLEET_CONCURRENCY` and
 * `SHOP_TIMEOUT_MS`. Reachable from the console only as "refresh now" (which
 * writes what it finds into `tenant_summaries`) and as `?live=1` on the
 * overview endpoint, which is the escape hatch for the day somebody does not
 * believe the summaries.
 */
export async function overviewLive() {
  const db = platformDb();
  const rows = await db.prepare('SELECT * FROM tenants ORDER BY slug').all();
  const moduleRows = await db.prepare('SELECT tenant_id, module FROM tenant_modules').all();
  const modulesByTenant = new Map();
  for (const r of moduleRows) {
    if (!modulesByTenant.has(r.tenant_id)) modulesByTenant.set(r.tenant_id, []);
    modulesByTenant.get(r.tenant_id).push(r.module);
  }

  const trendDays = DEFAULT_DAYS;
  const trendFrom = daysAgo(trendDays - 1);
  const from30 = trendFrom;

  const results = await mapWithConcurrency(rows, FLEET_CONCURRENCY, async (row) => {
    const modules = (modulesByTenant.get(row.id) || []).sort();
    const base = {
      slug: row.slug,
      name: row.name_en,
      status: row.status,
      websiteEnabled: Boolean(row.website_enabled),
      modules,
    };
    try {
      const data = await withTimeout(overviewForShop(row, modules, { trendFrom, trendDays, from30 }), SHOP_TIMEOUT_MS);
      return { ok: true, base, data };
    } catch {
      /**
       * One shop's database being unreachable is a fact about that shop, not a
       * failure of the page. It comes back flagged, with its numbers null
       * rather than zero — nobody should read "this shop made nothing" off a
       * database nobody could open.
       */
      return { ok: false, base };
    }
  });

  const totals = {
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
  };

  const trendByDay = new Map();
  const currencies = new Set();
  const shops = [];

  for (const result of results) {
    if (!result.ok) {
      shops.push({
        ...result.base,
        users: null,
        products: null,
        revenue30d: null,
        orders30d: null,
        lastActivityAt: null,
        currency: null,
        error: true,
        errorMessage: UNREACHABLE,
      });
      continue;
    }

    const { counts, window30, todaySales, monthSales, trend, pending, activity, currency } = result.data;
    totals.users += counts.users;
    totals.products += counts.products;
    totals.salesToday += todaySales.orders;
    totals.salesMonth += monthSales.orders;
    totals.revenueToday = round2(totals.revenueToday + todaySales.revenue);
    totals.revenueMonth = round2(totals.revenueMonth + monthSales.revenue);
    totals.webOrdersPending += pending;
    currencies.add(currency);

    for (const point of trend) {
      const bucket = trendByDay.get(point.date) || { revenue: 0, orders: 0 };
      bucket.revenue = round2(bucket.revenue + point.revenue);
      bucket.orders += point.orders;
      trendByDay.set(point.date, bucket);
    }

    shops.push({
      ...result.base,
      users: counts.users,
      products: counts.products,
      revenue30d: window30.revenue,
      orders30d: window30.orders,
      lastActivityAt: activity,
      currency,
      error: false,
    });
  }

  // A shop that could not be read sorts last rather than as if it earned zero.
  shops.sort((a, b) => (b.revenue30d ?? -1) - (a.revenue30d ?? -1));

  const trend = zeroFilled(
    [...trendByDay.entries()].map(([day, v]) => ({ day, ...v })),
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
  };
}

// -------------------------------------------------- /tenants/:slug/report

export async function report(slug, { days } = {}) {
  const row = await requireTenantRow(slug);
  const modules = await modulesFor(row.id);
  const windowDays = clampDays(days);
  const from = daysAgo(windowDays - 1);
  const to = today();

  return readTenant(row, modules, async () => {
    const db = getDb();
    const [
      currency, window, trend, items, counts, lowStock, pending, topProducts, staff,
      refunded, wasted,
    ] = await Promise.all([
      currencyOf(),
      salesBetween(from, to),
      dailyTrend(from, to, windowDays),

      // Units sold, defined as `ReportService.sales_summary` defines them: the
      // quantity on the lines of completed invoices in the window. Not reduced
      // by `returned_quantity`, for the same reason revenue is not.
      db.prepare(`
        SELECT COALESCE(SUM(l.quantity), 0) AS units
        FROM sale_lines l
        JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
        WHERE date(s.sale_date) >= date(?) AND date(s.sale_date) <= date(?)
      `).get(from, to),

      seatCounts(),

      // `ReportService.low_stock` / `InventoryRepository.lowStock`, unchanged.
      db.prepare(`
        SELECT COUNT(*) AS n FROM v_stock_on_hand
        WHERE variant_active = 1 AND reorder_level > 0 AND quantity <= reorder_level
      `).get(),

      pendingWebOrders(),

      // `ReportService.sales_by_product`, cut to the top few.
      db.prepare(`
        SELECT l.description AS name,
               COALESCE(SUM(l.quantity), 0) AS quantity,
               COALESCE(SUM(l.line_total), 0) AS revenue
        FROM sale_lines l
        JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
        WHERE date(s.sale_date) >= date(?) AND date(s.sale_date) <= date(?)
        GROUP BY l.variant_id
        ORDER BY revenue DESC
        LIMIT ${TOP_PRODUCTS_LIMIT}
      `).all(from, to),

      /**
       * `ReportService.sales_by_user`'s figures, driven off `users` rather than
       * off `sales` so a member of staff who sold nothing this month appears
       * with a zero instead of vanishing — "who works here and what did they
       * do" is one question, and a silent absence is the wrong answer to it.
       * The arithmetic for anyone who did sell is identical: completed invoices
       * only, voids excluded from both the count and the money.
       */
      db.prepare(`
        SELECT u.username, u.full_name AS fullName, r.code AS role,
               COUNT(s.id) AS sales,
               COALESCE(SUM(s.total_amount), 0) AS revenue
        FROM users u
        LEFT JOIN roles r ON r.id = u.role_id
        LEFT JOIN sales s ON s.created_by = u.id AND s.status = 'completed'
             AND date(s.sale_date) >= date(?) AND date(s.sale_date) <= date(?)
        GROUP BY u.id
        ORDER BY revenue DESC, u.username ASC
        LIMIT ${STAFF_LIMIT}
      `).all(from, to),

      /**
       * What came back, and what was lost.
       *
       * The console showed a shop's takings and nothing else, so a shop that
       * refunded most of what it sold and one that kept all of it looked
       * identical from up here. Revenue above is still gross — the file header
       * explains why that number must not quietly shrink — so these are shown
       * BESIDE it rather than folded into it: the owner of the fleet can see
       * both halves and neither figure has to be inferred from the other.
       */
      db.prepare(`
        SELECT COUNT(*) AS documents, COALESCE(SUM(total_amount), 0) AS amount
        FROM sales_returns
        WHERE date(return_date) >= date(?) AND date(return_date) <= date(?)
      `).get(from, to),

      // الهدر: broken, lost, stolen, expired — at what it cost the shop. The
      // same definition the shop's own screens use (see
      // InventoryRepository.wastageTotals), so the two cannot disagree.
      db.prepare(`
        SELECT COALESCE(SUM(-l.difference * l.unit_cost), 0) AS amount,
               COALESCE(SUM(-l.difference), 0) AS units
        FROM stock_adjustment_lines l
        JOIN stock_adjustments a ON a.id = l.adjustment_id
        WHERE a.status = 'posted'
          AND a.reason IN ('damage', 'loss', 'theft', 'expiry')
          AND l.difference < 0
          AND date(a.posted_at) >= date(?) AND date(a.posted_at) <= date(?)
      `).get(from, to),
    ]);

    return {
      slug: row.slug,
      name: row.name_en,
      currency,
      days: windowDays,
      from,
      to,
      totals: {
        revenue: window.revenue,
        orders: window.orders,
        averageOrder: window.orders ? round2(window.revenue / window.orders) : 0,
        itemsSold: round2(items?.units || 0),
        users: counts.users,
        products: counts.products,
        lowStock: Number(lowStock?.n || 0),
        webOrdersPending: pending,
        refunds: round2(refunded?.amount || 0),
        returns: Number(refunded?.documents || 0),
        // What the shop kept, said once here so no reader has to do the
        // subtraction in his head and get it wrong.
        netRevenue: round2(window.revenue - Number(refunded?.amount || 0)),
        wastage: round2(wasted?.amount || 0),
        wastageUnits: round2(wasted?.units || 0),
      },
      trend,
      topProducts: topProducts.map((p) => ({
        name: p.name,
        quantity: round2(p.quantity),
        revenue: round2(p.revenue),
      })),
      staff: staff.map((s) => ({
        username: s.username,
        fullName: s.fullName,
        role: s.role,
        sales: Number(s.sales || 0),
        revenue: round2(s.revenue),
      })),
    };
  });
}

// --------------------------------------------------- /tenants/:slug/users

export async function users(slug) {
  const row = await requireTenantRow(slug);
  const modules = await modulesFor(row.id);

  return readTenant(row, modules, async () => {
    // `password_hash` is never selected, so it can never be returned.
    const rows = await getDb().prepare(`
      SELECT u.id, u.username, u.full_name AS fullName, u.email,
             r.code AS role, u.is_active AS isActive, u.last_login_at AS lastLoginAt,
             u.must_change_password AS mustChangePassword
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      ORDER BY u.username
      LIMIT ${USERS_LIMIT}
    `).all();

    return {
      rows: rows.map((u) => ({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        email: u.email || null,
        role: u.role,
        isActive: Boolean(u.isActive),
        lastLoginAt: u.lastLoginAt || null,
        mustChangePassword: Boolean(u.mustChangePassword),
      })),
    };
  });
}

// --------------------------------------------------- /tenants/:slug/roles

/**
 * Every role this shop has and exactly which permissions it holds — read from
 * the shop's own `roles`/`permissions` tables rather than from
 * `shared/permissions.js`, because the question this answers is "why can't my
 * cashier do X" and the honest answer is what is in *that database*, which a
 * shop still a migration behind will not match the code's idea of.
 */
export async function roles(slug) {
  const row = await requireTenantRow(slug);
  const modules = await modulesFor(row.id);

  return readTenant(row, modules, async () => {
    const db = getDb();
    const [roleRows, grantRows, catalogue] = await Promise.all([
      db.prepare(`
        SELECT r.id, r.code, r.name_en AS nameEn, r.name_ar AS nameAr,
               (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS userCount
        FROM roles r ORDER BY r.id LIMIT ${ROLES_LIMIT}
      `).all(),
      db.prepare(`
        SELECT rp.role_id AS roleId, p.code
        FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        ORDER BY p.module, p.action
      `).all(),
      db.prepare('SELECT code, module, action FROM permissions ORDER BY module, action').all(),
    ]);

    const byRole = new Map();
    for (const grant of grantRows) {
      if (!byRole.has(grant.roleId)) byRole.set(grant.roleId, []);
      byRole.get(grant.roleId).push(grant.code);
    }

    return {
      rows: roleRows.map((r) => ({
        code: r.code,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        userCount: Number(r.userCount || 0),
        permissions: byRole.get(r.id) || [],
      })),
      catalogue,
    };
  });
}

// ------------------------------------ /tenants/:slug/users/:id/reset-password

/** The same shape `TenantService` issues: 20 URL-safe characters, from crypto. */
const generatePassword = () => crypto.randomBytes(15).toString('base64url');

/**
 * Hand a member of staff a password they can sign in with once.
 *
 * Three things happen together, and all three matter:
 *   - the password is replaced and `must_change_password` set, so the one-time
 *     password cannot become a permanent one;
 *   - the lockout is cleared. A password reset is very often the fix for "my
 *     cashier is locked out", and returning a password that the login would
 *     refuse for `locked_until` would be a lie;
 *   - the shop's own audit log records it. The owner acting from KJ Admin is
 *     still an action inside that shop, and it should be visible to the shop's
 *     manager in the audit trail like any other password reset.
 *
 * The generated password is returned to the caller and written nowhere else —
 * not to the audit detail, not to a log line.
 */
export async function resetUserPassword(slug, userId, actor = null) {
  const row = await requireTenantRow(slug);
  const modules = await modulesFor(row.id);
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('User', userId);

  const oneTimePassword = generatePassword();
  const hash = bcrypt.hashSync(oneTimePassword, config.auth.bcryptRounds);

  const target = await readTenant(row, modules, async () => {
    const db = getDb();
    const user = await db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(id);
    if (!user) throw new NotFoundError('User', id);

    await db.prepare(`
      UPDATE users
         SET password_hash = ?, must_change_password = 1,
             failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?
    `).run(hash, new Date().toISOString(), id);

    await db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, module, entity_type, entity_id,
                              entity_label, status, message, created_at)
      VALUES (NULL, ?, 'PASSWORD_RESET', 'users', 'user', ?, ?, 'SUCCESS', ?, ?)
    `).run(
      actor?.username ? `platform:${actor.username}` : 'platform',
      String(id), user.username,
      'One-time password issued from KJ Admin',
      new Date().toISOString(),
    );

    return user;
  });

  await platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (?, ?, 'RESET_USER_PASSWORD', ?, ?)
  `).run(
    actor?.id ?? null,
    row.id,
    JSON.stringify({ slug, userId: id, username: target.username }),
    new Date().toISOString(),
  );

  return { username: target.username, oneTimePassword };
}

export default {
  overviewLive, report, users, roles, resetUserPassword, clampDays,
};
