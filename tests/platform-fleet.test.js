/**
 * The fleet API — `/api/platform/overview`, the per-shop report, users, roles
 * and the staff password reset — exercised through the real HTTP surface, over
 * real shops with real sales in them.
 *
 * Nothing here stubs a database. Every figure asserted below was produced by
 * ringing a sale up through the ERP's own `/api/sales`, voiding one through
 * `/api/sales/:id/void` and returning a line through `/api/returns`, so a test
 * that passes here is a statement about what the owner will actually see.
 *
 * Same bootstrap contract as tests/platform.test.js: every environment variable
 * `src/config/index.js` reads is set BEFORE the first import of anything that
 * reaches it, then the server is imported dynamically.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-fleet-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const { forgetTenant } = await import('../src/api/middleware/tenant.js');
const { round2 } = await import('../src/shared/money.js');

let base = '';
let server = null;
let owner = '';

before(async () => {
  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // The real owner account's password is only ever printed, never returned, so
  // this suite makes its own console account with a password it controls.
  const password = 'fleet-test-owner-password';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('fleet-owner', ?, 'Fleet Owner', 1, ?)
  `).run(bcrypt.hashSync(password, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST',
    body: { username: 'fleet-owner', password },
  });
  assert.equal(login.status, 200, 'the console owner can sign in');
  owner = login.cookie;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api(urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

/** Same call, but a non-2xx is a test failure rather than something to inspect. */
async function ok(urlPath, options = {}) {
  const res = await api(urlPath, options);
  assert.ok(res.status >= 200 && res.status < 300,
    `${options.method || 'GET'} ${urlPath} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

const fleet = (urlPath, options = {}) => ok(urlPath, { ...options, cookie: owner });

/** A shop, provisioned and signed into, with every module on. */
async function shop(slug, nameEn) {
  const provisioned = await tenantService.create({
    slug, nameEn, nameAr: nameEn, modules: Object.keys(MODULES), limits: {}, websiteEnabled: true,
  });
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username: provisioned.adminUsername, password: provisioned.adminPassword },
  });
  assert.equal(login.status, 200, `${slug} admin signs in`);
  return { slug, ...provisioned, cookie: login.cookie };
}

/**
 * A sellable product with stock on the shelf: one product, its single default
 * variant, then a quick adjustment to put `quantity` units into the warehouse.
 */
async function stockedProduct(s, nameEn, { price = 100, quantity = 50, published = false } = {}) {
  const product = await ok(`/t/${s.slug}/api/products`, {
    method: 'POST',
    cookie: s.cookie,
    body: {
      sku_prefix: `${s.slug.toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name_en: nameEn,
      base_cost: price / 2,
      base_price: price,
      tax_rate: 0, // a round number is easier to reason about than 14% of it
      is_published: published,
      attribute_ids: [],
      variants: [],
    },
  });
  const variant = product.variants[0];
  await ok(`/t/${s.slug}/api/inventory/quick-adjust`, {
    method: 'POST',
    cookie: s.cookie,
    body: { variantId: variant.id, newQuantity: quantity, reason: 'correction', notes: 'fleet test' },
  });
  return { product, variant };
}

const sell = (s, variant, quantity) => ok(`/t/${s.slug}/api/sales`, {
  method: 'POST',
  cookie: s.cookie,
  body: { payment_method: 'cash', lines: [{ key: 1, variant_id: variant.id, quantity }] },
});

const voidSale = (s, saleId) => ok(`/t/${s.slug}/api/sales/${saleId}/void`, {
  method: 'POST', cookie: s.cookie, body: { reason: 'fleet test void' },
});

const returnLine = (s, sale, quantity) => ok(`/t/${s.slug}/api/returns`, {
  method: 'POST',
  cookie: s.cookie,
  body: {
    return_type: 'with_receipt',
    sale_id: sale.id,
    reason_code: 'changed_mind',
    refund_method: 'cash',
    lines: [{ sale_line_id: sale.lines[0].id, quantity, condition: 'resellable' }],
  },
});

