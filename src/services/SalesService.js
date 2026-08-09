/**
 * Sales / point-of-sale use-cases.
 *
 * checkout() is a single transaction that: prices the basket, applies a
 * promotion, allocates order-level discounts back across lines (so VAT is
 * charged on the real net), issues stock, records payments, updates customer
 * balance and loyalty, redeems the promo code and writes the audit entry.
 * Any failure rolls the whole thing back — a half-committed sale is impossible.
 *
 * Returns live in ReturnService — they have their own rules and deserve their
 * own use-case rather than being bolted on here.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { calculateLine, percentOf, round2, round3 } from '../shared/money.js';
import inventoryService from './InventoryService.js';
import promotionService from './PromotionService.js';
import auditService from './AuditService.js';

export class SalesService {
  constructor(deps = {}) {
    this.sales = deps.sales || repositories.sales;
    this.customers = deps.customers || repositories.customers;
    this.variants = deps.variants || repositories.variants;
    this.warehouses = deps.warehouses || repositories.warehouses;
    this.sequences = deps.sequences || repositories.sequences;
    this.settings = deps.settings || repositories.settings;
    this.inventory = deps.inventory || inventoryService;
    this.promotions = deps.promotions || promotionService;
    this.audit = deps.audit || auditService;
  }

  list(query) {
    return this.sales.listDetailed(query || {});
  }

  get(id) {
    const sale = this.sales.findAggregate(id);
    if (!sale) throw new NotFoundError('Sale', id);
    return sale;
  }

  /** Price a basket without committing anything — powers the live POS totals. */
  quote({ lines = [], customer_id = null, promotion_code = null, manual_discount = 0,
    loyalty_redeem_points = 0 }) {
    const customer = customer_id ? this.customers.findById(customer_id) : null;
    const priced = this.#priceLines(lines, customer);
    if (!priced.length) {
      return {
        lines: [], subtotal: 0, lineDiscount: 0, promotionDiscount: 0, manualDiscount: 0,
        loyaltyDiscount: 0, taxAmount: 0, totalAmount: 0, totalCost: 0, promotion: null,
      };
    }
    return this.#buildTotals({
      priced, customer, promotionCode: promotion_code,
      manualDiscount: manual_discount, loyaltyPoints: loyalty_redeem_points,
    });
  }

  #priceLines(lines, customer) {
    const useWholesale = customer?.customer_group === 'wholesale';
    return lines
      .filter((l) => Number(l.quantity) > 0)
      .map((line, index) => {
        const details = this.variants.details(line.variant_id);
        if (!details) throw new NotFoundError('Variant', line.variant_id);
        const defaultPrice = useWholesale && details.wholesale_price > 0
          ? details.wholesale_price
          : details.selling_price;
        const unitPrice = line.unit_price !== undefined && line.unit_price !== null && line.unit_price !== ''
          ? round2(line.unit_price)
          : round2(defaultPrice);
        const computed = calculateLine({
          quantity: line.quantity,
          unitPrice,
          discountPercent: line.discount_percent || 0,
          discountAmount: line.discount_amount || 0,
          taxRate: 0, // tax is computed after order-level discount allocation
        });
        return {
          key: line.key ?? index,
          variant_id: details.variant_id,
          product_id: details.product_id,
          category_id: details.category_id,
          brand_id: details.brand_id,
          sku: details.sku,
          description: [details.product_name_en, details.variant_label].filter(Boolean).join(' — '),
          product_name_en: details.product_name_en,
          product_name_ar: details.product_name_ar,
          variant_label: details.variant_label,
          quantity: round3(line.quantity),
          unit_price: unitPrice,
          unit_cost: Number(details.cost_price || 0),
          discount_percent: Number(line.discount_percent || 0),
          discount_amount: computed.discountAmount,
          tax_rate: Number(details.tax_rate || 0),
          grossAmount: computed.gross,
          netAmount: computed.netAmount,
        };
      });
  }

  #buildTotals({ priced, customer, promotionCode, manualDiscount = 0, loyaltyPoints = 0 }) {
    const subtotal = round2(priced.reduce((s, l) => s + l.grossAmount, 0));
    const lineDiscount = round2(priced.reduce((s, l) => s + l.discount_amount, 0));
    const netBeforeOrderDiscount = round2(priced.reduce((s, l) => s + l.netAmount, 0));

    let promotionResult = null;
    if (promotionCode) {
      promotionResult = this.promotions.evaluate({ code: promotionCode, lines: priced, customer });
    }
    const promotionDiscount = promotionResult ? promotionResult.discount : 0;

    const redeemValue = Number(this.settings.get('loyalty.redeem_value', 0.1));
    const requestedPoints = Math.max(Number(loyaltyPoints || 0), 0);
    if (requestedPoints > 0 && !customer) throw new BusinessRuleError('Select a customer to redeem loyalty points');
    if (requestedPoints > Number(customer?.loyalty_points || 0)) {
      throw new BusinessRuleError('Customer does not have enough loyalty points');
    }
    let loyaltyDiscount = round2(requestedPoints * redeemValue);

    let manual = round2(Math.max(Number(manualDiscount || 0), 0));
    const maxOrderDiscount = round2(netBeforeOrderDiscount - promotionDiscount);
    if (manual + loyaltyDiscount > maxOrderDiscount) {
      if (manual > maxOrderDiscount) manual = maxOrderDiscount;
      loyaltyDiscount = Math.max(round2(maxOrderDiscount - manual), 0);
    }

    const orderDiscount = round2(promotionDiscount + manual + loyaltyDiscount);
    const eligibleKeys = promotionResult ? new Set(promotionResult.appliesToLines) : null;

    // Allocate the order-level discount back to lines so tax is charged on the
    // amount actually paid. Promotion discount only hits eligible lines.
    const promoBase = promotionResult
      ? round2(priced.filter((l) => eligibleKeys.has(l.key)).reduce((s, l) => s + l.netAmount, 0))
      : 0;
    const generalBase = netBeforeOrderDiscount;
    const generalDiscount = round2(manual + loyaltyDiscount);

    let taxAmount = 0;
    let totalCost = 0;
    const finalLines = priced.map((line) => {
      const promoShare = promotionResult && eligibleKeys.has(line.key) && promoBase > 0
        ? round2(promotionDiscount * (line.netAmount / promoBase))
        : 0;
      const generalShare = generalBase > 0 ? round2(generalDiscount * (line.netAmount / generalBase)) : 0;
      const taxableBase = Math.max(round2(line.netAmount - promoShare - generalShare), 0);
      const lineTax = percentOf(taxableBase, line.tax_rate);
      taxAmount = round2(taxAmount + lineTax);
      totalCost = round2(totalCost + line.quantity * line.unit_cost);
      return {
        ...line,
        allocated_order_discount: round2(promoShare + generalShare),
        taxable_amount: taxableBase,
        tax_amount: lineTax,
        line_total: round2(taxableBase + lineTax),
      };
    });

    const totalDiscount = round2(lineDiscount + orderDiscount);
    const totalAmount = round2(finalLines.reduce((s, l) => s + l.line_total, 0));

    const earnRate = Number(this.settings.get('loyalty.earn_rate', 0));
    const loyaltyEarned = customer && earnRate > 0 ? Math.floor(totalAmount * earnRate) : 0;

    return {
      lines: finalLines,
      subtotal,
      lineDiscount,
      promotionDiscount,
      manualDiscount: manual,
      loyaltyDiscount,
      loyaltyPointsRedeemed: loyaltyDiscount > 0 ? requestedPoints : 0,
      loyaltyEarned,
      totalDiscount,
      taxAmount,
      totalAmount,
      totalCost,
      promotion: promotionResult ? promotionResult.promotion : null,
    };
  }

  /** Commit a sale. */
  checkout(payload, context = {}) {
    return transaction(() => {
      const warehouseId = this.inventory.locationId();

      const rawLines = (payload.lines || []).filter((l) => Number(l.quantity) > 0);
      if (!rawLines.length) throw new ValidationError('The sale has no items');

      const customer = payload.customer_id ? this.customers.requireById(payload.customer_id, 'customer') : null;
      const priced = this.#priceLines(rawLines, customer);
      const totals = this.#buildTotals({
        priced,
        customer,
        promotionCode: payload.promotion_code || null,
        manualDiscount: payload.manual_discount || 0,
        loyaltyPoints: payload.loyalty_redeem_points || 0,
      });

      const payments = (payload.payments?.length
        ? payload.payments
        : [{ amount: payload.paid_amount ?? totals.totalAmount, method: payload.payment_method || 'cash' }]
      ).filter((p) => Number(p.amount) > 0);

      const paid = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
      const method = payments.length > 1
        ? 'mixed'
        : (payments[0]?.method || payload.payment_method || 'cash');
      const isCredit = method === 'credit' || paid < totals.totalAmount;

      if (isCredit && !customer) {
        throw new BusinessRuleError('Credit sales require a registered customer');
      }
      if (isCredit && customer) {
        const newBalance = round2(Number(customer.balance) + (totals.totalAmount - paid));
        if (Number(customer.credit_limit) > 0 && newBalance > Number(customer.credit_limit)) {
          throw new BusinessRuleError(
            `Credit limit exceeded: balance would be ${newBalance} against a limit of ${customer.credit_limit}`,
          );
        }
      }

      const change = method === 'cash' && paid > totals.totalAmount
        ? round2(paid - totals.totalAmount)
        : 0;
      const settled = round2(Math.min(paid, totals.totalAmount));
      const paymentStatus = settled >= totals.totalAmount - 0.009
        ? 'paid'
        : (settled > 0 ? 'partial' : 'unpaid');

      const sale = this.sales.create({
        invoice_no: this.sequences.next('sale'),
        customer_id: customer?.id || null,
        warehouse_id: warehouseId,
        status: 'completed',
        payment_status: paymentStatus,
        sale_date: payload.sale_date || new Date().toISOString(),
        subtotal: totals.subtotal,
        line_discount: totals.lineDiscount,
        promotion_id: totals.promotion?.id || null,
        promotion_code: totals.promotion?.code || null,
        promotion_discount: totals.promotionDiscount,
        manual_discount: totals.manualDiscount,
        discount_amount: totals.totalDiscount,
        tax_amount: totals.taxAmount,
        total_amount: totals.totalAmount,
        total_cost: totals.totalCost,
        paid_amount: settled,
        change_amount: change,
        payment_method: method,
        loyalty_earned: totals.loyaltyEarned,
        loyalty_redeemed: totals.loyaltyPointsRedeemed,
        notes: payload.notes || null,
        created_by: context.actor?.id || null,
      });

      this.sales.insertLines(sale.id, totals.lines.map((l) => ({
        variant_id: l.variant_id,
        sku: l.sku,
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price,
        unit_cost: l.unit_cost,
        discount_percent: l.discount_percent,
        discount_amount: round2(l.discount_amount + l.allocated_order_discount),
        tax_rate: l.tax_rate,
        tax_amount: l.tax_amount,
        line_total: l.line_total,
      })));

      // Issue stock and snapshot the true COGS from the moving-average cost.
      let actualCost = 0;
      for (const line of totals.lines) {
        const level = repositories.inventory.ensureLevel(line.variant_id, warehouseId);
        const unitCost = Number(level.average_cost || line.unit_cost || 0);
        this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId,
          movementType: 'sale',
          quantity: -Math.abs(line.quantity),
          unitCost,
          referenceType: 'sale',
          referenceId: sale.id,
          referenceNo: sale.invoice_no,
          actorId: context.actor?.id || null,
        });
        actualCost = round2(actualCost + line.quantity * unitCost);
      }
      this.sales.update(sale.id, { total_cost: actualCost });

      for (const payment of payments) {
        this.sales.addPayment({
          sale_id: sale.id,
          amount: round2(Math.min(Number(payment.amount), totals.totalAmount)),
          method: payment.method || 'cash',
          reference: payment.reference,
          created_by: context.actor?.id || null,
        });
      }

      if (totals.promotion) {
        this.promotions.commitRedemption({
          promotionId: totals.promotion.id,
          saleId: sale.id,
          customerId: customer?.id || null,
          discountAmount: totals.promotionDiscount,
        });
      }

      if (customer) {
        if (settled < totals.totalAmount) {
          this.customers.adjustBalance(customer.id, round2(totals.totalAmount - settled));
        }
        const pointsDelta = round2(totals.loyaltyEarned - totals.loyaltyPointsRedeemed);
        if (pointsDelta !== 0) this.customers.adjustLoyalty(customer.id, pointsDelta);
      }

      this.audit.record({
        action: 'CREATE', module: 'sales', entityType: 'sale', entityId: sale.id,
        entityLabel: sale.invoice_no,
        after: {
          invoice_no: sale.invoice_no, total: totals.totalAmount, items: totals.lines.length,
          customer: customer?.name || 'Walk-in', promotion: totals.promotion?.code || null,
          payment_method: method, payment_status: paymentStatus,
        },
        actor: context.actor, request: context.request,
      });

      return this.get(sale.id);
    });
  }

  /** Full reversal: returns stock, releases the promo code, unwinds balances. */
  void(id, reason, context = {}) {
    return transaction(() => {
      const sale = this.sales.findAggregate(id);
      if (!sale) throw new NotFoundError('Sale', id);
      if (sale.status === 'void') throw new BusinessRuleError('This invoice is already void');
      if (sale.returns?.length) {
        throw new BusinessRuleError('This invoice has returns against it — reverse those first');
      }

      for (const line of sale.lines) {
        this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: sale.warehouse_id,
          movementType: 'sale_return',
          quantity: Math.abs(line.quantity),
          unitCost: line.unit_cost,
          referenceType: 'sale_void',
          referenceId: sale.id,
          referenceNo: sale.invoice_no,
          notes: reason || 'Invoice voided',
          actorId: context.actor?.id || null,
        });
      }

      if (sale.promotion_id) this.promotions.reverseRedemption(sale.id);

      if (sale.customer_id) {
        const outstanding = round2(sale.total_amount - sale.paid_amount);
        if (outstanding > 0) this.customers.adjustBalance(sale.customer_id, -outstanding);
        const pointsDelta = round2(sale.loyalty_earned - sale.loyalty_redeemed);
        if (pointsDelta !== 0) this.customers.adjustLoyalty(sale.customer_id, -pointsDelta);
      }

      const updated = this.sales.update(id, {
        status: 'void',
        voided_by: context.actor?.id || null,
        voided_at: new Date().toISOString(),
        void_reason: reason || null,
      });

      this.audit.record({
        action: 'VOID', module: 'sales', entityType: 'sale', entityId: id,
        entityLabel: sale.invoice_no,
        before: { status: sale.status, total: sale.total_amount },
        after: { status: 'void', reason },
        actor: context.actor, request: context.request,
      });
      return updated;
    });
  }

  registerPayment(id, { amount, method = 'cash', reference }, context = {}) {
    return transaction(() => {
      const sale = this.sales.requireById(id, 'sale');
      if (sale.status === 'void') throw new BusinessRuleError('Cannot collect against a void invoice');
      const value = round2(Number(amount));
      if (!(value > 0)) throw new ValidationError('Payment amount must be greater than zero');
      const outstanding = round2(sale.total_amount - sale.paid_amount);
      if (value > outstanding + 0.01) throw new BusinessRuleError(`Only ${outstanding} is outstanding`);

      const paid = round2(sale.paid_amount + value);
      this.sales.addPayment({ sale_id: id, amount: value, method, reference, created_by: context.actor?.id });
      const updated = this.sales.update(id, {
        paid_amount: paid,
        payment_status: paid >= sale.total_amount - 0.009 ? 'paid' : 'partial',
      });
      if (sale.customer_id) this.customers.adjustBalance(sale.customer_id, -value);

      this.audit.record({
        action: 'PAYMENT', module: 'sales', entityType: 'sale', entityId: id,
        entityLabel: sale.invoice_no,
        before: { paid_amount: sale.paid_amount },
        after: { paid_amount: paid, method, reference },
        actor: context.actor, request: context.request,
      });
      return updated;
    });
  }

  /** Cashier shift summary — what should be in the drawer. */
  shiftSummary({ userId, dateFrom, dateTo }) {
    const db = this.sales.db;
    const params = [];
    const where = ["s.status = 'completed'"];
    if (userId) { where.push('s.created_by = ?'); params.push(userId); }
    if (dateFrom) { where.push('date(s.sale_date) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(s.sale_date) <= date(?)'); params.push(dateTo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    return {
      totals: db.prepare(`
        SELECT COUNT(*) AS invoices, COALESCE(SUM(s.total_amount),0) AS revenue,
               COALESCE(SUM(s.discount_amount),0) AS discounts,
               COALESCE(SUM(s.paid_amount),0) AS collected
        FROM sales s ${whereSql}
      `).get(...params),
      byMethod: db.prepare(`
        SELECT s.payment_method AS method, COUNT(*) AS invoices,
               COALESCE(SUM(s.paid_amount),0) AS amount
        FROM sales s ${whereSql} GROUP BY s.payment_method
      `).all(...params),
    };
  }
}

export const salesService = new SalesService();
export default salesService;
