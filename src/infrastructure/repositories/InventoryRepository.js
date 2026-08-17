/**
 * Inventory persistence: balances (stock_levels), the immutable ledger
 * (stock_movements), transfers and adjustments.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';

export class InventoryRepository {
  get db() {
    return getDb();
  }

  async getLevel(variantId, warehouseId) {
    return (await this.db
      .prepare('SELECT * FROM stock_levels WHERE variant_id = ? AND warehouse_id = ?')
      .get(variantId, warehouseId)) || null;
  }

  async ensureLevel(variantId, warehouseId) {
    const existing = await this.getLevel(variantId, warehouseId);
    if (existing) return existing;
    await this.db.prepare(`
      INSERT INTO stock_levels (variant_id, warehouse_id, quantity, reserved_quantity, average_cost)
      VALUES (?, ?, 0, 0, (SELECT cost_price FROM product_variants WHERE id = ?))
    `).run(variantId, warehouseId, variantId);
    return this.getLevel(variantId, warehouseId);
  }

  async setLevel(variantId, warehouseId, { quantity, averageCost }) {
    await this.db.prepare(`
      UPDATE stock_levels
         SET quantity = ?, average_cost = ?, updated_at = ?
       WHERE variant_id = ? AND warehouse_id = ?
    `).run(quantity, averageCost, new Date().toISOString(), variantId, warehouseId);
  }

  async recordMovement(movement) {
    const info = await this.db.prepare(`
      INSERT INTO stock_movements
        (variant_id, warehouse_id, movement_type, quantity, unit_cost, balance_after,
         reference_type, reference_id, reference_no, notes, created_by)
      VALUES (@variant_id, @warehouse_id, @movement_type, @quantity, @unit_cost, @balance_after,
              @reference_type, @reference_id, @reference_no, @notes, @created_by)
    `).run({
      reference_type: null, reference_id: null, reference_no: null, notes: null,
      created_by: null, unit_cost: 0, ...movement,
    });
    return info.lastInsertRowid;
  }

  /** Stock-on-hand grid with filters. Backed by the v_stock_on_hand view. */
  async stockOnHand({ search = '', warehouseId, brandId, categoryId, lowStockOnly = false,
    zeroStock = 'all', page = 1, pageSize = 50 }) {
    const where = ['1 = 1'];
    const params = [];
    if (warehouseId) { where.push('warehouse_id = ?'); params.push(warehouseId); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    if (categoryId) { where.push('category_id = ?'); params.push(categoryId); }
    if (search) {
      where.push('(sku LIKE ? OR barcode LIKE ? OR product_name_en LIKE ? OR product_name_ar LIKE ? OR variant_label LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (lowStockOnly) where.push('quantity <= reorder_level AND reorder_level > 0');
    if (zeroStock === 'hide') where.push('quantity <> 0');
    if (zeroStock === 'only') where.push('quantity = 0');
    where.push('variant_active = 1');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM v_stock_on_hand ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 1000);
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db.prepare(`
      SELECT * FROM v_stock_on_hand ${whereSql}
      ORDER BY product_name_en, variant_label LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    const totals = await this.db.prepare(`
      SELECT COALESCE(SUM(quantity),0) AS total_qty, COALESCE(SUM(stock_value),0) AS total_value
      FROM v_stock_on_hand ${whereSql}
    `).get(...params);

    return { rows, total, totals, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async lowStock(warehouseId = null, limit = 100) {
    const params = [];
    let sql = `
      SELECT * FROM v_stock_on_hand
      WHERE reorder_level > 0 AND quantity <= reorder_level AND variant_active = 1
    `;
    if (warehouseId) { sql += ' AND warehouse_id = ?'; params.push(warehouseId); }
    sql += ' ORDER BY (quantity - reorder_level) ASC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  async movements({ variantId, warehouseId, movementType, dateFrom, dateTo, page = 1, pageSize = 50 }) {
    const where = ['1 = 1'];
    const params = [];
    if (variantId) { where.push('m.variant_id = ?'); params.push(variantId); }
    if (warehouseId) { where.push('m.warehouse_id = ?'); params.push(warehouseId); }
    if (movementType) { where.push('m.movement_type = ?'); params.push(movementType); }
    if (dateFrom) { where.push('m.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('m.created_at <= ?'); params.push(`${dateTo}T23:59:59Z`); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM stock_movements m ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db.prepare(`
      SELECT m.*, vd.sku, vd.product_name_en, vd.product_name_ar, vd.variant_label,
             w.name_en AS warehouse_name_en, u.full_name AS user_name
      FROM stock_movements m
      JOIN v_variant_details vd ON vd.variant_id = m.variant_id
      JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN users u ON u.id = m.created_by
      ${whereSql}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);
    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async totalStockValue(warehouseId = null) {
    const sql = warehouseId
      ? 'SELECT COALESCE(SUM(stock_value),0) AS v, COALESCE(SUM(quantity),0) AS q FROM v_stock_on_hand WHERE warehouse_id = ?'
      : 'SELECT COALESCE(SUM(stock_value),0) AS v, COALESCE(SUM(quantity),0) AS q FROM v_stock_on_hand';
    return warehouseId ? this.db.prepare(sql).get(warehouseId) : this.db.prepare(sql).get();
  }
}

export class StockAdjustmentRepository extends BaseRepository {
  constructor() {
    super({
      table: 'stock_adjustments',
      columns: ['adjustment_no', 'warehouse_id', 'reason', 'status', 'notes',
        'created_by', 'posted_by', 'posted_at'],
      searchable: ['adjustment_no', 'notes'],
      timestamps: false,
    });
  }

  async listDetailed({ status, page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (status) { where.push('a.status = ?'); params.push(status); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM stock_adjustments a ${whereSql}`).get(...params)).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db.prepare(`
      SELECT a.*, w.name_en AS warehouse_name, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS line_count,
             (SELECT COALESCE(SUM(difference * unit_cost),0) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS value_impact
      FROM stock_adjustments a
      JOIN warehouses w ON w.id = a.warehouse_id
      LEFT JOIN users u ON u.id = a.created_by
      ${whereSql}
      ORDER BY a.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);
    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async findAggregate(id) {
    const adjustment = await this.db.prepare(`
      SELECT a.*, w.name_en AS warehouse_name FROM stock_adjustments a
      JOIN warehouses w ON w.id = a.warehouse_id WHERE a.id = ?
    `).get(id);
    if (!adjustment) return null;
    adjustment.lines = await this.db.prepare(`
      SELECT l.*, vd.sku, vd.product_name_en, vd.product_name_ar, vd.variant_label
      FROM stock_adjustment_lines l
      JOIN v_variant_details vd ON vd.variant_id = l.variant_id
      WHERE l.adjustment_id = ?
    `).all(id);
    return adjustment;
  }

  async replaceLines(adjustmentId, lines) {
    await this.db.prepare('DELETE FROM stock_adjustment_lines WHERE adjustment_id = ?').run(adjustmentId);
    const insert = this.db.prepare(`
      INSERT INTO stock_adjustment_lines
        (adjustment_id, variant_id, system_qty, counted_qty, difference, unit_cost, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) {
      await insert.run(adjustmentId, l.variant_id, l.system_qty, l.counted_qty,
        l.difference, l.unit_cost || 0, l.notes || null);
    }
  }
}
