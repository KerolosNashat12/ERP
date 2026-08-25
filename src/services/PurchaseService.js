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
import attachmentService from './AttachmentService.js';

/**
 * A supplier payment can carry a photograph of the receipt.
 *
 * Declared here rather than inside AttachmentService because this module owns
 * the rows: the generic mechanism has no idea what a purchase payment is and
 * must not learn. A cost and a salary payment register themselves the same way
 * from their own services — see the contract at the top of AttachmentService.js.
 *
 * Looking at the proof is looking at the order (`purchases.view`); adding or
 * removing one is the same right as recording the payment it proves.
 */
attachmentService.registerOwner('purchase_payment', {
  module: 'purchases',
  view: 'purchases.view',
  attach: 'purchases.pay',
  exists: async (id) => Boolean(
    await repositories.purchaseOrders.db
      .prepare('SELECT id FROM purchase_payments WHERE id = ?').get(Number(id)),
  ),
  label: async (id) => {
    const row = await repositories.purchaseOrders.db.prepare(`
      SELECT po.po_number, p.amount FROM purchase_payments p
      JOIN purchase_orders po ON po.id = p.purchase_order_id
      WHERE p.id = ?
    `).get(Number(id));
    return row ? `${row.po_number} — payment ${id} (${row.amount})` : `purchase payment ${id}`;
  },
});

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

  /**
   * The header discount is a RATE.
   *
   * A supplier says "five percent off", not "forty pounds off", so that is what
   * the form asks for and what is stored — and the money it comes to is worked
   * out here, from the subtotal, every time the order is saved. That is the
   * whole point of moving it: change a line and the discount follows, instead of
   * quietly still being the amount that was right before the line changed.
   *
   * `discount_amount` remains the money and remains authoritative for everything
   * downstream — totals, supplier statements, the printed order, every report.
   * None of them had to learn about this.
   *
   * An amount with no percent is still accepted, and it is what an order saved
   * before this existed carries. Those are left exactly as they were: their
   * total must not move because the shop updated.
   */
  #computeTotals(lines, { discountAmount = 0, discountPercent = null, shippingAmount = 0 }) {
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

    const percent = discountPercent === null || discountPercent === undefined
      ? null : Number(discountPercent);
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      throw new ValidationError('A purchase order discount must be between 0% and 100%');
    }

    const header = {
      subtotal: round2(subtotal),
      tax_amount: round2(taxTotal),
      discount_percent: percent === null ? 0 : round2(percent),
      discount_amount: percent === null
        ? round2(discountAmount)
        : round2(round2(subtotal) * (percent / 100)),
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
        // Absent means "this caller does not know about rates" — an older
        // client, a script, a queued order written before the change — and the
        // amount it sent is used unchanged.
        discountPercent: Object.hasOwn(payload, 'discount_percent')
          ? payload.discount_percent : null,
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

  /**
   * What the shop paid this supplier, as a row.
   *
   * One atomic act, and there is more than one thing in it: the payment, the
   * order's running total, and — when somebody photographed the receipt — the
   * photograph. All three happen inside one transaction, so a picture that will
   * not store takes the payment down with it rather than leaving a payment with
   * no proof, and a total that will not write takes both.
   *
   * The total is not incremented here. `recomputePaid` asks the database to sum
   * the rows as they stand and write that, in one statement, so two payments
   * recorded at the same moment cannot lose each other: whichever commits
   * second sums both. Reading `paid_amount`, adding to it and writing it back —
   * which is what this method used to do — loses one of them every time the two
   * overlap.
   *
   * The overpayment check runs AFTER the row is written, against the total the
   * database just computed. Checking before would let two concurrent payments
   * each pass a check that neither would pass together; checking after means
   * the loser throws, its transaction rolls back, and its row is gone.
   */
  async registerPayment(id, payload = {}, context = {}) {
    const {
      amount, method = 'cash', reference = null, note = null, paidOn = null, photo = null,
    } = payload;

    return transaction(async () => {
      const order = await this.orders.requireById(id, 'purchase order');
      if (order.status === 'cancelled') {
        throw new BusinessRuleError('A cancelled purchase order cannot take a payment');
      }
      const value = round2(Number(amount));
      if (!(value > 0)) throw new ValidationError('Payment amount must be greater than zero');

      const paymentId = await this.orders.insertPayment(order.id, {
        paid_on: paidOn || new Date().toISOString().slice(0, 10),
        amount: value,
        method: String(method || 'cash'),
        reference,
        note,
        created_by: context.actor?.id || null,
      });

      const paid = await this.orders.recomputePaid(order.id);
      if (paid > round2(order.total_amount) + 0.01) {
        throw new BusinessRuleError(
          `Payment exceeds the purchase order total: ${paid} paid against ${round2(order.total_amount)}`,
        );
      }

      if (photo?.dataUrl) {
        await attachmentService.attach('purchase_payment', paymentId, photo, context);
      }

      const payment = await this.orders.findPayment(order.id, paymentId);
      await this.audit.record({
        action: 'PAYMENT', module: 'purchases', entityType: 'purchase_payment', entityId: paymentId,
        entityLabel: `${order.po_number} — ${value}`,
        before: { paid_amount: order.paid_amount },
        after: { ...payment, paid_amount: paid, has_photo: Boolean(photo?.dataUrl) },
        actor: context.actor, request: context.request,
      });

      return { ...(await this.orders.findById(order.id)), payment };
    });
  }

  /** Every payment on an order, with the photographs attached to each. */
  async payments(id) {
    const order = await this.orders.requireById(id, 'purchase order');
    const rows = await this.orders.payments(order.id);
    // One query for every payment's photographs rather than one per payment:
    // a list of ten must not be eleven round trips to a hosted database.
    const byPayment = await attachmentService.listMany(
      'purchase_payment', rows.map((row) => row.id),
    );
    return {
      rows: rows.map((row) => ({ ...row, attachments: byPayment[row.id] || [] })),
      paid_amount: round2(Number(order.paid_amount)),
      total_amount: round2(Number(order.total_amount)),
      outstanding: round2(Number(order.total_amount) - Number(order.paid_amount)),
    };
  }

  /**
   * A payment that was wrong.
   *
   * It is REVERSED, never deleted, and that is a decision rather than an
   * omission. A shop owner who typed 15,000 instead of 1,500 has already told
   * the system something happened; deleting the row would leave the supplier
   * balance right and the history wrong, and the next person to ask "why did
   * this order say it was paid last Tuesday?" would find nothing at all. The
   * row stays, marked, with who reversed it and why — and the running total,
   * which counts recorded payments only, drops back on its own. The receipt
   * stays attached to it: it is proof of what was recorded, and a reversal does
   * not make the photograph untrue.
   *
   * The correction is then a new payment for the right amount, which is also
   * what the shop's paper trail would look like.
   */
  async reversePayment(id, paymentId, reason, context = {}) {
    return transaction(async () => {
      const order = await this.orders.requireById(id, 'purchase order');
      const payment = await this.orders.findPayment(order.id, paymentId);
      if (!payment) throw new NotFoundError('Purchase payment', paymentId);
      if (payment.status === 'reversed') {
        throw new BusinessRuleError('This payment has already been reversed');
      }
      const text = String(reason || '').trim();
      if (!text) throw new ValidationError('Say why this payment is being reversed');

      await this.orders.reversePayment(payment.id, { reason: text, actorId: context.actor?.id });
      const paid = await this.orders.recomputePaid(order.id);

      await this.audit.record({
        action: 'REVERSE_PAYMENT', module: 'purchases', entityType: 'purchase_payment',
        entityId: payment.id, entityLabel: `${order.po_number} — ${payment.amount}`,
        before: { status: payment.status, paid_amount: order.paid_amount },
        after: { status: 'reversed', reason: text, paid_amount: paid },
        actor: context.actor, request: context.request,
      });
      return { ...(await this.orders.findById(order.id)), reversed: payment.id };
    });
  }

  async remove(id, context = {}) {
    return transaction(async () => {
      const order = await this.orders.findAggregate(id);
      if (!order) throw new NotFoundError('Purchase order', id);
      if (order.status !== 'draft') throw new BusinessRuleError('Only draft purchase orders can be deleted');
      // A draft can still have taken a deposit. `purchase_payments` cascades
      // with the order, so deleting one here would take the money — and the
      // photograph of the receipt — out of the shop's history without a trace.
      if (await this.orders.countPayments(id)) {
        throw new BusinessRuleError(
          'Money has been recorded against this purchase order — reverse the payments first, or cancel the order instead of deleting it',
        );
      }
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
