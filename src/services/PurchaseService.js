/**
 * Purchasing use-cases: draft -> ordered -> (partially) received.
 * Receiving is the only path that touches stock, and it does so through
 * InventoryService.postMovement so goods-in updates the moving average cost.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { calculateLine, round2, round3 } from '../shared/money.js';
import inventoryService from './InventoryService.js';
import auditService from './AuditService.js';

export class PurchaseService {
  constructor(deps = {}) {
    this.orders = deps.orders || repositories.purchaseOrders;
    this.suppliers = deps.suppliers || repositories.suppliers;
    this.variants = deps.variants || repositories.variants;
    this.sequences = deps.sequences || repositories.sequences;
    this.inventory = deps.inventory || inventoryService;
    this.audit = deps.audit || auditService;
  }

  async list(query) {
    return this.orders.listDetailed(query || {});
  }

  async get(id) {
    const order = await this.orders.findAggregate(id);
    if (!order) throw new NotFoundError('Purchase order', id);
    return order;
  }

  #computeTotals(lines, { discountAmount = 0, shippingAmount = 0 }) {
    let subtotal = 0;
    let taxTotal = 0;
    const computed = lines.map((line) => {
      const result = calculateLine({
        quantity: line.quantity_ordered,
        unitPrice: line.unit_cost,
        discountPercent: line.discount_percent || 0,
        taxRate: line.tax_rate || 0,
      });
      subtotal += result.netAmount;
      taxTotal += result.taxAmount;
      return { ...line, line_total: result.lineTotal };
    });
    const header = {
      subtotal: round2(subtotal),
      tax_amount: round2(taxTotal),
      discount_amount: round2(discountAmount),
      shipping_amount: round2(shippingAmount),
    };
    header.total_amount = round2(
      header.subtotal + header.tax_amount + header.shipping_amount - header.discount_amount,
    );
    return { lines: computed, header };
  }

  async save(payload, context = {}, orderId = null) {
    return transaction(async () => {
      await this.suppliers.requireById(payload.supplier_id, 'supplier');
      const rawLines = (payload.lines || []).filter((l) => Number(l.quantity_ordered) > 0);
      if (!rawLines.length) throw new ValidationError('A purchase order needs at least one line');

      let existing = null;
      if (orderId) {
        existing = await this.orders.requireById(orderId, 'purchase order');
        if (!['draft', 'ordered'].includes(existing.status)) {
          throw new BusinessRuleError('Only draft or ordered purchase orders can be edited');
        }
      }

      const { lines, header } = this.#computeTotals(rawLines, {
        discountAmount: payload.discount_amount,
        shippingAmount: payload.shipping_amount,
      });

      const data = {
        supplier_id: payload.supplier_id,
        // One shop location — resolved here so callers never have to know.
        warehouse_id: payload.warehouse_id || (await this.inventory.locationId()),
        status: payload.status || existing?.status || 'draft',
        order_date: payload.order_date || new Date().toISOString().slice(0, 10),
        expected_date: payload.expected_date || null,
        notes: payload.notes || null,
        ...header,
      };

      let order;
      if (orderId) {
        order = await this.orders.update(orderId, data);
      } else {
        order = await this.orders.create({
          ...data,
          po_number: await this.sequences.next('purchase_order'),
          created_by: context.actor?.id || null,
        });
      }

      // Preserve already-received quantities when a PO is edited.
      const previous = orderId ? await this.orders.lines(orderId) : [];
      const merged = lines.map((line) => {
        const match = previous.find((p) => p.variant_id === line.variant_id);
        return { ...line, quantity_received: match ? match.quantity_received : 0 };
      });
      await this.orders.replaceLines(order.id, merged);

      await this.audit.record({
        action: orderId ? 'UPDATE' : 'CREATE', module: 'purchases', entityType: 'purchase_order',
        entityId: order.id, entityLabel: order.po_number,
        before: existing, after: { ...order, lines: merged.length },
        actor: context.actor, request: context.request,
      });
      return this.get(order.id);
    });
  }

  async approve(id, context = {}) {
    return transaction(async () => {
      const order = await this.orders.requireById(id, 'purchase order');
      if (order.status !== 'draft') throw new BusinessRuleError('Only draft orders can be sent to the supplier');
      const updated = await this.orders.update(id, {
        status: 'ordered',
        approved_by: context.actor?.id || null,
        approved_at: new Date().toISOString(),
      });
      await this.audit.record({
        action: 'APPROVE', module: 'purchases', entityType: 'purchase_order', entityId: id,
        entityLabel: order.po_number, before: { status: order.status }, after: { status: 'ordered' },
        actor: context.actor, request: context.request,
      });
      return updated;
    });
  }

  /**
   * Receive goods against a PO.
   * @param {Array<{line_id:number, quantity:number}>} receipts
   */
  async receive(id, { receipts = [], notes } = {}, context = {}) {
    return transaction(async () => {
      const order = await this.orders.findAggregate(id);
      if (!order) throw new NotFoundError('Purchase order', id);
      if (['cancelled', 'received'].includes(order.status)) {
        throw new BusinessRuleError(`Purchase order is ${order.status} and cannot receive stock`);
      }

      const toReceive = receipts.filter((r) => Number(r.quantity) > 0);
      if (!toReceive.length) throw new ValidationError('Enter at least one quantity to receive');

      for (const receipt of toReceive) {
        const line = order.lines.find((l) => l.id === Number(receipt.line_id));
        if (!line) throw new NotFoundError('Purchase order line', receipt.line_id);
        const quantity = round3(Number(receipt.quantity));
        const outstanding = round3(line.quantity_ordered - line.quantity_received);
        if (quantity > outstanding) {
          throw new BusinessRuleError(
            `Cannot receive ${quantity} of ${line.sku}: only ${outstanding} outstanding`,
          );
        }
        // One receipt at a time: postMovement reads the balance it just wrote.
        await this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: order.warehouse_id,
          movementType: 'purchase_receipt',
          quantity,
          unitCost: line.unit_cost,
          referenceType: 'purchase_order',
          referenceId: order.id,
          referenceNo: order.po_number,
          notes: notes || null,
          actorId: context.actor?.id || null,
        });
        await this.orders.updateLineReceived(line.id, round3(line.quantity_received + quantity));
        // Keep the variant's standard cost aligned with the latest purchase price.
        await this.variants.update(line.variant_id, { cost_price: round2(line.unit_cost) });
      }

      const refreshed = await this.orders.lines(id);
      const fullyReceived = refreshed.every((l) => l.quantity_received >= l.quantity_ordered);
      const anyReceived = refreshed.some((l) => l.quantity_received > 0);
      const status = fullyReceived ? 'received' : (anyReceived ? 'partially_received' : order.status);
      const updated = await this.orders.update(id, { status });

      await this.audit.record({
        action: 'RECEIVE', module: 'purchases', entityType: 'purchase_order', entityId: id,
        entityLabel: order.po_number,
        before: { status: order.status },
        after: { status, receipts: toReceive, notes: notes || null },
        actor: context.actor, request: context.request,
      });
      return { order: updated, status };
    });
  }

  async cancel(id, reason, context = {}) {
    return transaction(async () => {
      const order = await this.orders.findAggregate(id);
      if (!order) throw new NotFoundError('Purchase order', id);
      if (order.lines.some((l) => l.quantity_received > 0)) {
        throw new BusinessRuleError('Cannot cancel a purchase order that has received stock');
      }
      const updated = await this.orders.update(id, { status: 'cancelled', notes: reason || order.notes });
      await this.audit.record({
        action: 'CANCEL', module: 'purchases', entityType: 'purchase_order', entityId: id,
        entityLabel: order.po_number, before: { status: order.status },
        after: { status: 'cancelled', reason }, actor: context.actor, request: context.request,
      });
      return updated;
    });
  }

  async registerPayment(id, { amount, method = 'cash', reference }, context = {}) {
    return transaction(async () => {
      const order = await this.orders.requireById(id, 'purchase order');
      const value = round2(Number(amount));
      if (!(value > 0)) throw new ValidationError('Payment amount must be greater than zero');
      const paid = round2(Number(order.paid_amount) + value);
      if (paid > round2(order.total_amount) + 0.01) {
        throw new BusinessRuleError('Payment exceeds the purchase order total');
      }
      const updated = await this.orders.update(id, { paid_amount: paid });
      await this.audit.record({
        action: 'PAYMENT', module: 'purchases', entityType: 'purchase_order', entityId: id,
        entityLabel: order.po_number,
        before: { paid_amount: order.paid_amount },
        after: { paid_amount: paid, method, reference },
        actor: context.actor, request: context.request,
      });
      return updated;
    });
  }

  async remove(id, context = {}) {
    return transaction(async () => {
      const order = await this.orders.findAggregate(id);
      if (!order) throw new NotFoundError('Purchase order', id);
      if (order.status !== 'draft') throw new BusinessRuleError('Only draft purchase orders can be deleted');
      await this.orders.remove(id);
      await this.audit.record({
        action: 'DELETE', module: 'purchases', entityType: 'purchase_order', entityId: id,
        entityLabel: order.po_number, before: order, actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  /** Suggest a PO from items below their reorder level, grouped by supplier. */
  async suggestReorder(warehouseId) {
    const lowStock = await repositories.inventory.lowStock(warehouseId, 500);
    const bySupplier = new Map();
    for (const row of lowStock) {
      const key = row.supplier_id || 0;
      if (!bySupplier.has(key)) {
        bySupplier.set(key, { supplier_id: row.supplier_id, supplier_name: row.supplier_name_en || 'Unassigned', lines: [] });
      }
      const variant = await this.variants.findById(row.variant_id);
      const suggested = Math.max(
        Number(variant?.reorder_quantity || 0),
        round3(Number(row.reorder_level) - Number(row.quantity)),
        1,
      );
      bySupplier.get(key).lines.push({
        variant_id: row.variant_id,
        sku: row.sku,
        product_name_en: row.product_name_en,
        variant_label: row.variant_label,
        on_hand: row.quantity,
        reorder_level: row.reorder_level,
        quantity_ordered: suggested,
        unit_cost: row.cost_price,
      });
    }
    return [...bySupplier.values()];
  }
}

export const purchaseService = new PurchaseService();
export default purchaseService;