// ---------------------------------------------------------------------- 1
test('two shops with different data: each report contains only its own', async () => {
  const alpha = await shop('fleet-alpha', 'Alpha Shop');
  const beta = await shop('fleet-beta', 'Beta Shop');

  const alphaItem = await stockedProduct(alpha, 'Alpha Exclusive Widget', { price: 100 });
  const betaItem = await stockedProduct(beta, 'Beta Exclusive Gadget', { price: 250 });

  const alphaSale = await sell(alpha, alphaItem.variant, 2);   // 200
  const betaSale = await sell(beta, betaItem.variant, 1);      // 250

  const alphaReport = await fleet('/api/platform/tenants/fleet-alpha/report?days=30');
  const betaReport = await fleet('/api/platform/tenants/fleet-beta/report?days=30');

  assert.equal(alphaReport.slug, 'fleet-alpha');
  assert.equal(alphaReport.totals.revenue, round2(alphaSale.total_amount));
  assert.equal(alphaReport.totals.orders, 1);
  assert.equal(alphaReport.totals.itemsSold, 2);

  assert.equal(betaReport.totals.revenue, round2(betaSale.total_amount));
  assert.equal(betaReport.totals.orders, 1);
  assert.equal(betaReport.totals.itemsSold, 1);
  assert.notEqual(alphaReport.totals.revenue, betaReport.totals.revenue);

  // The products in one shop's report are only ever that shop's products.
  const alphaNames = alphaReport.topProducts.map((p) => p.name).join(' | ');
  const betaNames = betaReport.topProducts.map((p) => p.name).join(' | ');
  assert.match(alphaNames, /Alpha Exclusive Widget/);
  assert.doesNotMatch(alphaNames, /Beta Exclusive Gadget/);
  assert.match(betaNames, /Beta Exclusive Gadget/);
  assert.doesNotMatch(betaNames, /Alpha Exclusive Widget/);

  // …and so are the staff, and the money attributed to them.
  const alphaStaff = alphaReport.staff.find((u) => u.username === 'admin');
  assert.ok(alphaStaff, 'the shop\'s own admin is in its staff table');
  assert.equal(alphaStaff.revenue, round2(alphaSale.total_amount));
  assert.equal(alphaStaff.sales, 1);
  assert.equal(alphaStaff.role, 'admin');

  // The overview reports each shop separately, never a pooled figure.
  const overview = await fleet('/api/platform/overview');
  const rowA = overview.shops.find((r) => r.slug === 'fleet-alpha');
  const rowB = overview.shops.find((r) => r.slug === 'fleet-beta');
  assert.equal(rowA.revenue30d, round2(alphaSale.total_amount));
  assert.equal(rowB.revenue30d, round2(betaSale.total_amount));
  assert.equal(rowA.orders30d, 1);
  assert.equal(rowB.orders30d, 1);
  assert.equal(rowA.error, false);
  assert.equal(rowA.currency, 'EGP');

  // Sorted by revenue, so the shop making the most money is the first row.
  const revenues = overview.shops.filter((r) => !r.error).map((r) => r.revenue30d);
  assert.deepEqual(revenues, [...revenues].sort((x, y) => y - x));

  // Fleet-wide money is the sum of the shops, not one shop's figure repeated.
  const summed = round2(overview.shops.filter((r) => !r.error)
    .reduce((acc, r) => acc + r.revenue30d, 0));
  const trendTotal = round2(overview.trend.reduce((acc, p) => acc + p.revenue, 0));
  assert.equal(trendTotal, summed, 'the fleet trend adds up to the fleet\'s shops');
  assert.equal(overview.trend.length, 30, 'thirty days, zero-filled, no holes in the axis');

  // And lastActivityAt is a real event in that shop, not the tenant row's
  // updated_at — updating the tenant must not make a dormant shop look busy.
  assert.ok(rowA.lastActivityAt, 'a shop that traded today has an activity stamp');
  const before = rowA.lastActivityAt;
  await tenantService.update('fleet-alpha', { notes: 'touched by the owner' });
  const after = await fleet('/api/platform/overview');
  assert.equal(after.shops.find((r) => r.slug === 'fleet-alpha').lastActivityAt, before,
    'editing the tenant row does not move the shop\'s last activity');
});

