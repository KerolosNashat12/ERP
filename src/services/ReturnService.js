/**
 * Sales returns.
 *
 * A return is not "a sale in reverse" — it has its own rules, and getting them
 * wrong is how shops quietly lose stock and money:
 *
 *  - The refund is the amount the customer ACTUALLY PAID per unit, net of every
 *    line discount and promotion allocated to that line. Refunding list price on
 *    a discounted item hands back more than was taken.
 *  - Items come back in a condition. A resellable item goes on the shelf; a
 *    damaged one is received and immediately written off, so the loss appears in
 *    the ledger and the reports instead of being silently absorbed.
 *  - Loyalty points earned on the returned value are taken back, or customers
 *    can farm points by buying and returning.
 *  - Without a receipt there is no proof of what was paid, so the refund is
 *    capped at the current price and issued as store credit only.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../shared/errors.js';
import { percentOf, round2, round3 } from '../shared/money.js';
import inventoryService from './InventoryService.js';
import promotionService from './PromotionService.js';
import auditService from './AuditService.js';

export const RETURN_REASONS = [
  { code: 'defective', en: 'Faulty / defective', ar: 'عيب مصنعي' },
  { code: 'wrong_item', en: 'Wrong item given', ar: 'صنف خاطئ' },
  { code: 'wrong_size', en: 'Wrong size', ar: 'مقاس غير مناسب' },
  { code: 'not_as_described', en: 'Not as described', ar: 'مخالف للوصف' },
  { code: 'changed_mind', en: 'Customer changed their mind', ar: 'العميل غيّر رأيه' },
  { code: 'damaged_in_transit', en: 'Damaged before sale', ar: 'تالف قبل البيع' },
  { code: 'duplicate', en: 'Duplicate purchase', ar: 'شراء مكرر' },
  { code: 'other', en: 'Other', ar: 'أخرى' },
];

/** Reasons that are the shop's fault never attract a restocking fee. */
const SHOP_FAULT = new Set(['defective', 'wrong_item', 'not_as_described', 'damaged_in_transit']);

export class ReturnService {
  constructor(deps = {}) {
    this.returns = deps.returns || repositories.salesReturns;
    this.sales = deps.sales || repositories.sales;
    this.customers = deps.customers || repositories.customers;
    this.variants = deps.variants || repositories.variants;
    this.sequences = deps.sequences || repositories.sequences;
    this.settings = deps.settings || repositories.settings;
    this.inventory = deps.inventory || inventoryService;
    this.promotions = deps.promotions || promotionService;
    this.audit = deps.audit || auditService;
  }

  /** Policy the UI needs before it can render the form sensibly. */
  async policy() {
    return {
      reasons: RETURN_REASONS,
      windowDays: Number(await this.settings.get('returns.window_days', 14)),
      allowWithoutReceipt: Boolean(await this.settings.get('returns.allow_without_receipt', true)),
      restockingFeePercent: Number(await this.settings.get('returns.restocking_fee_percent', 0)),
      requireReason: Boolean(await this.settings.get('returns.require_reason', true)),
      storeCreditValidityDays: Number(await this.settings.get('returns.store_credit_days', 90)),
    };
  }

  async list(query) {
    return this.returns.listDetailed(query || {});
  }

  async get(id) {
    const record = await this.returns.findAggregate(id);
    if (!record) throw new NotFoundError('Return', id);
    return record;
  }

