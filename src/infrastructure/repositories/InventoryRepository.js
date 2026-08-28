/**
 * Inventory persistence: balances (stock_levels), the immutable ledger
 * (stock_movements), transfers and adjustments.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';
import {
  VARIANT_DETAIL_ROW, likeParam, matchReasonColumns, normaliseTerm, rankExpression,
  rowExact, rowMatch,
} from '../database/productSearch.js';
import { notInBin } from '../../shared/trashFilter.js';

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

  /**
   * Hold stock without moving it, or give the hold back (`delta` is signed).
   *
   * Deliberately separate from `setLevel`/`recordMovement`: a reservation is a
   * promise, not a movement. The goods are still on the shelf, so `quantity`
   * must not change and no ledger row may be written — a web order that posted
   * a movement would take the shop's takings out of step with its stock before
   * anybody had picked anything.
   *
   * Clamped at zero so a double release can never leave the balance negative
   * and quietly make unsellable stock look available.
   */
  async adjustReserved(variantId, warehouseId, delta) {
    await this.ensureLevel(variantId, warehouseId);
    await this.db.prepare(`
      UPDATE stock_levels
         SET reserved_quantity = MAX(ROUND(reserved_quantity + ?, 3), 0), updated_at = ?
       WHERE variant_id = ? AND warehouse_id = ?
    `).run(Number(delta), new Date().toISOString(), variantId, warehouseId);
    return this.getLevel(variantId, warehouseId);
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
    const term = normaliseTerm(search);
    if (term) {
      // The same rule POS uses. The view now also carries the product's own
      // code, so typing a product code here finds every variant under it.
      const match = rowMatch(term, '', VARIANT_DETAIL_ROW);
      where.push(match.sql);
      params.push(...match.params);
    }
    if (lowStockOnly) where.push('quantity <= reorder_level AND reorder_level > 0');
    if (zeroStock === 'hide') where.push('quantity <> 0');
    if (zeroStock === 'only') where.push('quantity = 0');
    where.push('variant_active = 1');

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM v_stock_on_hand ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 1000);
    const current = Math.max(Number(page) || 1, 1);
    const rank = term ? rankExpression(rowExact(term, '', VARIANT_DETAIL_ROW)) : null;
    const orderSql = rank
      ? `ORDER BY ${rank.sql}, product_name_en, variant_label`
      : 'ORDER BY product_name_en, variant_label';
    const rows = await this.db.prepare(`
      SELECT * FROM v_stock_on_hand ${whereSql}
      ${orderSql} LIMIT ? OFFSET ?
    `).all(...params, ...(rank ? rank.params : []), size, (current - 1) * size);

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

  /**
   * The ledger. `search` answers "where does this thing appear?" — the question
   * somebody standing at the counter with the product in one hand actually has.
   * A movement row already names its product, so it needs no match explanation:
   * either the reference number matched or the product on the row did, and both
   * are visible in the row itself.
   */
  async movements({ search = '', variantId, warehouseId, movementType, dateFrom, dateTo,
    page = 1, pageSize = 50 }) {
    const where = ['1 = 1'];
    const params = [];
    const term = normaliseTerm(search);
    if (term) {
      const match = rowMatch(term, 'vd', VARIANT_DETAIL_ROW);
      where.push(`(m.reference_no LIKE ? ESCAPE '\\' OR ${match.sql})`);
      params.push(likeParam(term), ...match.params);
    }
    if (variantId) { where.push('m.variant_id = ?'); params.push(variantId); }
    if (warehouseId) { where.push('m.warehouse_id = ?'); params.push(warehouseId); }
    if (movementType) { where.push('m.movement_type = ?'); params.push(movementType); }
    if (dateFrom) { where.push('m.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('m.created_at <= ?'); params.push(`${dateTo}T23:59:59Z`); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    // The count has to see the same join the page does, now that the filter can
    // name a column that only exists on the joined view.
    const total = (await this.db.prepare(`
      SELECT COUNT(*) AS n FROM stock_movements m
      JOIN v_variant_details vd ON vd.variant_id = m.variant_id
      ${whereSql}
    `).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const rank = term
      ? rankExpression({
        sql: `(m.reference_no = ? COLLATE NOCASE OR ${rowExact(term, 'vd', VARIANT_DETAIL_ROW).sql})`,
        params: [normaliseTerm(term), ...rowExact(term, 'vd', VARIANT_DETAIL_ROW).params],
      })
      : null;
    const orderSql = rank
      ? `ORDER BY ${rank.sql}, m.created_at DESC, m.id DESC`
      : 'ORDER BY m.created_at DESC, m.id DESC';
    const rows = await this.db.prepare(`
      SELECT m.*, vd.sku, vd.product_name_en, vd.product_name_ar, vd.variant_label,
             w.name_en AS warehouse_name_en, u.full_name AS user_name
      FROM stock_movements m
      JOIN v_variant_details vd ON vd.variant_id = m.variant_id
      JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN users u ON u.id = m.created_by
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, ...(rank ? rank.params : []), size, (current - 1) * size);
    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  /**
   * What the shop is holding, in one place, so no two screens can disagree
   * about it.
   *
   * They did. The home screen summed the whole stock view; the valuation report
   * and the stock grid both added `variant_active = 1` to their own copy of the
   * question. A shop with nine pieces on a variant somebody had switched off
   * read 682 units and EGP 108,005 on the home screen and 673 units and EGP
   * 107,195 on the report - the same shelf, two answers, and no way to tell
   * from either screen which was wrong.
   *
   * The rule is now one rule, and it is the one that matches the shelf: stock
   * that EXISTS is counted, whether or not the variant is still being sold. A
   * variant is switched off to stop selling it, not to stop owning it, and
   * money that stops being counted when a checkbox is unticked is money that
   * goes missing quietly. What was hidden is now named instead: `stopped` says
   * how much of the total is sitting on switched-off variants, so the number
   * can be explained rather than just reconciled.
   */
  async valuation({
    warehouseId = null, brandId = null, categoryId = null, hideZero = false, onlyStopped = false,
  } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (warehouseId) { where.push('warehouse_id = ?'); params.push(warehouseId); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    if (categoryId) { where.push('category_id = ?'); params.push(categoryId); }
    if (hideZero) where.push('quantity <> 0');
    if (onlyStopped) where.push('variant_active = 0');

    return this.db.prepare(`
      SELECT
        COUNT(*)                                    AS items,
        COALESCE(SUM(quantity), 0)                  AS quantity,
        COALESCE(SUM(stock_value), 0)               AS stock_value,
        COALESCE(SUM(ROUND(quantity * selling_price, 2)), 0) AS retail_value,
        COALESCE(SUM(CASE WHEN variant_active = 0 THEN quantity END), 0)    AS stopped_quantity,
        COALESCE(SUM(CASE WHEN variant_active = 0 THEN stock_value END), 0) AS stopped_value,
        COALESCE(SUM(CASE WHEN quantity <= 0 THEN 1 END), 0)                AS out_of_stock,
        COALESCE(SUM(CASE WHEN reorder_level > 0 AND quantity > 0
                           AND quantity <= reorder_level THEN 1 END), 0)    AS low_stock
      FROM v_stock_on_hand
      WHERE ${where.join(' AND ')}
    `).get(...params);
  }

  /** The home screen's tile. Kept as a name because half the code says it. */
  async totalStockValue(warehouseId = null) {
    const row = await this.valuation({ warehouseId });
    return { v: row.stock_value, q: row.quantity, stopped: row.stopped_value, stoppedQuantity: row.stopped_quantity };
  }

  /** Every line behind that figure, for the valuation report and its CSV. */
  async valuationRows({
    warehouseId = null, brandId = null, categoryId = null, hideZero = true, onlyStopped = false,
  } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (warehouseId) { where.push('warehouse_id = ?'); params.push(warehouseId); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    if (categoryId) { where.push('category_id = ?'); params.push(categoryId); }
    if (hideZero) where.push('quantity <> 0');
    if (onlyStopped) where.push('variant_active = 0');
    return this.db.prepare(`
      SELECT *,
             ROUND(quantity * selling_price, 2) AS retail_value,
             -- A code, not a sentence: the browser knows which language to
             -- print it in and the server does not.
             CASE WHEN variant_active = 1 THEN 'active_variant' ELSE 'stopped_variant' END AS variant_state
      FROM v_stock_on_hand
      WHERE ${where.join(' AND ')}
      ORDER BY stock_value DESC
    `).all(...params);
  }
}

export class StockAdjustmentRepository extends BaseRepository {
  constructor() {
    super({
      table: 'stock_adjustments',
      columns: ['adjustment_no', 'warehouse_id', 'reason', 'status', 'notes',
        'created_by', 'posted_by', 'posted_at'],
      searchable: ['adjustment_no', 'notes'],
      // A stock count is a document about products, so it can be found by the
      // products it counted — which is exactly how somebody holding the item
      // asks "was this counted, and what did we say it was?".
      productScope: { table: 'stock_adjustment_lines', key: 'adjustment_id' },
      timestamps: false,
    });
  }

  /**
   * What the shop LOST, in money, over a window — الهدر.
   *
   * A bottle knocked off the counter, a watch that stopped, a piece that walked
   * out of the door. The stock went down and the shop's own money went with it,
   * and until this existed the second half of that sentence appeared nowhere:
   * a damage adjustment reduced the stock value and no report, tile or profit
   * figure ever mentioned it again. The goods were gone and the books said the
   * shop had had a good month.
   *
   * Counted here: POSTED adjustments only — a draft has not happened yet — with
   * a reason that means loss rather than bookkeeping, and only lines where the
   * stock went DOWN. `correction` and `stock_take` are deliberately excluded:
   * a miscount found and fixed is not a loss, it is an error being corrected,
   * and treating it as waste would turn every stock count into a fake disaster.
   */
  async wastageTotals({ dateFrom, dateTo, warehouseId } = {}) {
    const where = [
      "a.status = 'posted'",
      "a.reason IN ('damage', 'loss', 'theft', 'expiry')",
      'l.difference < 0',
    ];
    const params = [];
    // `posted_at` and not `created_at`: the loss lands in the month it was
    // accepted, which is the same rule every other document here follows.
    if (dateFrom) { where.push('date(a.posted_at) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(a.posted_at) <= date(?)'); params.push(dateTo); }
    if (warehouseId) { where.push('a.warehouse_id = ?'); params.push(warehouseId); }

    const row = await this.db.prepare(`
      SELECT COALESCE(SUM(-l.difference * l.unit_cost), 0) AS value,
             COALESCE(SUM(-l.difference), 0) AS units,
             COUNT(DISTINCT a.id) AS documents
      FROM stock_adjustment_lines l
      JOIN stock_adjustments a ON a.id = l.adjustment_id
      WHERE ${where.join(' AND ')}
    `).get(...params);
    return { value: row.value, units: row.units, documents: row.documents };
  }

  /**
   * The documents behind the wastage figure, newest first.
   *
   * One row per adjustment rather than per line, because that is the unit a
   * person recognises: "the four bottles Hoda wrote off on Tuesday".
   */
  async wastageDocuments({ dateFrom, dateTo, warehouseId, limit = 100 } = {}) {
    const where = [
      "a.status = 'posted'",
      "a.reason IN ('damage', 'loss', 'theft', 'expiry')",
    ];
    const params = [];
    if (dateFrom) { where.push('date(a.posted_at) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(a.posted_at) <= date(?)'); params.push(dateTo); }
    if (warehouseId) { where.push('a.warehouse_id = ?'); params.push(warehouseId); }

    return this.db.prepare(`
      SELECT a.id            AS id,
             a.adjustment_no AS adjustment_no,
             a.reason        AS reason,
             a.posted_at     AS posted_at,
             a.notes         AS notes,
             u.full_name     AS posted_by_name,
             (SELECT ROUND(SUM(-l.difference), 3) FROM stock_adjustment_lines l
               WHERE l.adjustment_id = a.id AND l.difference < 0) AS units,
             (SELECT ROUND(SUM(-l.difference * l.unit_cost), 2) FROM stock_adjustment_lines l
               WHERE l.adjustment_id = a.id AND l.difference < 0) AS value,
             (SELECT GROUP_CONCAT(v.sku, ', ') FROM stock_adjustment_lines l
                JOIN product_variants v ON v.id = l.variant_id
               WHERE l.adjustment_id = a.id AND l.difference < 0) AS items
      FROM stock_adjustments a
      LEFT JOIN users u ON u.id = a.posted_by
      WHERE ${where.join(' AND ')}
      ORDER BY a.posted_at DESC, a.id DESC
      LIMIT ?
    `).all(...params, Math.min(Number(limit) || 100, 500));
  }

  /** The same loss, split by what caused it — broken, lost, stolen, expired. */
  async wastageByReason({ dateFrom, dateTo, warehouseId } = {}) {
    const where = [
      "a.status = 'posted'",
      "a.reason IN ('damage', 'loss', 'theft', 'expiry')",
      'l.difference < 0',
    ];
    const params = [];
    if (dateFrom) { where.push('date(a.posted_at) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(a.posted_at) <= date(?)'); params.push(dateTo); }
    if (warehouseId) { where.push('a.warehouse_id = ?'); params.push(warehouseId); }
    return this.db.prepare(`
      SELECT a.reason AS reason,
             ROUND(SUM(-l.difference * l.unit_cost), 2) AS value,
             ROUND(SUM(-l.difference), 2) AS units
      FROM stock_adjustment_lines l
      JOIN stock_adjustments a ON a.id = l.adjustment_id
      WHERE ${where.join(' AND ')}
      GROUP BY a.reason
      ORDER BY value DESC
    `).all(...params);
  }

  async listDetailed({ search = '', status, page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    const predicate = this.searchPredicate(search, { alias: 'a' });
    if (predicate) { where.push(predicate.sql); params.push(...predicate.params); }
    if (status) { where.push('a.status = ?'); params.push(status); }
    where.push(notInBin('stock_adjustment', 'a.id'));
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM stock_adjustments a ${whereSql}`).get(...params)).n;
    const size = Number(pageSize) || 25;
    const current = Math.max(Number(page) || 1, 1);

    const reason = predicate
      ? matchReasonColumns(search, {
        alias: 'a', ...this.productScope,
        documentSql: predicate.documentSql, documentParams: predicate.documentParams,
        scoped: predicate.scoped,
      })
      : null;
    const rank = predicate ? this.searchRank(search, { alias: 'a' }) : null;
    const orderSql = rank ? `ORDER BY ${rank.sql}, a.id DESC` : 'ORDER BY a.id DESC';

    const rows = await this.db.prepare(`
      SELECT a.*, w.name_en AS warehouse_name, u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS line_count,
             (SELECT COALESCE(SUM(difference * unit_cost),0) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS value_impact
             ${reason ? `, ${reason.sql}` : ''}
      FROM stock_adjustments a
      JOIN warehouses w ON w.id = a.warehouse_id
      LEFT JOIN users u ON u.id = a.created_by
      ${whereSql}
      ${orderSql} LIMIT ? OFFSET ?
    `).all(...(reason ? reason.params : []), ...params, ...(rank ? rank.params : []),
      size, (current - 1) * size);
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