// ---------------------------------------------------------------------- 2
test('revenue: a voided sale is worth nothing, a returned line still counts', async () => {
  const s = await shop('fleet-money', 'Money Shop');
  const { variant } = await stockedProduct(s, 'Money Widget', { price: 100, quantity: 100 });

  const kept = await sell(s, variant, 2);        // 200, stays as it is
  const voided = await sell(s, variant, 1);      // 100, about to be voided
  const returned = await sell(s, variant, 3);    // 300, one unit comes back

  await voidSale(s, voided.id);
  const refund = await returnLine(s, returned, 1);
  assert.ok(refund.total_amount > 0, 'the return really did refund money');

  const report = await fleet('/api/platform/tenants/fleet-money/report?days=30');

  // The void is gone from every figure it could appear in…
  const expected = round2(kept.total_amount + returned.total_amount);
  assert.equal(report.totals.revenue, expected,
    'a voided sale contributes nothing to revenue');
  assert.equal(report.totals.orders, 2, 'a voided sale is not an order');
  assert.equal(report.totals.itemsSold, 5, 'the voided unit is not an item sold');
  assert.ok(report.totals.revenue < round2(kept.total_amount + voided.total_amount
    + returned.total_amount), 'sanity: the void really was excluded');

  // …and the refund is NOT netted off the day it was sold, because the ERP's
  // own Sales Summary does not net it off either. This is the whole point: the
  // console and the shop must never disagree about the same day's takings.
  assert.equal(report.totals.revenue, round2(expected),
    'a returned line still counts in the period it was sold in');
  assert.equal(report.totals.itemsSold, 5, 'and so do its units');

  const erp = await ok('/t/fleet-money/api/reports/sales_summary', { cookie: s.cookie });
  assert.equal(report.totals.revenue, round2(erp.summary.revenue),
    'the console agrees with the shop\'s own Sales Summary, to the piastre');
  assert.equal(report.totals.orders, erp.summary.invoices,
    'and on the number of invoices behind it');

  // Per-staff money follows the same rule, so the tabs cannot contradict.
  const admin = report.staff.find((u) => u.username === 'admin');
  assert.equal(admin.revenue, expected);
  assert.equal(admin.sales, 2);

  // Top products: three units of the voided/kept item are absent, the returned
  // line's three are present.
  assert.equal(report.topProducts.length, 1);
  assert.equal(report.topProducts[0].quantity, 5);

  // The trend adds up to the same total — one definition, used everywhere.
  assert.equal(round2(report.trend.reduce((acc, p) => acc + p.revenue, 0)), expected);
  assert.equal(report.trend.reduce((acc, p) => acc + p.orders, 0), 2);

  // averageOrder is revenue over completed orders, not over every row in `sales`.
  assert.equal(report.totals.averageOrder, round2(expected / 2));
});

