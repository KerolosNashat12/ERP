/**
 * سلة المهملات — what may be deleted, what may not, and what it costs.
 *
 * ── Why this file is long ────────────────────────────────────────────────────
 * Because the feature's whole value is in the refusals. A recycle bin that
 * deletes everything it is pointed at is not a safety net, it is a faster way
 * to lose a shop's books: an invoice hidden while its stock movement stays on
 * the shelf, a return erased while the customer keeps the refund, a product
 * destroyed out from under the sale it sits on. Every one of those is asserted
 * here as a refusal with a reason, not as a happy path.
 *
 * ── The shape of the thing being tested ─────────────────────────────────────
 * Three kinds, three different promises:
 *
 *   MASTER DATA (a brand, a customer) — hidden, never touched. Restoring is
 *   exact. Purging destroys it only if nothing points at it ON THE DAY, which
 *   is asked again thirty days later rather than assumed from the day it went
 *   in.
 *
 *   DOCUMENTS (an invoice, a return, a stock adjustment) — reversed first,
 *   through their own service, then hidden. The reversal is real and audited.
 *   RESTORING BRINGS BACK THE RECORD, NOT THE MONEY: a deleted invoice comes
 *   back VOID. That promise is asserted below, because the day it quietly stops
 *   being true is the day this system starts lying about money.
 *
 *   THE LEDGER (a cost) — destroyed rather than neutralised, and the profit for
 *   that month moves. Asserted against the report, not against the row.
 *
 * Everything runs against a real database through the real services.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'recycle-bin-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const {
  initDb, closeDb, getDb, transaction,
} = await import('../src/infrastructure/database/connection.js');
const { applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const trash = (await import('../src/services/trash/TrashService.js')).default;
const salesService = (await import('../src/services/SalesService.js')).default;
const returnService = (await import('../src/services/ReturnService.js')).default;
const inventoryService = (await import('../src/services/InventoryService.js')).default;
const costService = (await import('../src/services/CostService.js')).default;
const repositories = (await import('../src/infrastructure/repositories/index.js')).default;
const { round2 } = await import('../src/shared/money.js');

const actor = { id: 1, username: 'admin', fullName: 'Test' };
const context = { actor, permissions: ['sales.return_no_receipt'] };

let variantId = 0;
let warehouseId = 0;

before(async () => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  await transaction(async () => {
    const db = getDb();
    warehouseId = (await db.prepare('SELECT id FROM warehouses LIMIT 1').get()).id;
    await db.prepare(
      "INSERT INTO brands (id, code, name_en, name_ar) VALUES (900,'B900','Spare','احتياطي')",
    ).run();
    await db.prepare(
      "INSERT INTO products (id, sku_prefix, name_en, name_ar, brand_id) VALUES (900,'P900','Bottle','زجاجة',900)",
    ).run();
    const inserted = await db.prepare(`
      INSERT INTO product_variants (product_id, sku, barcode, variant_label, cost_price, selling_price)
      VALUES (900,'P900-A','P900-A','Default',40,100)
    `).run();
    variantId = Number(inserted.lastInsertRowid);
    await db.prepare(
      "INSERT INTO customers (id, code, name, phone) VALUES (900,'C900','Test customer','01000000000')",
    ).run();
  });

  // Stock to sell: 20 pieces at 40.
  await inventoryService.postMovement({
    variantId,
    warehouseId,
    movementType: 'purchase_receipt',
    quantity: 20,
    unitCost: 40,
    referenceType: 'seed',
    actorId: 1,
  });
});

after(async () => {
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** One completed invoice for one piece at 100. */
async function ringUpSale({ customerId = null } = {}) {
  return salesService.checkout({
    customer_id: customerId,
    warehouse_id: warehouseId,
    payment_method: 'cash',
    lines: [{ variant_id: variantId, quantity: 1, unit_price: 100 }],
    payments: [{ method: 'cash', amount: 100 }],
  }, context);
}