  /**
   * Find the invoice a customer is returning against.
   * Accepts an invoice number, or the `INV:number` payload printed as a QR on
   * the receipt — so the cashier can just scan the receipt.
   */
  async lookupInvoice(reference) {
    const raw = String(reference || '').trim();
    if (!raw) throw new ValidationError('Enter or scan an invoice number');
    const invoiceNo = raw.toUpperCase().startsWith('INV:') ? raw.slice(4).trim() : raw;

    const header = await this.sales.findByInvoiceNo(invoiceNo);
    if (!header) throw new NotFoundError('Invoice', invoiceNo);
    const sale = await this.sales.findAggregate(header.id);

    if (sale.status === 'void') throw new BusinessRuleError('This invoice was voided — there is nothing to return');

    const { windowDays } = await this.policy();
    const ageDays = Math.floor((Date.now() - new Date(sale.sale_date).getTime()) / 86_400_000);
    const outsideWindow = windowDays > 0 && ageDays > windowDays;

    const lines = sale.lines.map((line) => {
      const returnable = round3(line.quantity - line.returned_quantity);
      // What one unit actually cost the customer, after every discount and tax.
      const grossPerUnit = round2(line.line_total / line.quantity);
      const taxPerUnit = round2(line.tax_amount / line.quantity);
      return {
        sale_line_id: line.id,
        variant_id: line.variant_id,
        sku: line.sku,
        description: line.description,
        product_name_en: line.product_name_en,
        product_name_ar: line.product_name_ar,
        variant_label: line.variant_label,
        sold_quantity: line.quantity,
        returned_quantity: line.returned_quantity,
        returnable_quantity: returnable,
        list_price: line.unit_price,
        refund_per_unit: grossPerUnit,
        net_per_unit: round2(grossPerUnit - taxPerUnit),
        tax_per_unit: taxPerUnit,
        unit_cost: line.unit_cost,
      };
    });

    return {
      sale: {
        id: sale.id,
        invoice_no: sale.invoice_no,
        sale_date: sale.sale_date,
        customer_id: sale.customer_id,
        customer_name: sale.customer_name,
        customer_phone: sale.customer_phone,
        total_amount: sale.total_amount,
        paid_amount: sale.paid_amount,
        payment_method: sale.payment_method,
        payment_status: sale.payment_status,
        promotion_code: sale.promotion_code,
        loyalty_earned: sale.loyalty_earned,
      },
      lines,
      ageDays,
      outsideWindow,
      windowDays,
      fullyReturned: lines.every((l) => l.returnable_quantity <= 0),
      priorReturns: sale.returns,
    };
  }

  /** Look an item up for a no-receipt return. */
  async lookupItem(code) {
    const variant = await this.variants.findByCode(String(code || '').trim());
    if (!variant) throw new NotFoundError('Item with code', code);
    return {
      variant_id: variant.variant_id,
      sku: variant.sku,
      product_name_en: variant.product_name_en,
      product_name_ar: variant.product_name_ar,
      variant_label: variant.variant_label,
      tax_rate: variant.tax_rate,
      unit_cost: variant.cost_price,
      // No receipt means no proof of what was paid: current price is the cap.
      refund_per_unit: round2(variant.selling_price),
    };
  }