// ---------------------------------------------------------------------- 3
test('a suspended shop still reports — that conversation needs the numbers', async () => {
  const s = await shop('fleet-suspended', 'Suspended Shop');
  const { variant } = await stockedProduct(s, 'Suspended Widget', { price: 40 });
  const sale = await sell(s, variant, 2);

  await tenantService.suspend('fleet-suspended');

  // The shop's own ERP is closed…
  const erp = await api('/t/fleet-suspended/api/auth/me', { cookie: s.cookie });
  assert.equal(erp.status, 423, 'the shop itself is suspended');

  // …but the console can still read it.
  const report = await fleet('/api/platform/tenants/fleet-suspended/report?days=30');
  assert.equal(report.totals.revenue, round2(sale.total_amount));
  assert.equal(report.totals.orders, 1);

  const users = await fleet('/api/platform/tenants/fleet-suspended/users');
  assert.ok(users.rows.some((u) => u.username === 'admin'));

  const overview = await fleet('/api/platform/overview');
  const row = overview.shops.find((r) => r.slug === 'fleet-suspended');
  assert.equal(row.status, 'suspended');
  assert.equal(row.error, false);
  assert.equal(row.revenue30d, round2(sale.total_amount));
  assert.ok(overview.totals.suspendedShops >= 1);
  assert.equal(overview.totals.shops, overview.shops.length);
});

// ---------------------------------------------------------------------- 4
test('an unreachable shop degrades to one flagged row, never a failed page', async () => {
  await tenantService.create({
    slug: 'fleet-broken', nameEn: 'Broken Shop', nameAr: 'Broken Shop', modules: [], websiteEnabled: true,
  });
  // A path nothing can be opened at: the directory does not exist, so the file
  // cannot even be created.
  await platformDb().prepare('UPDATE tenants SET db_file = ? WHERE slug = ?')
    .run('/no/such/directory/on/this/machine/broken.db', 'fleet-broken');
  await forgetTenant('fleet-broken');

  const res = await api('/api/platform/overview', { cookie: owner });
  assert.equal(res.status, 200, 'the page still renders');

  const broken = res.data.shops.find((r) => r.slug === 'fleet-broken');
  assert.ok(broken, 'the unreachable shop is still listed, not silently dropped');
  assert.equal(broken.error, true);
  assert.equal(broken.revenue30d, null, 'null, not zero — nobody read this database');
  assert.equal(broken.orders30d, null);
  assert.equal(broken.users, null);
  assert.equal(broken.lastActivityAt, null);
  assert.equal(broken.name, 'Broken Shop', 'what the control plane knows is still shown');

  // The message is a fixed sentence: a driver's own message can quote the
  // database URL, and a URL is half of a credential.
  assert.equal(broken.errorMessage, 'This shop\'s database could not be read');
  assert.doesNotMatch(JSON.stringify(res.data), /no\/such\/directory/,
    'no database path, URL or token is ever echoed back');

  // Every other shop still answered with real numbers.
  const healthy = res.data.shops.filter((r) => !r.error);
  assert.ok(healthy.length >= 3, 'the rest of the fleet is unaffected');
  assert.ok(healthy.some((r) => r.revenue30d > 0));
  assert.equal(res.data.totals.shops, res.data.shops.length);

  // The unreachable shop sorts last rather than as if it earned zero.
  assert.equal(res.data.shops.at(-1).slug, 'fleet-broken');
});