const onHand = async () => Number((await getDb().prepare(
  'SELECT quantity FROM stock_levels WHERE variant_id = ? AND warehouse_id = ?',
).get(variantId, warehouseId))?.quantity || 0);

const inBin = async (entityType, entityId) => Boolean(await getDb().prepare(
  "SELECT id FROM trash_items WHERE entity_type = ? AND entity_id = ? AND status = 'in_bin'",
).get(entityType, entityId));

// ===========================================================================

test('master data goes to the bin whole, and comes back whole', async (ctx) => {
  let entry;

  await ctx.test('the preview says what will happen before anything happens', async () => {
    const preview = await trash.preview('brand', 900);
    assert.equal(preview.ok, true);
    assert.equal(preview.label, 'احتياطي');
    // Referenced by the product — a warning, not a blocker: it can be hidden,
    // it just cannot ever be destroyed while that product exists.
    assert.ok(preview.warnings.some((w) => w.code === 'referenced'));
    assert.ok(preview.warnings[0].ar, 'the reason has to be readable in the shop');
    assert.equal(preview.retentionDays, 30);
  });

  await ctx.test('deleting it hides it from the list without touching the row', async () => {
    entry = await trash.remove('brand', 900, { reason: 'test', context });
    assert.equal(entry.status, 'in_bin');

    const row = await getDb().prepare('SELECT * FROM brands WHERE id = 900').get();
    assert.ok(row, 'the row itself must stay — the product points at it');

    const { rows } = await (await import('../src/infrastructure/repositories/index.js'))
      .default.brands.list({ pageSize: 200 });
    assert.ok(!rows.some((r) => r.id === 900), 'a deleted brand is still on the brands screen');
  });

  await ctx.test('it cannot be deleted twice', async () => {
    await assert.rejects(() => trash.remove('brand', 900, { context }), /already in the recycle bin/i);
  });

  await ctx.test('it cannot be destroyed while a product points at it', async () => {
    await assert.rejects(
      () => trash.purge(entry.id, { context, force: true }),
      /cannot be destroyed/i,
    );
    // And it is still in the bin rather than half-destroyed.
    assert.equal((await trash.get(entry.id)).status, 'in_bin');
  });

  await ctx.test('restoring puts it back on the screen exactly as it was', async () => {
    await trash.restore(entry.id, { context });
    const { rows } = await (await import('../src/infrastructure/repositories/index.js'))
      .default.brands.list({ pageSize: 200 });
    assert.ok(rows.some((r) => r.id === 900));
    assert.equal((await trash.get(entry.id)).status, 'restored');
  });

  await ctx.test('and a restored entry cannot be restored again', async () => {
    await assert.rejects(() => trash.restore(entry.id, { context }), /not in the recycle bin/i);
  });
});