  /**
   * Record a return.
   * @param {object} payload
   * @param {'with_receipt'|'no_receipt'} payload.return_type
   * @param {Array} payload.lines [{ sale_line_id?, variant_id?, quantity, condition }]
   */
  async create(payload, context = {}) {
    return transaction(async () => {
      const type = payload.return_type === 'no_receipt' ? 'no_receipt' : 'with_receipt';
      const policy = await this.policy();

      if (type === 'no_receipt') {
        if (!policy.allowWithoutReceipt) {
          throw new BusinessRuleError('Returns without a receipt are switched off in Settings');
        }
        if (!context.permissions?.includes('sales.return_no_receipt')) {
          throw new ForbiddenError('Returns without a receipt need a manager');
        }
      }

      const reasonCode = payload.reason_code || 'other';
      if (!RETURN_REASONS.some((r) => r.code === reasonCode)) {
        throw new ValidationError('Unknown return reason');
      }

      const prepared = type === 'with_receipt'
        ? await this.#prepareAgainstInvoice(payload, policy, context)
        : await this.#prepareWithoutReceipt(payload);

      const { sale, lines } = prepared;
      if (!lines.length) throw new ValidationError('Select at least one item to return');

      const subtotal = round2(lines.reduce((s, l) => s + (l.line_total - l.tax_amount), 0));
      const taxAmount = round2(lines.reduce((s, l) => s + l.tax_amount, 0));
      const grossRefund = round2(subtotal + taxAmount);

      // A restocking fee is only defensible when the customer simply changed
      // their mind — never when the shop sold something faulty or wrong.
      let restockingFee = round2(Math.max(Number(payload.restocking_fee || 0), 0));
      if (SHOP_FAULT.has(reasonCode)) restockingFee = 0;
      if (restockingFee > grossRefund) restockingFee = grossRefund;
      const refundTotal = round2(grossRefund - restockingFee);

      const refundMethod = type === 'no_receipt' ? 'store_credit' : (payload.refund_method || 'cash');
      if (refundMethod === 'account' && !sale?.customer_id) {
        throw new BusinessRuleError('Crediting the account needs a registered customer');
      }

      const record = await this.returns.create({
        return_no: await this.sequences.next('sales_return'),
        sale_id: sale?.id || null,
        invoice_no: sale?.invoice_no || null,
        customer_id: sale?.customer_id || payload.customer_id || null,
        warehouse_id: await this.inventory.locationId(),
        return_type: type,
        return_date: new Date().toISOString(),
        reason_code: reasonCode,
        reason_note: payload.reason_note || null,
        subtotal,
        tax_amount: taxAmount,
        total_amount: refundTotal,
        restocking_fee: restockingFee,
        refund_method: refundMethod,
        loyalty_reversed: 0,
        items_restocked: 0,
        items_written_off: 0,
        created_by: context.actor?.id || null,
      });

      await this.returns.insertLines(record.id, lines);

      // --- stock
      let restocked = 0;
      let writtenOff = 0;
      for (const line of lines) {
        // The goods physically come back either way — always receive them first,
        // so the ledger tells the true story. Sequential: the write-off below
        // needs the balance this movement leaves behind.
        await this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: record.warehouse_id,
          movementType: 'sale_return',
          quantity: Math.abs(line.quantity),
          unitCost: line.unit_cost,
          referenceType: 'sales_return',
          referenceId: record.id,
          referenceNo: record.return_no,
          notes: `Returned — ${reasonCode}`,
          actorId: context.actor?.id || null,
        });

        if (line.condition === 'damaged') {
          // ...then immediately scrap it, which is what makes the loss visible.
          await this.inventory.postMovement({
            variantId: line.variant_id,
            warehouseId: record.warehouse_id,
            movementType: 'write_off',
            quantity: -Math.abs(line.quantity),
            unitCost: line.unit_cost,
            referenceType: 'sales_return',
            referenceId: record.id,
            referenceNo: record.return_no,
            notes: 'Returned damaged — not resellable',
            actorId: context.actor?.id || null,
            allowNegative: true,
          });
          writtenOff = round3(writtenOff + line.quantity);
        } else {
          restocked = round3(restocked + line.quantity);
        }

        if (line.sale_line_id) await this.sales.incrementReturnedQty(line.sale_line_id, line.quantity);
      }

      // --- loyalty: take back the points earned on what was returned
      let loyaltyReversed = 0;
      if (sale?.customer_id && sale.loyalty_earned > 0 && sale.total_amount > 0) {
        loyaltyReversed = round2(sale.loyalty_earned * (grossRefund / sale.total_amount));
        const customer = await this.customers.findById(sale.customer_id);
        loyaltyReversed = Math.min(loyaltyReversed, Number(customer?.loyalty_points || 0));
        if (loyaltyReversed > 0) await this.customers.adjustLoyalty(sale.customer_id, -loyaltyReversed);
      }

      // --- money back
      let storeCreditCode = null;
      if (refundMethod === 'store_credit') {
        storeCreditCode = await this.#issueStoreCredit(refundTotal, record.return_no, policy, context);
      } else if (refundMethod === 'account') {
        // Reduce what the customer owes us rather than handing cash over.
        await this.customers.adjustBalance(sale.customer_id, -refundTotal);
      }

      const finalRecord = await this.returns.update(record.id, {
        loyalty_reversed: loyaltyReversed,
        items_restocked: restocked,
        items_written_off: writtenOff,
        store_credit_code: storeCreditCode,
      });

      await this.audit.record({
        action: 'RETURN',
        module: 'sales',
        entityType: 'sales_return',
        entityId: record.id,
        entityLabel: record.return_no,
        after: {
          invoice: sale?.invoice_no || 'no receipt',
          type,
          reason: reasonCode,
          items: lines.length,
          units_restocked: restocked,
          units_written_off: writtenOff,
          gross_refund: grossRefund,
          restocking_fee: restockingFee,
          refund_total: refundTotal,
          refund_method: refundMethod,
          store_credit_code: storeCreditCode,
          loyalty_reversed: loyaltyReversed,
        },
        actor: context.actor,
        request: context.request,
      });

      return this.get(finalRecord.id);
    });
  }

  async #prepareAgainstInvoice(payload, policy, context) {
    const header = payload.sale_id
      ? await this.sales.findById(payload.sale_id)
      : await this.sales.findByInvoiceNo(payload.invoice_no);
    if (!header) throw new NotFoundError('Invoice', payload.invoice_no || payload.sale_id);

    const sale = await this.sales.findAggregate(header.id);
    if (sale.status === 'void') throw new BusinessRuleError('Cannot return against a voided invoice');

    const ageDays = Math.floor((Date.now() - new Date(sale.sale_date).getTime()) / 86_400_000);
    if (policy.windowDays > 0 && ageDays > policy.windowDays) {
      if (!context.permissions?.includes('sales.return_no_receipt')) {
        throw new BusinessRuleError(
          `This invoice is ${ageDays} days old; the return window is ${policy.windowDays} days. A manager can override.`,
        );
      }
    }

    const lines = [];
    for (const item of payload.lines || []) {
      const quantity = round3(Number(item.quantity));
      if (!(quantity > 0)) continue;

      const saleLine = sale.lines.find((l) => l.id === Number(item.sale_line_id));
      if (!saleLine) throw new NotFoundError('Invoice line', item.sale_line_id);

      const returnable = round3(saleLine.quantity - saleLine.returned_quantity);
      if (quantity > returnable) {
        throw new BusinessRuleError(
          `Cannot return ${quantity} × ${saleLine.sku}: only ${returnable} of that line remain unreturned`,
        );
      }

      const grossPerUnit = round2(saleLine.line_total / saleLine.quantity);
      const taxPerUnit = round2(saleLine.tax_amount / saleLine.quantity);
      lines.push({
        sale_line_id: saleLine.id,
        variant_id: saleLine.variant_id,
        sku: saleLine.sku,
        description: saleLine.description,
        quantity,
        unit_price: round2(grossPerUnit - taxPerUnit),
        unit_cost: saleLine.unit_cost,
        tax_amount: round2(taxPerUnit * quantity),
        line_total: round2(grossPerUnit * quantity),
        condition: item.condition === 'damaged' ? 'damaged' : 'resellable',
        notes: item.notes || null,
      });
    }

    return { sale, lines };
  }

  async #prepareWithoutReceipt(payload) {
    const lines = [];
    for (const item of payload.lines || []) {
      const quantity = round3(Number(item.quantity));
      if (!(quantity > 0)) continue;

      const variant = await this.variants.details(item.variant_id);
      if (!variant) throw new NotFoundError('Variant', item.variant_id);

      const net = round2(variant.selling_price * quantity);
      const tax = percentOf(net, variant.tax_rate);
      lines.push({
        sale_line_id: null,
        variant_id: variant.variant_id,
        sku: variant.sku,
        description: [variant.product_name_en, variant.variant_label].filter(Boolean).join(' — '),
        quantity,
        unit_price: round2(variant.selling_price),
        unit_cost: variant.cost_price,
        tax_amount: tax,
        line_total: round2(net + tax),
        condition: item.condition === 'damaged' ? 'damaged' : 'resellable',
        notes: item.notes || null,
      });
    }
    return { sale: null, lines };
  }

  /** Store credit is a single-use voucher the customer spends at the till. */
  async #issueStoreCredit(amount, returnNo, policy, context) {
    if (!(amount > 0)) return null;
    const expiry = policy.storeCreditValidityDays > 0
      ? new Date(Date.now() + policy.storeCreditValidityDays * 86_400_000).toISOString().slice(0, 10)
      : null;
    let code;
    do {
      code = `CR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    } while (await repositories.promotions.findByCode(code));

    await repositories.promotions.create({
      code,
      name_en: `Store credit — ${returnNo}`,
      name_ar: `رصيد متجر — ${returnNo}`,
      kind: 'voucher',
      discount_type: 'fixed',
      value: amount,
      voucher_balance: amount,
      scope: 'order',
      ends_at: expiry,
      usage_limit: 1,
      is_active: 1,
      created_by: context.actor?.id || null,
    });
    return code;
  }

  /** Reason breakdown for the returns report. */
  /**
   * Undo a return, exactly.
   *
   * ── Why this did not exist ──────────────────────────────────────────────────
   * Because a return is the shop's apology, and undoing an apology is not a
   * thing a till usually needs to do. Then the owner rang one up while learning
   * the system, and there was no way back: money had gone out, a piece had come
   * off the shelf and been written off, and the figures carried it forever. He
   * asked to delete it, and "delete" for a document with money in it means this
   * — a mirror, not an eraser.
   *
   * ── What it reverses, in the reverse order ─────────────────────────────────
   *   the stock  — a restocked piece comes back OFF the shelf, and a written-off
   *                one is un-written-off and then taken back off, so the
   *                movement ledger shows both halves rather than a hole;
   *   the sale   — `returned_quantity` on each line goes back down, which is
   *                what re-opens the invoice for a genuine return later;
   *   the points — the loyalty taken off the customer is given back;
   *   the money  — an account credit is undone; a store credit voucher is
   *                cancelled. CASH IS NOT SILENTLY UNDONE: the note says the
   *                till is short by that much, because a computer cannot reach
   *                into a drawer and nobody should pretend it can.
   *
   * The return row is marked `reversed` and kept. Its number stays in the
   * sequence, because a gap in a document sequence is a worse thing to explain
   * than a reversed document in it.
   */
  async reverse(id, reason, context = {}) {
    return transaction(async () => {
      const record = await this.returns.findAggregate(id);
      if (!record) throw new NotFoundError('Return', id);
      if (record.status === 'reversed') {
        throw new BusinessRuleError('This return has already been reversed');
      }

      const lines = record.lines || [];
      let unRestocked = 0;
      let unWrittenOff = 0;

      for (const line of lines) {
        const quantity = Math.abs(Number(line.quantity || 0));
        if (!quantity) continue;

        if (line.condition === 'damaged') {
          /*
           * It was received and then scrapped. Put the scrap back first so the
           * shelf can carry the piece the outbound movement is about to take —
           * without this the second movement can hit a negative balance and be
           * refused, and the ledger would be left half-undone.
           */
          // eslint-disable-next-line no-await-in-loop
          await this.inventory.postMovement({
            variantId: line.variant_id,
            warehouseId: record.warehouse_id,
            movementType: 'adjustment',
            quantity,
            unitCost: line.unit_cost,
            referenceType: 'sales_return_reversal',
            referenceId: record.id,
            referenceNo: record.return_no,
            notes: reason || 'Return reversed — write-off undone',
            actorId: context.actor?.id || null,
            allowNegative: true,
          });
          unWrittenOff += quantity;
        } else {
          unRestocked += quantity;
        }

        // And out again: the piece is back with the customer, wherever it is.
        // eslint-disable-next-line no-await-in-loop
        await this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: record.warehouse_id,
          movementType: 'sale',
          quantity: -quantity,
          unitCost: line.unit_cost,
          referenceType: 'sales_return_reversal',
          referenceId: record.id,
          referenceNo: record.return_no,
          notes: reason || 'Return reversed',
          actorId: context.actor?.id || null,
          allowNegative: true,
        });

        // eslint-disable-next-line no-await-in-loop
        if (line.sale_line_id) await this.sales.incrementReturnedQty(line.sale_line_id, -quantity);
      }

      // The points the return took off the customer.
      if (record.customer_id && Number(record.loyalty_reversed || 0) > 0) {
        await this.customers.adjustLoyalty(record.customer_id, Number(record.loyalty_reversed));
      }

      /*
       * The money. Three refund methods, three different truths:
       *   account      — the customer's balance went down; put it back up.
       *   store_credit — the voucher is cancelled, so it cannot be spent. This
       *                  is why the recycle bin refuses to delete a return whose
       *                  voucher has ALREADY been spent: cancelling it then
       *                  would take back money the customer no longer has.
       *   cash         — nothing here can undo. It is reported, not pretended.
       */
      const money = { method: record.refund_method, amount: round2(record.total_amount) };
      if (record.refund_method === 'account' && record.customer_id) {
        await this.customers.adjustBalance(record.customer_id, round2(record.total_amount));
        money.undone = true;
      } else if (record.refund_method === 'store_credit' && record.store_credit_code) {
        await getDb().prepare(
          "UPDATE promotions SET is_active = 0 WHERE code = ? AND kind = 'voucher'",
        ).run(record.store_credit_code);
        money.undone = true;
        money.voucherCancelled = record.store_credit_code;
      } else {
        // Cash. Said plainly, in the record and to the caller.
        money.undone = false;
        money.note = 'Cash was refunded from the till and has not been put back automatically.';
      }

      const updated = await this.returns.update(record.id, {
        status: 'reversed',
        reversed_at: new Date().toISOString(),
        reversed_by: context.actor?.id || null,
        reversal_reason: reason || null,
      });

      await this.audit.record({
        action: 'REVERSE',
        module: 'sales',
        entityType: 'sales_return',
        entityId: record.id,
        entityLabel: record.return_no,
        before: { status: record.status || 'completed', refund: record.total_amount },
        after: { status: 'reversed', money, unRestocked, unWrittenOff, reason },
        actor: context.actor,
        request: context.request,
      });

      return {
        record: updated, money, unRestocked, unWrittenOff,
      };
    });
  }

  async reasonBreakdown(query) {
    return this.returns.reasonBreakdown(query || {});
  }
}

export const returnService = new ReturnService();
export default returnService;
