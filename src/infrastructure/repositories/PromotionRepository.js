/** Promotions, their targets, and redemption history. */
import { BaseRepository } from './BaseRepository.js';

export class PromotionRepository extends BaseRepository {
  constructor() {
    super({
      table: 'promotions',
      columns: [
        'code', 'name_en', 'name_ar', 'kind', 'discount_type', 'value', 'scope',
        'min_order_amount', 'max_discount_amount', 'voucher_balance', 'starts_at', 'ends_at',
        'usage_limit', 'usage_count', 'per_customer_limit', 'customer_group', 'is_active',
        'created_by',
      ],
      searchable: ['code', 'name_en', 'name_ar'],
    });
  }

  findByCode(code) {
    return this.db
      .prepare('SELECT * FROM promotions WHERE code = ? COLLATE NOCASE')
      .get(String(code).trim()) || null;
  }

  targets(promotionId) {
    return this.db
      .prepare('SELECT * FROM promotion_targets WHERE promotion_id = ?')
      .all(promotionId);
  }

  replaceTargets(promotionId, targets = []) {
    this.db.prepare('DELETE FROM promotion_targets WHERE promotion_id = ?').run(promotionId);
    const insert = this.db.prepare(
      'INSERT INTO promotion_targets (promotion_id, target_type, target_id) VALUES (?, ?, ?)',
    );
    for (const t of targets) insert.run(promotionId, t.target_type, t.target_id);
  }

  countCustomerRedemptions(promotionId, customerId) {
    if (!customerId) return 0;
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM promotion_redemptions WHERE promotion_id = ? AND customer_id = ?',
    ).get(promotionId, customerId).n;
  }

  recordRedemption({ promotion_id, sale_id, customer_id, discount_amount }) {
    this.db.prepare(`
      INSERT INTO promotion_redemptions (promotion_id, sale_id, customer_id, discount_amount)
      VALUES (?, ?, ?, ?)
    `).run(promotion_id, sale_id || null, customer_id || null, discount_amount);
    this.db.prepare('UPDATE promotions SET usage_count = usage_count + 1 WHERE id = ?').run(promotion_id);
  }

  reverseRedemption(saleId) {
    const rows = this.db.prepare('SELECT * FROM promotion_redemptions WHERE sale_id = ?').all(saleId);
    for (const row of rows) {
      this.db.prepare('UPDATE promotions SET usage_count = MAX(usage_count - 1, 0) WHERE id = ?')
        .run(row.promotion_id);
    }
    this.db.prepare('DELETE FROM promotion_redemptions WHERE sale_id = ?').run(saleId);
    return rows;
  }

  consumeVoucherBalance(promotionId, amount) {
    this.db.prepare(
      'UPDATE promotions SET voucher_balance = ROUND(MAX(voucher_balance - ?, 0), 2) WHERE id = ?',
    ).run(amount, promotionId);
  }

  restoreVoucherBalance(promotionId, amount) {
    this.db.prepare('UPDATE promotions SET voucher_balance = ROUND(voucher_balance + ?, 2) WHERE id = ?')
      .run(amount, promotionId);
  }

  usageReport({ dateFrom, dateTo } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (dateFrom) { where.push('date(r.redeemed_at) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(r.redeemed_at) <= date(?)'); params.push(dateTo); }
    return this.db.prepare(`
      SELECT p.id, p.code, p.name_en, p.name_ar, p.kind, p.discount_type, p.value,
             COUNT(r.id) AS redemptions,
             COALESCE(SUM(r.discount_amount), 0) AS total_discount,
             COUNT(DISTINCT r.customer_id) AS unique_customers
      FROM promotions p
      LEFT JOIN promotion_redemptions r ON r.promotion_id = p.id AND ${where.join(' AND ')}
      GROUP BY p.id ORDER BY total_discount DESC
    `).all(...params);
  }
}