test('an unreferenced record is destroyed, and only after its thirty days', async (ctx) => {
  await transaction(async () => {
    await getDb().prepare(
      "INSERT INTO brands (id, code, name_en, name_ar) VALUES (901,'B901','Unused','غير مستخدم')",
    ).run();
  });
  const entry = await trash.remove('brand', 901, { context });

  await ctx.test('too early is refused, with the date', async () => {
    await assert.rejects(() => trash.purge(entry.id, { context }), /may not be destroyed until/i);
  });

  await ctx.test('the sweep leaves it alone while its time has not come', async () => {
    const result = await trash.sweep({ context });
    assert.equal(result.due, 0, 'nothing is due yet');
    assert.equal((await trash.get(entry.id)).status, 'in_bin');
  });

  await ctx.test('once due, the sweep destroys it', async () => {
    // Wind its clock back rather than waiting a month.
    await getDb().prepare("UPDATE trash_items SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(entry.id);
    const result = await trash.sweep({ context });
    assert.equal(result.purged, 1);
    assert.equal((await trash.get(entry.id)).status, 'purged');
    assert.ok(!await getDb().prepare('SELECT id FROM brands WHERE id = 901').get(),
      'the record itself is gone, not merely hidden');
  });

  await ctx.test('and a purged entry can be neither restored nor purged again', async () => {
    await assert.rejects(() => trash.restore(entry.id, { context }), /not in the recycle bin/i);
    await assert.rejects(() => trash.purge(entry.id, { context, force: true }), /not in the recycle bin/i);
  });
});

test('an invoice is reversed before it is hidden, and comes back void', async (ctx) => {
  const before = await onHand();
  const sale = await ringUpSale();
  assert.equal(await onHand(), before - 1, 'the sale took a piece off the shelf');

  let entry;
  await ctx.test('the preview warns what it will cost, in both languages', async () => {
    const preview = await trash.preview('sale', sale.id);
    assert.equal(preview.ok, true);
    const warning = preview.warnings.find((w) => w.code === 'will_reverse');
    assert.ok(warning, 'nothing told the person the stock and money would move');
    assert.match(warning.en, /VOID/);
    assert.ok(warning.ar.includes('ملغاة'), 'the warning must say it in Arabic too');
  });

  await ctx.test('deleting it puts the piece back and voids the invoice', async () => {
    entry = await trash.remove('sale', sale.id, { reason: 'test invoice', context });
    assert.equal(await onHand(), before, 'the piece did not come back');
    const row = await getDb().prepare('SELECT status FROM sales WHERE id = ?').get(sale.id);
    assert.equal(row.status, 'void');
    assert.equal(entry.effect.voided, true);
    assert.equal(entry.effect.moneyReversed, 100);
  });

  await ctx.test('and it is out of the shop\'s takings', async () => {
    const totals = await (await import('../src/infrastructure/repositories/index.js'))
      .default.sales.salesTotals({});
    assert.ok(!Number.isNaN(totals.revenue));
    // The void is what removes it: `salesTotals` counts completed sales only.
    const still = await getDb().prepare(
      "SELECT COUNT(*) AS n FROM sales WHERE id = ? AND status = 'completed'",
    ).get(sale.id);
    assert.equal(still.n, 0);
  });

  await ctx.test('restoring brings back the RECORD, not the money', async () => {
    const restored = await trash.restore(entry.id, { context });
    assert.equal(restored.result.state, 'void',
      'a restored invoice must come back void — anything else rewrites the shop\'s history');
    const row = await getDb().prepare('SELECT status FROM sales WHERE id = ?').get(sale.id);
    assert.equal(row.status, 'void');
    assert.equal(await onHand(), before, 'restoring must not re-issue the stock');
  });

  await ctx.test('an invoice is never destroyed, however long it waits', async () => {
    const again = await trash.remove('sale', sale.id, { context });
    await getDb().prepare("UPDATE trash_items SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(again.id);
    await assert.rejects(() => trash.purge(again.id, { context }), /never destroyed/i);
    // The sweep does not lose it either: it stays, with its reason.
    const swept = await trash.sweep({ context });
    assert.equal(swept.purged, 0);
    assert.equal(swept.kept.length, 1);
    assert.match(swept.kept[0].reason, /never destroyed/i);
  });
});

test('an invoice with a return against it refuses, until the return goes first', async (ctx) => {
  const sale = await ringUpSale({ customerId: 900 });
  const line = (await salesService.get(sale.id)).lines[0];
  const refund = await returnService.create({
    return_type: 'with_receipt',
    sale_id: sale.id,
    reason_code: 'defective',
    refund_method: 'cash',
    lines: [{ sale_line_id: line.id, quantity: 1, condition: 'damaged' }],
  }, context);

  await ctx.test('the invoice refuses, and names the reason', async () => {
    const preview = await trash.preview('sale', sale.id);
    assert.equal(preview.ok, false);
    assert.equal(preview.blockers[0].code, 'has_returns');
    // And the refusal is enforced, not merely displayed.
    await assert.rejects(() => trash.remove('sale', sale.id, { context }), /return/i);
  });

  await ctx.test('the return can be deleted, and its reversal is exact', async () => {
    const shelf = await onHand();
    const entry = await trash.remove('sales_return', refund.id, { reason: 'test', context });
    assert.equal(entry.effect.reversed, true);
    // It was returned DAMAGED: received, then written off. Reversing un-writes
    // it off and takes it back out, so the shelf ends where it started.
    assert.equal(await onHand(), shelf, 'the shelf moved when it should not have');
    const row = await getDb().prepare('SELECT status FROM sales_returns WHERE id = ?').get(refund.id);
    assert.equal(row.status, 'reversed');

    /*
     * And the money follows the row. `returnsTotals` is what the home screen's
     * "revenue" tile subtracts and what the profit report calls refunds; a
     * refund that was undone must stop appearing there, or the shop's takings
     * are reported short by an amount nobody ever handed over.
     */
    const totals = await repositories.salesReturns.returnsTotals({});
    assert.equal(totals.refunds, 0, 'an undone refund is not a refund');
    assert.equal(totals.return_count, 0);
  });

  await ctx.test('cash refunds are reported, never silently un-refunded', async () => {
    const entry = (await trash.list({ status: 'in_bin' })).rows
      .find((r) => r.entityType === 'sales_return');
    assert.equal(entry.effect.money.method, 'cash');
    assert.equal(entry.effect.money.undone, false,
      'a computer cannot put cash back in a drawer and must not pretend it did');
    assert.match(entry.effect.money.note, /till/i);
  });

  await ctx.test('a reversed return cannot be restored', async () => {
    const entry = (await trash.list({ status: 'in_bin' })).rows
      .find((r) => r.entityType === 'sales_return');
    await assert.rejects(() => trash.restore(entry.id, { context }), /cannot be restored/i);
  });

  await ctx.test('and now the invoice will go', async () => {
    const preview = await trash.preview('sale', sale.id);
    assert.equal(preview.ok, true, 'the return is gone, so nothing blocks the invoice any more');
    const entry = await trash.remove('sale', sale.id, { context });
    assert.equal(entry.effect.voided, true);
  });
});

test('a wastage document can be undone, and the loss comes off the figure', async (ctx) => {
  const shelf = await onHand();
  const loss = await inventoryService.recordWastage({
    variantId, quantity: 2, reason: 'damage', notes: 'test',
  }, context);
  assert.equal(await onHand(), shelf - 2);

  const window = { dateFrom: '2000-01-01', dateTo: '2100-01-01' };
  const beforeValue = (await inventoryService.wastageSummary(window)).value;
  assert.ok(beforeValue > 0, 'the loss is not in the figure to begin with');

  await ctx.test('deleting it puts the pieces back', async () => {
    const entry = await trash.remove('stock_adjustment', loss.id, { context });
    assert.equal(entry.effect.reversed, true);
    assert.equal(await onHand(), shelf, 'the pieces did not come back');
  });

  await ctx.test('and takes the loss off the wastage figure exactly', async () => {
    const after = (await inventoryService.wastageSummary(window)).value;
    assert.equal(after, 0,
      'the wastage figure still counts a document that was undone');
  });

  await ctx.test('a draft is destroyed outright — it never moved anything', async () => {
    const draft = await inventoryService.saveAdjustment({
      reason: 'damage',
      lines: [{
        variant_id: variantId, system_qty: 5, counted_qty: 4, unit_cost: 40,
      }],
    }, context);
    const entry = await trash.remove('stock_adjustment', draft.id, { context });
    assert.equal(entry.effect.wasDraft, true);
    await getDb().prepare("UPDATE trash_items SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(entry.id);
    await trash.purge(entry.id, { context });
    assert.ok(
      !await getDb().prepare('SELECT id FROM stock_adjustments WHERE id = ?').get(draft.id),
      'a draft leaves nothing behind',
    );
  });
});

/**
 * A cost is the third kind: the LEDGER.
 *
 * There is no stock to put back and no customer to refund — a cost is the
 * record of money that left the till. So the bin does not neutralise it, it
 * takes it OUT of the ledger, and the delete dialog says so in advance: this
 * month's costs go down by exactly this much and its profit goes up by the
 * same. That promise is the thing worth testing, and it is tested where the
 * owner would notice it broken — in the total the costs page shows him, not in
 * the row it came from.
 */
test('a cost leaves the ledger while it is in the bin, and comes back to it', async (ctx) => {
  const db = getDb();
  const categoryId = (await db.prepare('SELECT id FROM cost_categories LIMIT 1').get()).id;
  const created = await costService.create({
    category_id: categoryId,
    amount: 750,
    spent_on: '2026-08-10',
    description: 'Recycle bin test — one month of electricity',
  }, context);

  const spent = async () => (await repositories.costs.total({
    dateFrom: '2026-08-01', dateTo: '2026-08-31',
  })).amount;

  const before = await spent();
  assert.ok(before >= 750, 'the cost is in the ledger to begin with');

  let entry;
  await ctx.test('the dialog says what it will do to the profit, before it does it', async () => {
    const preview = await trash.preview('cost', created.id);
    assert.equal(preview.ok, true);
    const warning = preview.warnings.find((w) => w.code === 'affects_profit');
    assert.ok(warning, 'deleting a cost moves a month\'s profit and must say so');
    assert.match(warning.en, /750/);
    assert.match(warning.ar, /750/);
  });

  await ctx.test('and the month\'s costs really do fall by exactly that much', async () => {
    entry = await trash.remove('cost', created.id, { reason: 'entered twice', context });
    assert.equal(await spent(), round2(before - 750),
      'the promise on the dialog and the figure on the page are the same promise');
    assert.equal(await inBin('cost', created.id), true);
  });

  await ctx.test('restoring puts it back, to the piastre', async () => {
    await trash.restore(entry.id, { context });
    assert.equal(await spent(), before);
  });

  await ctx.test('purging destroys the row itself', async () => {
    const again = await trash.remove('cost', created.id, { context });
    await getDb().prepare("UPDATE trash_items SET purge_after = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(again.id);
    await trash.purge(again.id, { context });
    assert.ok(!await getDb().prepare('SELECT id FROM costs WHERE id = ?').get(created.id),
      'a cost is destroyed rather than neutralised — there is nothing to neutralise');
    assert.equal(await spent(), round2(before - 750));
  });
});

test('the bin refuses what it does not know, and says what it does', async (ctx) => {
  await ctx.test('an unknown kind of thing', async () => {
    await assert.rejects(() => trash.preview('spaceship', 1), /cannot be deleted/i);
  });

  await ctx.test('a thing that is not there', async () => {
    await assert.rejects(() => trash.preview('brand', 99999), /not found/i);
  });

  await ctx.test('and it can list what it does know', async () => {
    const kinds = (await trash.kinds()).map((k) => k.entityType);
    for (const expected of ['product', 'brand', 'customer', 'sale', 'sales_return', 'cost']) {
      assert.ok(kinds.includes(expected), `${expected} is not deletable from the bin`);
    }
  });
});

test('the register answers the questions a person actually asks', async (ctx) => {
  await ctx.test('how full is it, and what is about to go', async () => {
    const summary = await trash.summary();
    assert.ok(summary.inBin > 0);
    assert.equal(summary.retentionDays, 30);
    assert.ok(Array.isArray(summary.byModule));
  });

  await ctx.test('who deleted this, and why', async () => {
    const { rows } = await trash.list({ status: 'in_bin' });
    const withReason = rows.find((row) => row.reason);
    assert.ok(withReason, 'no entry kept the reason it was deleted for');
    assert.equal(withReason.deletedBy, 1);
    assert.ok(withReason.deletedAt);
    assert.ok(withReason.purgeAfter > withReason.deletedAt);
  });

  await ctx.test('and what was destroyed, long after the record itself is gone', async () => {
    const { rows } = await trash.list({ status: 'purged' });
    assert.ok(rows.length > 0);
    // The snapshot is what lets the register still say what the thing WAS.
    assert.ok(rows[0].label, 'a purged entry with no name is a register that forgot');
  });
});
