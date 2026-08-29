import './single-shop.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'probe');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

await initDb();
await applySchema();
await seedBaseline();
await runMigrations();
const server = await new Promise((r) => { const s = http.createServer(createApp()).listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = (await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
}).then((r) => r.headers.get('set-cookie'))).split(';')[0];

async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, 'Idempotency-Key': `p-${Math.random()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: res.status, data: d };
}
const show = (label, v) => console.log(`\n--- ${label} ---\n${JSON.stringify(v, null, 1).slice(0, 1400)}`);

const supplier = (await call('/api/suppliers', { method: 'POST', body: { name_en: 'S' } })).data;
const product = (await call('/api/products', {
  method: 'POST',
  body: {
    sku_prefix: 'PB', name_en: 'PB', name_ar: 'PB', base_price: 300, gender: 'women', is_published: 1,
    variants: [{ sku: 'PB-1', variant_label: '', cost_price: 100, selling_price: 300 }],
  },
})).data;
const variant = product.variants[0];

const po = (await call('/api/purchases', {
  method: 'POST',
  body: {
    supplier_id: supplier.id, order_date: '2026-01-01',
    discount_type: 'percent', discount_percent: 10, shipping_amount: 100,
    lines: [{ variant_id: variant.id, quantity_ordered: 20, unit_cost: 100, discount_percent: 0, tax_rate: 0 }],
  },
})).data;
await call(`/api/purchases/${po.id}/approve`, { method: 'POST', body: {} });
const poFull = (await call(`/api/purchases/${po.id}`)).data;
show('PO', { subtotal: poFull.subtotal, discount_type: poFull.discount_type, discount_percent: poFull.discount_percent, discount_amount: poFull.discount_amount, shipping_amount: poFull.shipping_amount, total_amount: poFull.total_amount });
await call(`/api/purchases/${po.id}/receive`, { method: 'POST', body: { receipts: [{ line_id: poFull.lines[0].id, quantity: 20 }] } });

const sale = (await call('/api/sales', { method: 'POST', body: { payment_method: 'cash', lines: [{ variant_id: variant.id, quantity: 3 }] } })).data;
show('SALE', { subtotal: sale.subtotal, discount_amount: sale.discount_amount, tax_amount: sale.tax_amount, total_amount: sale.total_amount, keys: Object.keys(sale) });

const saleDetail = (await call(`/api/sales/${sale.id}`)).data;
const ret = (await call('/api/returns', { method: 'POST', body: { return_type: 'with_receipt', sale_id: sale.id, lines: [{ sale_line_id: saleDetail.lines[0].id, quantity: 1, condition: 'resellable' }] } }));
show('RETURN', ret.data);

const ex = (await call('/api/exchanges', { method: 'POST', body: { sale_id: sale.id, lines: [{ sale_line_id: saleDetail.lines[0].id, quantity: 1 }], replacements: [{ variant_id: variant.id, quantity: 1 }] } }));
show('EXCHANGE', ex.data);

show('WASTAGE POST', (await call('/api/inventory/wastage', { method: 'POST', body: { variantId: variant.id, quantity: 2, reason: 'damage' } })).data);
show('WASTAGE GET', (await call('/api/inventory/wastage')).data);
show('COSTS', (await call('/api/costs', { method: 'POST', body: { amount: 100, spent_on: '2026-02-01', description: 'Rent' } })));
show('COSTS SUMMARY', (await call('/api/costs/summary')).data);
show('DASHBOARD', (await call('/api/dashboard')).data);
show('INV SUMMARY', (await call('/api/inventory/summary')).data);
show('PROD SUMMARY', (await call('/api/products/summary')).data);
const rep = (await call('/api/reports/inventory_valuation')).data;
show('VALUATION SUMMARY', rep.summary || rep);
show('BALANCE', (await call(`/api/purchases/${po.id}/balance`)).data);
show('TRASH POST', (await call('/api/trash', { method: 'POST', body: { entityType: 'product', entityId: product.id, reason: 'x' } })).data);
show('PRODUCT AFTER TRASH', (await call(`/api/products/${product.id}`)));
show('TRASH LIST', (await call('/api/trash')).data);

await new Promise((r) => server.close(r));
await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
