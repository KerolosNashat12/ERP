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
   * @returns {{balance:number, averageCost:number, movementId:number}}
   */
  postMovement({
    variantId, warehouseId, movementType, quantity, unitCost = null,
    referenceType = null, referenceId = null, referenceNo = null, notes = null,
    actorId = null, allowNegative = null,
  }) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty === 0) throw new ValidationError('Movement quantity must be non-zero');

    const variant = this.variants.findById(variantId);
    if (!variant) throw new NotFoundError('Variant', variantId);
    this.warehouses.requireById(warehouseId, 'warehouse');

    const level = this.inventory.ensureLevel(variantId, warehouseId);
    const currentQty = Number(level.quantity || 0);
    const currentAvg = Number(level.average_cost || variant.cost_price || 0);
    const newQty = round3(currentQty + qty);

    const negativeAllowed = allowNegative ?? Boolean(this.settings.get('inventory.allow_negative_stock', false));
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

    this.inventory.setLevel(variantId, warehouseId, { quantity: newQty, averageCost: newAvg });
    const movementId = this.inventory.recordMovement({
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
  locationId() {
    const location = this.warehouses.getDefault();
    if (!location) throw new NotFoundError('Shop location');
    return location.id;
  }

  availableQuantity(variantId, warehouseId = this.locationId()) {
    const level = this.inventory.getLevel(variantId, warehouseId);
    if (!level) return 0;
    return round3(Number(level.quantity) - Number(level.reserved_quantity));
  }

  stockOnHand(query) {
    return this.inventory.stockOnHand(query || {});
  }

  lowStock(warehouseId) {
    return this.inventory.lowStock(warehouseId || null);
  }

  movements(query) {
    return this.inventory.movements(query || {});
  }

  /** Direct single-line correction — used from the stock grid. */
  quickAdjust({ variantId, warehouseId, newQuantity, reason = 'correction', notes }, context = {}) {
    return transaction(() => {
      const location = warehouseId || this.locationId();
      const level = this.inventory.ensureLevel(variantId, location);
      const difference = round3(Number(newQuantity) - Number(level.quantity));
      if (difference === 0) return { changed: false };
      const variant = this.variants.details(variantId);
      const result = this.postMovement({
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
      this.audit.record({
        action: 'ADJUST', module: 'inventory', entityType: 'stock_level', entityId: variantId,
        entityLabel: variant?.sku,
        before: { quantity: level.quantity }, after: { quantity: result.balance, reason, notes },
        actor: context.actor, request: context.request,
      });
      return { changed: true, ...result };
    });
  }

  // -------------------------------------------------------------- adjustments

  listAdjustments(query) {
    return this.adjustments.listDetailed(query || {});
  }

  getAdjustment(id) {
    const adjustment = this.adjustments.findAggregate(id);
    if (!adjustment) throw new NotFoundError('Adjustment', id);
    return adjustment;
  }

  /** Build a stock-count sheet pre-filled with system quantities. */
  buildCountSheet({ warehouseId, brandId, categoryId, search } = {}) {
    const { rows } = this.inventory.stockOnHand({
      warehouseId: warehouseId || this.locationId(), brandId, categoryId, search, pageSize: 1000,
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

  saveAdjustment(payload, context = {}, adjustmentId = null) {
    return transaction(() => {
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
        const existing = this.adjustments.requireById(adjustmentId, 'adjustment');
        if (existing.status !== 'draft') throw new BusinessRuleError('Only draft adjustments can be edited');
        adjustment = this.adjustments.update(adjustmentId, {
          warehouse_id: payload.warehouse_id || this.locationId(),
          reason: payload.reason,
          notes: payload.notes || null,
        });
      } else {
        adjustment = this.adjustments.create({
          adjustment_no: this.sequences.next('stock_adjustment'),
          warehouse_id: payload.warehouse_id || this.locationId(),
          reason: payload.reason || 'stock_take',
          status: 'draft',
          notes: payload.notes || null,
          created_by: context.actor?.id || null,
        });
      }
      this.adjustments.replaceLines(adjustment.id, lines);
      this.audit.record({
        action: adjustmentId ? 'UPDATE' : 'CREATE', module: 'inventory',
        entityType: 'stock_adjustment', entityId: adjustment.id,
        entityLabel: adjustment.adjustment_no, after: { lines: lines.length, reason: adjustment.reason },
        actor: context.actor, request: context.request,
      });
      return this.getAdjustment(adjustment.id);
    });
  }

  postAdjustment(id, context = {}) {
    return transaction(() => {
      const adjustment = this.adjustments.findAggregate(id);
      if (!adjustment) throw new NotFoundError('Adjustment', id);
      if (adjustment.status !== 'draft') throw new BusinessRuleError('This adjustment is already posted');

      let valueImpact = 0;
      for (const line of adjustment.lines) {
        if (!line.difference) continue;
        this.postMovement({
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

      const updated = this.adjustments.update(id, {
        status: 'posted',
        posted_by: context.actor?.id || null,
        posted_at: new Date().toISOString(),
      });
      this.audit.record({
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
