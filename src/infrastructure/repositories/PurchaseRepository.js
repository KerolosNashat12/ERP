/** Purchase order persistence (header + lines). */
import { BaseRepository } from './BaseRepository.js';
import { matchReasonColumns } from '../database/productSearch.js';
import { notInBin } from '../../shared/trashFilter.js';

export class PurchaseOrderRepository extends BaseRepository {
  constructor() {
    super({
      table: 'purchase_orders',
      columns: [
        'po_number', 'supplier_id', 'warehouse_id', 'status', 'order_date', 'expected_date',
        'subtotal', 'discount_type', 'discount_percent', 'discount_amount', 'tax_amount', 'shipping_amount',
        'total_amount',
        'paid_amount', 'notes', 'created_by', 'approved_by', 'approved_at',
      ],
      searchable: ['po_number', 'notes'],
      // "Have we ever ordered this?" — a purchase order answers a product code
      // by the lines it was raised for.
      productScope: { table: 'purchase_order_lines', key: 'purchase_order_id' },
    });
  }

  async listDetailed({ search = '', status, supplierId, dateFrom, dateTo, page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    const predicate = this.searchPredicate(search, { alias: 'po', extra: ['s.name_en', 's.name_ar'] });
    if (predicate) { where.push(predicate.sql); params.push(...predicate.params); }
    if (status) { where.push('po.status = ?'); params.push(status); }
    if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
    if (dateFrom) { where.push('po.order_date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('po.order_date <= ?'); params.push(dateTo); }
    where.push(notInBin('purchase_order', 'po.id'));
    const whereSql = `WHERE ${where.join(' AND ')}`;

    // The supplier join is part of the filter now, so the count and the summary
    // must be built over the same joined shape as the page.
    const joins = `
      JOIN suppliers s  ON s.id = po.supplier_id
      JOIN warehouses w ON w.id = po.warehouse_id
      LEFT JOIN users u ON u.id = po.created_by`;
    const total = (await this.db.prepare(`
      SELECT COUNT(*) AS n FROM purchase_orders po ${joins} ${whereSql}
    `).get(...params)).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);

    const reason = predicate
      ? matchReasonColumns(search, {
        alias: 'po', ...this.productScope,
        documentSql: predicate.documentSql, documentParams: predicate.documentParams,
        scoped: predicate.scoped,
      })
      : null;
    const rank = predicate ? this.searchRank(search, { alias: 'po' }) : null;
    const orderSql = rank ? `ORDER BY ${rank.sql}, po.id DESC` : 'ORDER BY po.id DESC';

    const rows = await this.db.prepare(`
      SELECT po.*, s.name_en AS supplier_name, s.name_ar AS supplier_name_ar,
             w.name_en AS warehouse_name, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS line_count
             ${reason ? `, ${reason.sql}` : ''}
      FROM purchase_orders po ${joins}
      ${whereSql}
      ${orderSql} LIMIT ? OFFSET ?
    `).all(...(reason ? reason.params : []), ...params, ...(rank ? rank.params : []),
      size, (current - 1) * size);

    const summary = await this.db.prepare(`
      SELECT COALESCE(SUM(po.total_amount),0) AS total_value,
             COALESCE(SUM(po.total_amount - po.paid_amount),0) AS outstanding
      FROM purchase_orders po ${joins} ${whereSql}
    `).get(...params);

    return { rows, total, summary, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async findAggregate(id) {
    const order = await this.db.prepare(`
      SELECT po.*, s.name_en AS supplier_name, s.name_ar AS supplier_name_ar,
             s.phone AS supplier_phone, s.email AS supplier_email, s.address AS supplier_address,
             w.name_en AS warehouse_name, u.full_name AS created_by_name
      FROM purchase_orders po
      JOIN suppliers s  ON s.id = po.supplier_id
      JOIN warehouses w ON w.id = po.warehouse_id
      LEFT JOIN users u ON u.id = po.created_by
      WHERE po.id = ?
    `).get(id);
    if (!order) return null;
    order.lines = await this.db.prepare(`
      SELECT l.*, vd.sku, vd.barcode, vd.product_name_en, vd.product_name_ar,
             vd.variant_label, vd.unit
      FROM purchase_order_lines l
      JOIN v_variant_details vd ON vd.variant_id = l.variant_id
      WHERE l.purchase_order_id = ? ORDER BY l.id
    `).all(id);
    return order;
  }

  async replaceLines(orderId, lines) {
    await this.db.prepare('DELETE FROM purchase_order_lines WHERE purchase_order_id = ?').run(orderId);
    const insert = this.db.prepare(`
      INSERT INTO purchase_order_lines
        (purchase_order_id, variant_id, quantity_ordered, quantity_received, unit_cost,
         discount_percent, tax_rate, line_total, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) {
      await insert.run(orderId, l.variant_id, l.quantity_ordered, l.quantity_received || 0,
        l.unit_cost, l.discount_percent || 0, l.tax_rate || 0, l.line_total, l.notes || null);
    }
  }

  async lines(orderId) {
    return this.db
      .prepare('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY id')
      .all(orderId);
  }

  async updateLineReceived(lineId, quantityReceived) {
    await this.db.prepare('UPDATE purchase_order_lines SET quantity_received = ? WHERE id = ?')
      .run(quantityReceived, lineId);
  }

  // --------------------------------------------------------------- payments

  /** Every payment ever recorded against an order, newest first, reversals included. */
  async payments(orderId) {
    return this.db.prepare(`
      SELECT p.*, u.full_name AS created_by_name, r.full_name AS reversed_by_name
      FROM purchase_payments p
      LEFT JOIN users u ON u.id = p.created_by
      LEFT JOIN users r ON r.id = p.reversed_by
      WHERE p.purchase_order_id = ?
      ORDER BY p.paid_on DESC, p.id DESC
    `).all(Number(orderId));
  }

  async findPayment(orderId, paymentId) {
    return this.db.prepare(
      'SELECT * FROM purchase_payments WHERE id = ? AND purchase_order_id = ?',
    ).get(Number(paymentId), Number(orderId));
  }

  async insertPayment(orderId, payment) {
    const result = await this.db.prepare(`
      INSERT INTO purchase_payments
        (purchase_order_id, paid_on, amount, method, reference, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(orderId), payment.paid_on, payment.amount, payment.method,
      payment.reference || null, payment.note || null, payment.created_by || null,
    );
    return Number(result.lastInsertRowid);
  }

  async reversePayment(paymentId, { reason, actorId }) {
    await this.db.prepare(`
      UPDATE purchase_payments
         SET status = 'reversed', reversal_reason = ?, reversed_by = ?,
             reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'recorded'
    `).run(reason || null, actorId || null, Number(paymentId));
  }

  /**
   * Bring the order's running total back in step with its payment rows.
   *
   * One statement, and that is the whole point: the new total is computed by
   * the DATABASE from the rows as they stand at this instant, never read into
   * JavaScript, added to and written back. Two payments recorded at the same
   * moment therefore cannot lose each other — whichever commits second sums
   * both. Returns the value it wrote so the caller can check it against the
   * order total without a second read.
   */
  async recomputePaid(orderId) {
    await this.db.prepare(`
      UPDATE purchase_orders
         SET paid_amount = ROUND((
               SELECT COALESCE(SUM(amount), 0) FROM purchase_payments
               WHERE purchase_order_id = ? AND status = 'recorded'
             ), 2),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?
    `).run(Number(orderId), Number(orderId));
    const row = await this.db.prepare('SELECT paid_amount FROM purchase_orders WHERE id = ?')
      .get(Number(orderId));
    return Number(row?.paid_amount || 0);
  }

  /** How many payments an order carries at all — a draft with one cannot be deleted. */
  async countPayments(orderId) {
    const row = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM purchase_payments WHERE purchase_order_id = ?',
    ).get(Number(orderId));
    return Number(row?.n || 0);
  }
}