// ---------------------------------------------------------------------- 5
test('reset-password issues a one-time password the shop\'s own login accepts', async () => {
  const s = await shop('fleet-staff', 'Staff Shop');

  const roles = await ok(`/t/${s.slug}/api/users/roles`, { cookie: s.cookie });
  const cashier = roles.rows.find((r) => r.code === 'cashier');
  await ok(`/t/${s.slug}/api/users`, {
    method: 'POST',
    cookie: s.cookie,
    body: {
      username: 'till1', full_name: 'Till One', role_id: cashier.id,
      password: 'original-password-1',
    },
  });

  const listed = await fleet(`/api/platform/tenants/${s.slug}/users`);
  const row = listed.rows.find((u) => u.username === 'till1');
  assert.ok(row, 'the console lists the shop\'s staff');
  assert.equal(row.role, 'cashier');
  assert.equal(row.isActive, true);
  assert.ok(!('password_hash' in row) && !('passwordHash' in row), 'no hash is ever returned');

  // The original password works before the reset.
  const beforeReset = await api(`/t/${s.slug}/api/auth/login`, {
    method: 'POST', body: { username: 'till1', password: 'original-password-1' },
  });
  assert.equal(beforeReset.status, 200);

  const reset = await fleet(`/api/platform/tenants/${s.slug}/users/${row.id}/reset-password`, {
    method: 'POST',
  });
  assert.ok(typeof reset.oneTimePassword === 'string' && reset.oneTimePassword.length >= 16,
    'a real generated password came back');

  // The new one works…
  const withNew = await api(`/t/${s.slug}/api/auth/login`, {
    method: 'POST', body: { username: 'till1', password: reset.oneTimePassword },
  });
  assert.equal(withNew.status, 200, 'the shop\'s own login accepts the one-time password');
  assert.equal(withNew.data.user.mustChangePassword, true,
    'and insists it is changed, so a one-time password cannot become a permanent one');

  // …and the old one does not.
  const withOld = await api(`/t/${s.slug}/api/auth/login`, {
    method: 'POST', body: { username: 'till1', password: 'original-password-1' },
  });
  assert.equal(withOld.status, 401);

  // The console's own list agrees.
  const after = await fleet(`/api/platform/tenants/${s.slug}/users`);
  assert.equal(after.rows.find((u) => u.username === 'till1').mustChangePassword, true);

  // Resetting somebody who is not there is a 404, not a silent new password.
  const missing = await api(`/api/platform/tenants/${s.slug}/users/999999/reset-password`, {
    method: 'POST', cookie: owner,
  });
  assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------- 6
test('roles answer "why can\'t my cashier do that" from the shop\'s own tables', async () => {
  const data = await fleet('/api/platform/tenants/fleet-alpha/roles');
  const cashier = data.rows.find((r) => r.code === 'cashier');
  const admin = data.rows.find((r) => r.code === 'admin');

  assert.ok(cashier && admin);
  assert.ok(cashier.nameAr && admin.nameAr, 'both languages come back');
  assert.ok(cashier.permissions.includes('sales.create'));
  assert.ok(!cashier.permissions.includes('users.create'), 'the answer to the question');
  assert.ok(admin.permissions.includes('users.create'));
  assert.ok(admin.userCount >= 1, 'and how many people hold the role');

  assert.ok(data.catalogue.length > 0);
  for (const entry of data.catalogue.slice(0, 5)) {
    assert.equal(entry.code, `${entry.module}.${entry.action}`);
  }
  // Every permission a role holds exists in the catalogue it is read against.
  const known = new Set(data.catalogue.map((p) => p.code));
  for (const code of cashier.permissions) assert.ok(known.has(code), `${code} is in the catalogue`);
});

// ---------------------------------------------------------------------- 7
test('the console never decides how much work the server does', async () => {
  // A slug that does not exist is a 404 on every fleet route.
  for (const url of [
    '/api/platform/tenants/no-such-shop/report',
    '/api/platform/tenants/no-such-shop/users',
    '/api/platform/tenants/no-such-shop/roles',
  ]) {
    const res = await api(url, { cookie: owner });
    assert.equal(res.status, 404, url);
    assert.equal(res.data.error.code, 'NOT_FOUND');
  }

  // `days` is clamped, whatever is asked for.
  const huge = await fleet('/api/platform/tenants/fleet-alpha/report?days=100000');
  assert.equal(huge.days, 365);
  assert.equal(huge.trend.length, 365);

  const nonsense = await fleet('/api/platform/tenants/fleet-alpha/report?days=banana');
  assert.equal(nonsense.days, 30);
  assert.equal(nonsense.trend.length, 30);

  const negative = await fleet('/api/platform/tenants/fleet-alpha/report?days=-5');
  assert.equal(negative.days, 30);

  // And none of it is reachable without the owner's session.
  for (const url of ['/api/platform/overview', '/api/platform/tenants/fleet-alpha/report']) {
    const res = await api(url);
    assert.equal(res.status, 401, `${url} is behind the owner session`);
  }
  const unauthorisedReset = await api('/api/platform/tenants/fleet-alpha/users/1/reset-password', {
    method: 'POST',
  });
  assert.equal(unauthorisedReset.status, 401);
});

// ---------------------------------------------------------------------- 8
test('web orders are pipeline until they are delivered, and are never counted twice', async () => {
  const s = await shop('fleet-web', 'Web Shop');
  const { variant } = await stockedProduct(s, 'Web Widget', { price: 100, published: true });

  // Placed by a customer on the storefront — unauthenticated, like the real one.
  const order = await ok(`/t/${s.slug}/api/shop/orders`, {
    method: 'POST',
    body: {
      lines: [{ variant_id: variant.id, quantity: 2 }],
      customer: { name: 'Web Customer', phone: '+201009998877' },
      address: { line: '2 Test Street', city: 'Cairo' },
      language: 'en',
    },
  });
  const goods = 200;
  assert.equal(order.subtotal, goods);
  assert.ok(order.delivery_fee > 0, 'the shop charges for delivery');
  assert.equal(order.total_amount, round2(goods + order.delivery_fee));

  // Nothing has been sold: the goods are still on the shelf and no money has
  // changed hands, so the order shows as pipeline and revenue is untouched.
  const pipeline = await fleet(`/api/platform/tenants/${s.slug}/report?days=30`);
  assert.equal(pipeline.totals.revenue, 0, 'an undelivered order is not revenue');
  assert.equal(pipeline.totals.orders, 0);
  assert.equal(pipeline.totals.itemsSold, 0);
  assert.equal(pipeline.totals.webOrdersPending, 1, 'it is pipeline, and visible as such');

  const overviewBefore = await fleet('/api/platform/overview');
  assert.equal(overviewBefore.shops.find((r) => r.slug === s.slug).revenue30d, 0);
  assert.ok(overviewBefore.totals.webOrdersPending >= 1);

  // The storefront never hands out the internal id; staff find the order in
  // the ERP by its order number, exactly as they would at the counter.
  const queue = await ok(`/t/${s.slug}/api/web-orders`, { cookie: s.cookie });
  const staffView = queue.rows.find((r) => r.order_no === order.order_no);
  assert.ok(staffView, 'the order is in the shop\'s queue');

  // The courier hands it over and takes the cash. THIS is the sale.
  await ok(`/t/${s.slug}/api/web-orders/${staffView.id}/accept`, { method: 'POST', cookie: s.cookie });
  await ok(`/t/${s.slug}/api/web-orders/${staffView.id}/dispatch`, { method: 'POST', cookie: s.cookie });
  const delivered = await ok(`/t/${s.slug}/api/web-orders/${staffView.id}/deliver`, {
    method: 'POST', cookie: s.cookie,
  });
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.sale_id, 'delivering raised an invoice');

  const sold = await fleet(`/api/platform/tenants/${s.slug}/report?days=30`);

  // Counted exactly once, and as the invoice — not as the invoice plus the
  // order it came from, which is what a naive `sales + web_orders` sum would do.
  assert.equal(sold.totals.orders, 1, 'one transaction, one order — not two');
  assert.equal(sold.totals.revenue, goods,
    'the invoice, once: not the order as well, and not the delivery fee');
  assert.notEqual(sold.totals.revenue, order.total_amount,
    'the delivery fee is on the order, not on the invoice the ERP raised');
  assert.notEqual(sold.totals.revenue, round2(goods * 2), 'and certainly not both');
  assert.equal(sold.totals.itemsSold, 2);

  // A delivered order has left the pipeline entirely.
  assert.equal(sold.totals.webOrdersPending, 0);

  // The shop's own Sales Summary says the same thing, which is the real test.
  const erp = await ok(`/t/${s.slug}/api/reports/sales_summary`, { cookie: s.cookie });
  assert.equal(sold.totals.revenue, round2(erp.summary.revenue));
});
