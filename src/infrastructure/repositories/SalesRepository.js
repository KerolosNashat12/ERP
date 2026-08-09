/** Sales, sale lines, payments and returns. */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';

export class SalesRepository extends BaseRepository {
  constructor() {
    super({
      table: 'sales',
      columns: [
        'invoice_no', 'customer_id', 'warehouse_id', 'status', 'payment_status', 'sale_date',
        'subtotal', 'line_discount', 'promotion_id', 'promotion_code', 'promotion_discount',
        'discount_amount', 'manual_discount', 'tax_amount', 'total_amount', 'total_cost',
        'paid_amount', 'change_amount', 'payment_method', 'loyalty_earned', 'loyalty_redeemed',
        'notes', 'created_by', 'voided_by', 'voided_at', 'void_reason',
      ],
      searchable: ['invoice_no', 'notes'],
      timestamps: false,
    });
  }

  listDetailed({ search = '', status, customerId, userId, warehouseId, paymentStatus,
    dateFrom, dateTo, page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (search) { where.push('s.invoice_no LIKE ?'); params.push(`%${search}%`); }
    if (status) { where.push('s.status = ?'); params.push(status); }
    if (paymentStatus) { where.push('s.payment_status = ?'); params.push(paymentStatus); }
    if (customerId) { where.push('s.customer_id = ?'); params.push(customerId); }
    if (userId) { where.push('s.created_by = ?'); params.push(userId); }
    if (warehouseId) { where.push('s.warehouse_id = ?'); params.push(warehouseId); }
    if (dateFrom) { where.push('date(s.sale_date) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(s.sale_date) <= date(?)'); params.push(dateTo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM sales s ${whereSql}`).get(...params).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);
    const rows = this.db.prepare(`
      SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
             w.name_en AS warehouse_name, u.full_name AS cashier_name,
             (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_id = s.id) AS line_count
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u ON u.id = s.created_by
      ${whereSql}
      ORDER BY s.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    const summary = this.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total_amount ELSE 0 END),0) AS total_sales,
             COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total_amount - s.total_cost ELSE 0 END),0) AS gross_profit,
             COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total_amount - s.paid_amount ELSE 0 END),0) AS outstanding
      FROM sales s ${whereSql}
    `).get(...params);

    return { rows, total, summary, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  findAggregate(id) {
    const sale = this.db.prepare(`
      SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
             c.customer_group, w.name_en AS warehouse_name, u.full_name AS cashier_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      JOIN warehouses w ON w.id = s.warehouse_id
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = ?
    `).get(id);
    if (!sale) return null;
    sale.lines = this.db.prepare(`
      SELECT l.*, vd.product_name_en, vd.product_name_ar, vd.variant_label, vd.barcode, vd.unit
      FROM sale_lines l
      LEFT JOIN v_variant_details vd ON vd.variant_id = l.variant_id
      WHERE l.sale_id = ? ORDER BY l.id
    `).all(id);
    sale.payments = this.db
      .prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id')
      .all(id);
    sale.returns = this.db
      .prepare('SELECT * FROM sales_returns WHERE sale_id = ? ORDER BY id')
      .all(id);
    return sale;
  }

  findByInvoiceNo(invoiceNo) {
    return this.findBy('invoice_no', invoiceNo);
  }

  insertLines(saleId, lines) {
    const insert = this.db.prepare(`
      INSERT INTO sale_lines
        (sale_id, variant_id, sku, description, quantity, unit_price, unit_cost,
         discount_percent, discount_amount, tax_rate, tax_amount, line_total)
      VALUES (@sale_id, @variant_id, @sku, @description, @quantity, @unit_price, @unit_cost,
              @discount_percent, @discount_amount, @tax_rate, @tax_amount, @line_total)
    `);
    for (const line of lines) insert.run({ sale_id: saleId, ...line });
  }

  lines(saleId) {
    return this.db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY id').all(saleId);
  }

  addPayment({ sale_id, amount, method, reference, created_by }) {
    this.db.prepare(`
      INSERT INTO sale_payments (sale_id, amount, method, reference, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(sale_id, amount, method, reference || null, created_by || null);
  }

  incrementReturnedQty(saleLineId, quantity) {
    this.db.prepare('UPDATE sale_lines SET returned_quantity = returned_quantity + ? WHERE id = ?')
      .run(quantity, saleLineId);
  }

  /** Dashboard/report aggregates. */
  salesTotals({ dateFrom, dateTo, warehouseId } = {}) {
    const where = ["s.status = 'completed'"];
    const params = [];
    if (dateFrom) { where.push('date(s.sale_date) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(s.sale_date) <= date(?)'); params.push(dateTo); }
    if (warehouseId) { where.push('s.warehouse_id = ?'); params.push(warehouseId); }
    return getDb().prepare(`
      SELECT COUNT(*) AS invoice_count,
             COALESCE(SUM(s.total_amount),0) AS revenue,
             COALESCE(SUM(s.total_cost),0)   AS cost,
             COALESCE(SUM(s.total_amount - s.total_cost),0) AS profit,
             COALESCE(SUM(s.discount_amount),0) AS discounts,
             COALESCE(SUM(s.tax_amount),0)   AS tax,
             COALESCE(AVG(s.total_amount),0) AS average_basket
      FROM sales s WHERE ${where.join(' AND ')}
    `).get(...params);
  }
}

