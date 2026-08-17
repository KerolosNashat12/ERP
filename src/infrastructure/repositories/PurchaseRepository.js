/** Purchase order persistence (header + lines). */
import { BaseRepository } from './BaseRepository.js';

export class PurchaseOrderRepository extends BaseRepository {
  constructor() {
    super({
      table: 'purchase_orders',
      columns: [
        'po_number', 'supplier_id', 'warehouse_id', 'status', 'order_date', 'expected_date',
        'subtotal', 'discount_amount', 'tax_amount', 'shipping_amount', 'total_amount',
        'paid_amount', 'notes', 'created_by', 'approved_by', 'approved_at',
      ],
      searchable: ['po_number', 'notes'],
    });
  }

  async listDetailed({ search = '', status, supplierId, dateFrom, dateTo, page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (search) { where.push('po.po_number LIKE ?'); params.push(`%${search}%`); }
    if (status) { where.push('po.status = ?'); params.push(status); }
    if (supplierId) { where.push('po.supplier_id = ?'); params.push(supplierId); }
    if (dateFrom) { where.push('po.order_date >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('po.order_date <= ?'); params.push(dateTo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders po ${whereSql}`).get(...params)).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db.prepare(`
      SELECT po.*, s.name_en AS supplier_name, s.name_ar AS supplier_name_ar,
             w.name_en AS warehouse_name, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS line_count
      FROM purchase_orders po
      JOIN suppliers s  ON s.id = po.supplier_id
      JOIN warehouses w ON w.id = po.warehouse_id
      LEFT JOIN users u ON u.id = po.created_by
      ${whereSql}
      ORDER BY po.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    const summary = await this.db.prepare(`
      SELECT COALESCE(SUM(po.total_amount),0) AS total_value,
             COALESCE(SUM(po.total_amount - po.paid_amount),0) AS outstanding
      FROM purchase_orders po ${whereSql}
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
}
