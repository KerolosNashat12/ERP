/**
 * Promotions engine — discount codes and vouchers.
 *
 * Validation and the money calculation live here (not in the POS screen) so a
 * code behaves identically whether it is applied at the counter, on a
 * back-office invoice, or checked from the promotions list.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import { CrudService } from './CrudService.js';
import auditService from './AuditService.js';

export class PromotionService extends CrudService {
  constructor(deps = {}) {
    super({
      repository: deps.promotions || repositories.promotions,
      module: 'promotions',
      entityType: 'promotion',
      uniqueFields: ['code'],
      isReferenced: (id) => Boolean(
        repositories.promotions.db
          .prepare('SELECT 1 FROM promotion_redemptions WHERE promotion_id = ? LIMIT 1').get(id),
      ),
    });
    this.variants = deps.variants || repositories.variants;
  }

  beforeSave(data) {
    const payload = { ...data };
    if (payload.code) payload.code = String(payload.code).trim().toUpperCase();
    if (payload.discount_type === 'percentage' && Number(payload.value) > 100) {
      throw new ValidationError('A percentage discount cannot exceed 100%');
    }
    if (Number(payload.value) < 0) throw new ValidationError('Discount value cannot be negative');
    if (payload.starts_at && payload.ends_at && payload.starts_at > payload.ends_at) {
      throw new ValidationError('The end date must be after the start date');
    }
    if (payload.kind === 'voucher' && payload.voucher_balance === undefined) {
      payload.voucher_balance = payload.value;
    }
    return payload;
  }

  create(data, context) {
    const promotion = super.create(data, context);
    if (data.targets?.length) this.repository.replaceTargets(promotion.id, data.targets);
    return this.get(promotion.id);
  }

  update(id, data, context) {
    const promotion = super.update(id, data, context);
    if (data.targets) this.repository.replaceTargets(id, data.targets);
    return this.get(promotion.id);
  }

  get(id) {
    const promotion = this.repository.requireById(id, 'promotion');
    return {
      ...promotion,
      targets: this.repository.targets(id),
      redemptions: this.repository.db.prepare(`
        SELECT r.*, s.invoice_no, c.name AS customer_name
        FROM promotion_redemptions r
        LEFT JOIN sales s ON s.id = r.sale_id
        LEFT JOIN customers c ON c.id = r.customer_id
        WHERE r.promotion_id = ? ORDER BY r.id DESC LIMIT 50
      `).all(id),
    };
  }

  /** Business rules that don't depend on the basket. */
  #assertUsable(promotion, { customer } = {}) {
    if (!promotion.is_active) throw new BusinessRuleError('This code is not active');
    const now = new Date().toISOString();
    if (promotion.starts_at && now < promotion.starts_at) {
      throw new BusinessRuleError('This code is not valid yet');
    }
    if (promotion.ends_at && now > `${promotion.ends_at}T23:59:59Z`) {
      throw new BusinessRuleError('This code has expired');
    }
    if (promotion.usage_limit > 0 && promotion.usage_count >= promotion.usage_limit) {
      throw new BusinessRuleError('This code has reached its usage limit');
    }
    if (promotion.customer_group && customer && promotion.customer_group !== customer.customer_group) {
      throw new BusinessRuleError(`This code is limited to ${promotion.customer_group} customers`);
    }
    if (promotion.per_customer_limit > 0) {
      if (!customer) throw new BusinessRuleError('Select a customer to use this code');
      const used = this.repository.countCustomerRedemptions(promotion.id, customer.id);
      if (used >= promotion.per_customer_limit) {
        throw new BusinessRuleError('This customer has already used this code the maximum number of times');
      }
    }
    if (promotion.kind === 'voucher' && promotion.voucher_balance <= 0) {
      throw new BusinessRuleError('This voucher has no remaining balance');
    }
  }

  /** Which cart lines the promotion applies to, given its scope. */
  #eligibleAmount(promotion, lines) {
    if (promotion.scope === 'order') {
      return { amount: round2(lines.reduce((s, l) => s + l.netAmount, 0)), lineIds: lines.map((l) => l.key) };
    }
    const targets = this.repository.targets(promotion.id);
    const ids = new Set(targets.filter((t) => t.target_type === promotion.scope).map((t) => Number(t.target_id)));
    const variantIds = new Set(targets.filter((t) => t.target_type === 'variant').map((t) => Number(t.target_id)));
    const field = { product: 'product_id', category: 'category_id', brand: 'brand_id' }[promotion.scope];
    const eligible = lines.filter((l) => ids.has(Number(l[field])) || variantIds.has(Number(l.variant_id)));
    return {
      amount: round2(eligible.reduce((s, l) => s + l.netAmount, 0)),
      lineIds: eligible.map((l) => l.key),
    };
  }

  /**
   * Evaluate a code against a basket.
   * @param {object} p
   * @param {Array} p.lines  [{ key, variant_id, product_id, category_id, brand_id, netAmount }]
   * @returns {{promotion, discount, eligibleAmount, appliesToLines}}
   */
  evaluate({ code, lines = [], customer = null }) {
    const promotion = this.repository.findByCode(code);
    if (!promotion) throw new NotFoundError('Promotion code', code);
    this.#assertUsable(promotion, { customer });

    const orderNet = round2(lines.reduce((s, l) => s + Number(l.netAmount || 0), 0));
    if (promotion.min_order_amount > 0 && orderNet < promotion.min_order_amount) {
      throw new BusinessRuleError(
        `This code requires a minimum order of ${promotion.min_order_amount}`,
        { minimum: promotion.min_order_amount, current: orderNet },
      );
    }

    const { amount: eligibleAmount, lineIds } = this.#eligibleAmount(promotion, lines);
    if (eligibleAmount <= 0) {
      throw new BusinessRuleError('No items in this sale qualify for the selected code');
    }

    let discount;
    if (promotion.kind === 'voucher') {
      discount = Math.min(promotion.voucher_balance, eligibleAmount);
    } else if (promotion.discount_type === 'percentage') {
      discount = round2(eligibleAmount * (Number(promotion.value) / 100));
    } else {
      discount = Math.min(round2(Number(promotion.value)), eligibleAmount);
    }
    if (promotion.max_discount_amount > 0) {
      discount = Math.min(discount, round2(promotion.max_discount_amount));
    }

    return {
      promotion: {
        id: promotion.id,
        code: promotion.code,
        name_en: promotion.name_en,
        name_ar: promotion.name_ar,
        kind: promotion.kind,
        discount_type: promotion.discount_type,
        value: promotion.value,
        scope: promotion.scope,
        voucher_balance: promotion.voucher_balance,
      },
      discount: round2(discount),
      eligibleAmount,
      appliesToLines: lineIds,
    };
  }

  /** Called by SalesService once a sale is committed. */
  commitRedemption({ promotionId, saleId, customerId, discountAmount }) {
    const promotion = this.repository.findById(promotionId);
    if (!promotion) return;
    this.repository.recordRedemption({
      promotion_id: promotionId,
      sale_id: saleId,
      customer_id: customerId || null,
      discount_amount: discountAmount,
    });
    if (promotion.kind === 'voucher') {
      this.repository.consumeVoucherBalance(promotionId, discountAmount);
    }
  }

  /** Called when a sale is voided so codes and voucher balances are returned. */
  reverseRedemption(saleId) {
    const rows = this.repository.db
      .prepare('SELECT * FROM promotion_redemptions WHERE sale_id = ?').all(saleId);
    for (const row of rows) {
      const promotion = this.repository.findById(row.promotion_id);
      if (promotion?.kind === 'voucher') {
        this.repository.restoreVoucherBalance(row.promotion_id, row.discount_amount);
      }
    }
    return this.repository.reverseRedemption(saleId);
  }

  usageReport(query) {
    return this.repository.usageReport(query || {});
  }

  /** Quick "is this code good?" check from the promotions screen. */
  validateCode(code, context = {}) {
    const promotion = this.repository.findByCode(code);
    if (!promotion) throw new NotFoundError('Promotion code', code);
    try {
      this.#assertUsable(promotion, {});
      return { valid: true, promotion };
    } catch (error) {
      auditService.record({
        action: 'VALIDATE', module: 'promotions', entityType: 'promotion', entityId: promotion.id,
        entityLabel: promotion.code, status: 'FAILED', message: error.message,
        actor: context.actor, request: context.request,
      });
      return { valid: false, reason: error.message, promotion };
    }
  }

  /** Generate a batch of unique single-use voucher codes (gift cards, campaigns). */
  generateVouchers({ prefix = 'MMV', count = 10, value, expiresAt, namePrefix = 'Gift voucher' }, context = {}) {
    if (!(Number(value) > 0)) throw new ValidationError('Voucher value must be greater than zero');
    const quantity = Math.min(Math.max(Number(count) || 1, 1), 500);
    return transaction(() => {
      const created = [];
      for (let i = 0; i < quantity; i += 1) {
        let code;
        do {
          code = `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        } while (this.repository.findByCode(code));
        created.push(this.repository.create({
          code,
          name_en: `${namePrefix} ${value}`,
          name_ar: `قسيمة ${value}`,
          kind: 'voucher',
          discount_type: 'fixed',
          value: round2(value),
          voucher_balance: round2(value),
          scope: 'order',
          ends_at: expiresAt || null,
          usage_limit: 1,
          is_active: 1,
          created_by: context.actor?.id || null,
        }));
      }
      auditService.record({
        action: 'GENERATE', module: 'promotions', entityType: 'voucher_batch',
        entityLabel: `${created.length} vouchers @ ${value}`,
        after: { codes: created.map((c) => c.code) },
        actor: context.actor, request: context.request,
      });
      return created;
    });
  }
}

export const promotionService = new PromotionService();
export default promotionService;