export class SalesReturnRepository extends BaseRepository {
  constructor() {
    super({
      table: 'sales_returns',
      columns: [
        'return_no', 'sale_id', 'invoice_no', 'customer_id', 'warehouse_id', 'return_type',
        'return_date', 'reason_code', 'reason_note', 'subtotal', 'tax_amount', 'total_amount',
        'restocking_fee', 'refund_method', 'store_credit_code', 'loyalty_reversed',
        'items_restocked', 'items_written_off', 'created_by', 'approved_by',
      ],
      searchable: ['return_no', 'invoice_no', 'reason_note'],
      timestamps: false,
    });
  }

  listDetailed({ search = '', reasonCode, refundMethod, returnType, dateFrom, dateTo,
    page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (search) {
      where.push('(r.return_no LIKE ? OR r.invoice_no LIKE ? OR c.name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (reasonCode) { where.push('r.reason_code = ?'); params.push(reasonCode); }
    if (refundMethod) { where.push('r.refund_method = ?'); params.push(refundMethod); }
    if (returnType) { where.push('r.return_type = ?'); params.push(returnType); }
    if (dateFrom) { where.push('date(r.return_date) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(r.return_date) <= date(?)'); params.push(dateTo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = this.db.prepare(`
      SELECT COUNT(*) AS n FROM sales_returns r
      LEFT JOIN customers c ON c.id = r.customer_id ${whereSql}
    `).get(...params).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);

    const rows = this.db.prepare(`
      SELECT r.*, s.invoice_no AS sale_invoice_no, c.name AS customer_name, c.phone AS customer_phone,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM sales_return_lines l WHERE l.return_id = r.id) AS line_count,
             (SELECT COALESCE(SUM(quantity),0) FROM sales_return_lines l WHERE l.return_id = r.id) AS total_qty
      FROM sales_returns r
      LEFT JOIN sales s ON s.id = r.sale_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN users u ON u.id = r.created_by
      ${whereSql} ORDER BY r.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    const summary = this.db.prepare(`
      SELECT COALESCE(SUM(r.total_amount),0) AS refunded,
             COALESCE(SUM(r.items_restocked),0) AS restocked,
             COALESCE(SUM(r.items_written_off),0) AS written_off
      FROM sales_returns r LEFT JOIN customers c ON c.id = r.customer_id ${whereSql}
    `).get(...params);

    return { rows, total, summary, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  insertLines(returnId, lines) {
    const insert = this.db.prepare(`
      INSERT INTO sales_return_lines
        (return_id, sale_line_id, variant_id, sku, description, quantity,
         unit_price, unit_cost, tax_amount, line_total, condition, notes)
      VALUES (@return_id, @sale_line_id, @variant_id, @sku, @description, @quantity,
              @unit_price, @unit_cost, @tax_amount, @line_total, @condition, @notes)
    `);
    for (const line of lines) {
      insert.run({
        return_id: returnId, sale_line_id: null, notes: null, condition: 'resellable', ...line,
      });
    }
  }

  findAggregate(id) {
    const record = this.db.prepare(`
      SELECT r.*, s.invoice_no AS sale_invoice_no, s.sale_date,
             c.name AS customer_name, c.phone AS customer_phone,
             u.full_name AS created_by_name
      FROM sales_returns r
      LEFT JOIN sales s ON s.id = r.sale_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = ?
    `).get(id);
    if (!record) return null;
    record.lines = this.db.prepare(`
      SELECT l.*, vd.product_name_en, vd.product_name_ar, vd.variant_label
      FROM sales_return_lines l
      LEFT JOIN v_variant_details vd ON vd.variant_id = l.variant_id
      WHERE l.return_id = ? ORDER BY l.id
    `).all(id);
    return record;
  }

  /** Reason breakdown — feeds the returns report and quality conversations with suppliers. */
  reasonBreakdown({ dateFrom, dateTo } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (dateFrom) { where.push('date(r.return_date) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(r.return_date) <= date(?)'); params.push(dateTo); }
    return this.db.prepare(`
      SELECT r.reason_code, COUNT(*) AS returns,
             COALESCE(SUM(r.total_amount),0) AS refunded,
             COALESCE(SUM(l.quantity),0) AS units
      FROM sales_returns r
      LEFT JOIN sales_return_lines l ON l.return_id = r.id
      WHERE ${where.join(' AND ')}
      GROUP BY r.reason_code ORDER BY refunded DESC
    `).all(...params);
  }
}
