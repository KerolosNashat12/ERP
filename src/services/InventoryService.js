/**
 * Inventory use-cases.
 *
 * `postMovement` is the ONLY way stock changes anywhere in the system —
 * purchases, sales, returns and counts all funnel through it. That single entry
 * point is what guarantees the ledger and the balances agree, and that every
 * movement is attributable to a user and a source document.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { movingAverageCost, round2, round3 } from '../shared/money.js';
import auditService from './AuditService.js';

const INBOUND = new Set(['purchase_receipt', 'sale_return', 'opening_balance']);

export class InventoryService {
  constructor(deps = {}) {
    this.inventory = deps.inventory || repositories.inventory;
    this.variants = deps.variants || repositories.variants;
    this.warehouses = deps.warehouses || repositories.warehouses;
    this.adjustments = deps.adjustments || repositories.adjustments;
    this.sequences = deps.sequences || repositories.sequences;
    this.settings = deps.settings || repositories.settings;
    this.audit = deps.audit || auditService;
  }

  /**
   * Apply one stock change and write its ledger row.
   * @param {object} p
   * @param {number} p.quantity signed quantity (+ receipt, - issue)
   * @returns {Promise<{balance:number, averageCost:number, movementId:number}>}
   */
  async postMovement({
    variantId, warehouseId, movementType, quantity, unitCost = null,
    referenceType = null, referenceId = null, referenceNo = null, notes = null,
    actorId = null, allowNegative = null,
  }) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty === 0) throw new ValidationError('Movement quantity must be non-zero');

    const variant = await this.variants.findById(variantId);
    if (!variant) throw new NotFoundError('Variant', variantId);
    await this.warehouses.requireById(warehouseId, 'warehouse');

    const level = await this.inventory.ensureLevel(variantId, warehouseId);
    const currentQty = Number(level.quantity || 0);
    const currentAvg = Number(level.average_cost || variant.cost_price || 0);
    const newQty = round3(currentQty + qty);

    const negativeAllowed = allowNegative ?? Boolean(await this.settings.get('inventory.allow_negative_stock', false));
    if (newQty < 0 && !negativeAllowed) {
      throw new BusinessRuleError(
        `Insufficient stock for ${variant.sku}: on hand ${currentQty}, requested ${Math.abs(qty)}`,
        { sku: variant.sku, available: currentQty, requested: Math.abs(qty) },
      );
    }

    const cost = unitCost === null || unitCost === undefined ? currentAvg : Number(unitCost);
    const newAvg = INBOUND.has(movementType) && qty > 0
      ? movingAverageCost(currentQty, currentAvg, qty, cost)
      : currentAvg;

    await this.inventory.setLevel(variantId, warehouseId, { quantity: newQty, averageCost: newAvg });
    const movementId = await this.inventory.recordMovement({
      variant_id: variantId,
      warehouse_id: warehouseId,
      movement_type: movementType,
      quantity: qty,
      unit_cost: round3(cost),
      balance_after: newQty,
      reference_type: referenceType,
      reference_id: referenceId,
      reference_no: referenceNo,
      notes,
      created_by: actorId,
    });

    return { balance: newQty, averageCost: newAvg, movementId };
  }

  /**
   * The business trades from one location, so nothing above this layer needs to
   * know about warehouses. Everything resolves through here.
   */
  async locationId() {
    const location = await this.warehouses.getDefault();
    if (!location) throw new NotFoundError('Shop location');
    return location.id;
  }

  /** A default parameter cannot await, so the location is resolved in the body. */
  async availableQuantity(variantId, warehouseId = null) {
    const level = await this.inventory.getLevel(variantId, warehouseId || (await this.locationId()));
    if (!level) return 0;
    return round3(Number(level.quantity) - Number(level.reserved_quantity));
  }

  async stockOnHand(query) {
    return this.inventory.stockOnHand(query || {});
  }

  async lowStock(warehouseId) {
    return this.inventory.lowStock(warehouseId || null);
  }

  async movements(query) {
    return this.inventory.movements(query || {});
  }

  /** Direct single-line correction — used from the stock grid. */
  async quickAdjust({ variantId, warehouseId, newQuantity, reason = 'correction', notes }, context = {}) {
    return transaction(async () => {
      const location = warehouseId || (await this.locationId());
      const level = await this.inventory.ensureLevel(variantId, location);
      const difference = round3(Number(newQuantity) - Number(level.quantity));
      if (difference === 0) return { changed: false };
      const variant = await this.variants.details(variantId);
      const result = await this.postMovement({
        variantId,
        warehouseId: location,
        movementType: 'adjustment',
        quantity: difference,
        unitCost: level.average_cost,
        referenceType: 'quick_adjustment',
        notes: notes || `Quick adjustment (${reason})`,
        actorId: context.actor?.id || null,
        allowNegative: false,
      });
      await this.audit.record({
        action: 'ADJUST', module: 'inventory', entityType: 'stock_level', entityId: variantId,
        entityLabel: variant?.sku,
        before: { quantity: level.quantity }, after: { quantity: result.balance, reason, notes },
        actor: context.actor, request: context.request,
      });
      return { changed: true, ...result };
    });
  }

  // ------------------------------------------------------------------ wastage

  /**
   * الهدر — a bottle knocked off the counter, a watch that stopped, a piece
   * that walked out of the door.
   *
   * ── Why it is an adjustment and not a table of its own ───────────────────
   * Because it IS one. A stock adjustment already carries a warehouse, a
   * reason — `damage`, `loss`, `theft`, `expiry` — lines with a quantity and a
   * unit cost, a posted-at, an actor and an audit trail, and posting one moves
   * the stock through the same `postMovement` every other document uses. A
   * second table would be a second way to take stock off a shelf, and the day
   * the two disagreed the shop would have no way of knowing which was right.
   *
   * What was missing was never the record. It was that the MONEY went nowhere:
   * the stock level moved and the loss then appeared in no tile, no report and
   * no profit figure ever again. That is fixed in the reports; this is the door
   * the shop records it through, in one step instead of five.
   *
   * ── Cost, not price ─────────────────────────────────────────────────────
   * Valued at the shop's own moving average cost for that shelf. What the piece
   * WOULD have sold for is not a loss — it was never money — and counting it
   * would turn every broken bottle into a fictional catastrophe.
   */
  async recordWastage({
    variantId, warehouseId, quantity, reason, notes,
  }, context = {}) {
    const WASTE_REASONS = ['damage', 'loss', 'theft', 'expiry'];
    if (!WASTE_REASONS.includes(reason)) {
      throw new ValidationError(`"${reason}" is not a kind of loss`);
    }
    const lost = round3(Number(quantity));
    if (!Number.isFinite(lost) || lost <= 0) {
      throw new ValidationError('How many were lost?');
    }

    return transaction(async () => {
      const location = warehouseId || (await this.locationId());
      const level = await this.inventory.ensureLevel(variantId, location);
      const onHand = Number(level.quantity || 0);
      if (lost > onHand) {
        // Refused rather than allowed negative: a shop that has lost more than
        // it had has counted something wrong, and writing the shelf negative
        // hides that instead of surfacing it.
        throw new BusinessRuleError(
          `There are ${onHand} on the shelf; ${lost} cannot be written off.`,
        );
      }

      const adjustment = await this.adjustments.create({
        adjustment_no: await this.sequences.next('stock_adjustment'),
        warehouse_id: location,
        reason,
        status: 'draft',
        notes: notes || null,
        created_by: context.actor?.id || null,
      });
      await this.adjustments.replaceLines(adjustment.id, [{
        variant_id: variantId,
        system_qty: onHand,
        counted_qty: round3(onHand - lost),
        difference: round3(-lost),
        unit_cost: Number(level.average_cost || 0),
        notes: notes || null,
      }]);

      // Drafted and posted in one act, inside one transaction: a loss recorded
      // but not posted is a shelf the system still believes is full.
      await this.postAdjustment(adjustment.id, context);
      return this.getAdjustment(adjustment.id);
    });
  }

  /** The loss, in money and by cause, over a window. */
  async wastageSummary({ dateFrom, dateTo, warehouseId } = {}) {
    const window = { dateFrom, dateTo, warehouseId: warehouseId || null };
    /*
     * `this.adjustments`, not `this.inventory`: a loss is a property of the
     * ADJUSTMENT documents, and that is the repository the queries live in.
     * This read `this.inventory` at first and the page answered 500 — the money
     * behind it had tests, the door onto it did not. There is one now.
     */
    const [totals, byReason] = await Promise.all([
      this.adjustments.wastageTotals(window),
      this.adjustments.wastageByReason(window),
    ]);
    return {
      value: round2(totals.value),
      units: round3(totals.units),
      documents: totals.documents,
      byReason: byReason.map((row) => ({ ...row, value: round2(row.value) })),
    };
  }

  /** The documents behind that figure, newest first. */
  async wastageList(query = {}) {
    return this.adjustments.wastageDocuments(query);
  }

  // -------------------------------------------------------------- adjustments

  async listAdjustments(query) {
    return this.adjustments.listDetailed(query || {});
  }

  async getAdjustment(id) {
    const adjustment = await this.adjustments.findAggregate(id);
    if (!adjustment) throw new NotFoundError('Adjustment', id);
    return adjustment;
  }

  /** Build a stock-count sheet pre-filled with system quantities. */
  async buildCountSheet({ warehouseId, brandId, categoryId, search } = {}) {
    const { rows } = await this.inventory.stockOnHand({
      warehouseId: warehouseId || (await this.locationId()), brandId, categoryId, search, pageSize: 1000,
    });
    return rows.map((row) => ({
      variant_id: row.variant_id,
      sku: row.sku,
      product_name_en: row.product_name_en,
      product_name_ar: row.product_name_ar,
      variant_label: row.variant_label,
      system_qty: row.quantity,
      counted_qty: row.quantity,
      difference: 0,
      unit_cost: row.average_cost,
    }));
  }

  async saveAdjustment(payload, context = {}, adjustmentId = null) {
    return transaction(async () => {
      const lines = (payload.lines || []).map((l) => ({
        variant_id: l.variant_id,
        system_qty: Number(l.system_qty || 0),
        counted_qty: Number(l.counted_qty || 0),
        difference: round3(Number(l.counted_qty || 0) - Number(l.system_qty || 0)),
        unit_cost: Number(l.unit_cost || 0),
        notes: l.notes || null,
      }));
      if (!lines.length) throw new ValidationError('Add at least one line');

      let adjustment;
      if (adjustmentId) {
        const existing = await this.adjustments.requireById(adjustmentId, 'adjustment');
        if (existing.status !== 'draft') throw new BusinessRuleError('Only draft adjustments can be edited');
        adjustment = await this.adjustments.update(adjustmentId, {
          warehouse_id: payload.warehouse_id || (await this.locationId()),
          reason: payload.reason,
          notes: payload.notes || null,
        });
      } else {
        adjustment = await this.adjustments.create({
          adjustment_no: await this.sequences.next('stock_adjustment'),
          warehouse_id: payload.warehouse_id || (await this.locationId()),
          reason: payload.reason || 'stock_take',
          status: 'draft',
          notes: payload.notes || null,
          created_by: context.actor?.id || null,
        });
      }
      await this.adjustments.replaceLines(adjustment.id, lines);
      await this.audit.record({
        action: adjustmentId ? 'UPDATE' : 'CREATE', module: 'inventory',
        entityType: 'stock_adjustment', entityId: adjustment.id,
        entityLabel: adjustment.adjustment_no, after: { lines: lines.length, reason: adjustment.reason },
        actor: context.actor, request: context.request,
      });
      return this.getAdjustment(adjustment.id);
    });
  }

  async postAdjustment(id, context = {}) {
    return transaction(async () => {
      const adjustment = await this.adjustments.findAggregate(id);
      if (!adjustment) throw new NotFoundError('Adjustment', id);
      if (adjustment.status !== 'draft') throw new BusinessRuleError('This adjustment is already posted');

      let valueImpact = 0;
      for (const line of adjustment.lines) {
        if (!line.difference) continue;
        // Sequential: each movement's balance_after builds on the previous one.
        await this.postMovement({
          variantId: line.variant_id,
          warehouseId: adjustment.warehouse_id,
          movementType: 'adjustment',
          quantity: line.difference,
          unitCost: line.unit_cost,
          referenceType: 'stock_adjustment',
          referenceId: adjustment.id,
          referenceNo: adjustment.adjustment_no,
          notes: adjustment.reason,
          actorId: context.actor?.id || null,
          allowNegative: false,
        });
        valueImpact += line.difference * Number(line.unit_cost || 0);
      }

      const updated = await this.adjustments.update(id, {
        status: 'posted',
        posted_by: context.actor?.id || null,
        posted_at: new Date().toISOString(),
      });
      await this.audit.record({
        action: 'POST', module: 'inventory', entityType: 'stock_adjustment', entityId: id,
        entityLabel: adjustment.adjustment_no,
        after: { reason: adjustment.reason, lines: adjustment.lines.length, value_impact: round2(valueImpact) },
        actor: context.actor, request: context.request,
      });
      return updated;
    });
  }
}

export const inventoryService = new InventoryService();
export default inventoryService;
