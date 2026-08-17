/**
 * Product + variant persistence.
 * A "product" is the catalogue entry; a "variant" is the sellable unit that
 * carries the SKU, barcode and price. Reads are denormalised through the
 * v_variant_details view so the UI never has to assemble 5 joins itself.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';

export class ProductRepository extends BaseRepository {
  constructor() {
    super({
      table: 'products',
      columns: [
        'sku_prefix', 'name_en', 'name_ar', 'description_en', 'description_ar',
        'brand_id', 'category_id', 'supplier_id', 'unit', 'tax_rate', 'base_cost',
        'base_price', 'track_inventory', 'image_url', 'tags', 'is_active', 'created_by',
      ],
      searchable: ['sku_prefix', 'name_en', 'name_ar', 'tags'],
    });
  }

  /** Rich list used by the catalogue grid: brand/category names + variant rollups. */
  async search({ search = '', brandId, categoryId, supplierId, isActive, page = 1, pageSize = 25 }) {
    const where = [];
    const params = [];
    if (search) {
      where.push(`(p.name_en LIKE ? OR p.name_ar LIKE ? OR p.sku_prefix LIKE ?
                   OR EXISTS (SELECT 1 FROM product_variants v
                              WHERE v.product_id = p.id AND (v.sku LIKE ? OR v.barcode LIKE ?)))`);
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (brandId) { where.push('p.brand_id = ?'); params.push(brandId); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
    if (supplierId) { where.push('p.supplier_id = ?'); params.push(supplierId); }
    if (isActive !== undefined && isActive !== '') { where.push('p.is_active = ?'); params.push(Number(isActive)); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = getDb();
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
    const current = Math.max(Number(page) || 1, 1);

    const rows = await db.prepare(`
      SELECT p.*,
             b.name_en AS brand_name_en, b.name_ar AS brand_name_ar,
             c.name_en AS category_name_en, c.name_ar AS category_name_ar,
             s.name_en AS supplier_name_en,
             (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
             (SELECT COALESCE(SUM(sl.quantity), 0)
                FROM stock_levels sl
                JOIN product_variants v2 ON v2.id = sl.variant_id
               WHERE v2.product_id = p.id) AS total_stock,
             (SELECT MIN(v3.selling_price) FROM product_variants v3 WHERE v3.product_id = p.id) AS min_price,
             (SELECT MAX(v4.selling_price) FROM product_variants v4 WHERE v4.product_id = p.id) AS max_price
      FROM products p
      LEFT JOIN brands b     ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN suppliers s  ON s.id = p.supplier_id
      ${whereSql}
      ORDER BY p.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  /**
   * Trading history for one product — what the details page needs to answer
   * "is this line working?" without the user opening three reports.
   */
  async performance(productId, days = 90) {
    const db = getDb();
    const since = `-${Number(days) || 90} days`;
    const totals = await db.prepare(`
      SELECT COALESCE(SUM(l.quantity), 0)                              AS units,
             COALESCE(SUM(l.line_total), 0)                            AS revenue,
             COALESCE(SUM(l.quantity * l.unit_cost), 0)                AS cost,
             COALESCE(SUM(l.line_total - l.quantity * l.unit_cost), 0) AS profit,
             COUNT(DISTINCT s.id)                                      AS invoices
      FROM sale_lines l
      JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
      JOIN product_variants v ON v.id = l.variant_id
      WHERE v.product_id = ? AND s.sale_date >= datetime('now', ?)
    `).get(productId, since);

    const lifetime = await db.prepare(`
      SELECT COALESCE(SUM(l.quantity), 0) AS units,
             MAX(s.sale_date)             AS last_sold,
             MIN(s.sale_date)             AS first_sold,
             COALESCE(SUM(l.returned_quantity), 0) AS returned_units
      FROM sale_lines l
      JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
      JOIN product_variants v ON v.id = l.variant_id
      WHERE v.product_id = ?
    `).get(productId);

    return {
      ...totals,
      margin_percent: totals.revenue > 0
        ? Math.round((totals.profit / totals.revenue) * 10000) / 100
        : 0,
      windowDays: Number(days) || 90,
      last_sold: lifetime.last_sold,
      first_sold: lifetime.first_sold,
      lifetime_units: lifetime.units,
      returned_units: lifetime.returned_units,
    };
  }

  /** Per-variant stock and valuation for the details page. */
  async variantStock(productId) {
    return getDb().prepare(`
      SELECT variant_id, quantity, available_quantity, average_cost, stock_value
      FROM v_stock_on_hand WHERE product_id = ?
    `).all(productId);
  }

  async salesHistory(productId, limit = 15) {
    return getDb().prepare(`
      SELECT s.id AS sale_id, s.invoice_no, s.sale_date, s.status,
             COALESCE(c.name, 'Walk-in') AS customer_name,
             l.sku, l.description, l.quantity, l.returned_quantity, l.unit_price, l.line_total
      FROM sale_lines l
      JOIN sales s ON s.id = l.sale_id
      LEFT JOIN customers c ON c.id = s.customer_id
      JOIN product_variants v ON v.id = l.variant_id
      WHERE v.product_id = ?
      ORDER BY s.sale_date DESC LIMIT ?
    `).all(productId, limit);
  }

  async purchaseHistory(productId, limit = 15) {
    return getDb().prepare(`
      SELECT po.id AS purchase_order_id, po.po_number, po.order_date, po.status,
             sup.name_en AS supplier_name,
             l.quantity_ordered, l.quantity_received, l.unit_cost,
             v.sku
      FROM purchase_order_lines l
      JOIN purchase_orders po ON po.id = l.purchase_order_id
      JOIN suppliers sup ON sup.id = po.supplier_id
      JOIN product_variants v ON v.id = l.variant_id
      WHERE v.product_id = ?
      ORDER BY po.order_date DESC LIMIT ?
    `).all(productId, limit);
  }

  async movementHistory(productId, limit = 25) {
    return getDb().prepare(`
      SELECT m.*, v.sku, v.variant_label, u.full_name AS user_name
      FROM stock_movements m
      JOIN product_variants v ON v.id = m.variant_id
      LEFT JOIN users u ON u.id = m.created_by
      WHERE v.product_id = ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?
    `).all(productId, limit);
  }

  async returnHistory(productId, limit = 15) {
    return getDb().prepare(`
      SELECT r.id AS return_id, r.return_no, r.return_date, r.reason_code,
             rl.sku, rl.quantity, rl.condition, rl.line_total
      FROM sales_return_lines rl
      JOIN sales_returns r ON r.id = rl.return_id
      JOIN product_variants v ON v.id = rl.variant_id
      WHERE v.product_id = ?
      ORDER BY r.return_date DESC LIMIT ?
    `).all(productId, limit);
  }

  /** Full aggregate: product + declared attributes + variants + their option values. */
  async findAggregate(productId) {
    const db = getDb();
    const product = await db.prepare(`
      SELECT p.*, b.name_en AS brand_name_en, c.name_en AS category_name_en,
             s.name_en AS supplier_name_en
      FROM products p
      LEFT JOIN brands b     ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN suppliers s  ON s.id = p.supplier_id
      WHERE p.id = ?
    `).get(productId);
    if (!product) return null;

    product.attributes = await db.prepare(`
      SELECT a.*, pa.display_order AS product_display_order
      FROM product_attributes pa
      JOIN attributes a ON a.id = pa.attribute_id
      WHERE pa.product_id = ?
      ORDER BY pa.display_order, a.display_order
    `).all(productId);

    const variants = await db.prepare(`
      SELECT v.*,
             (SELECT COALESCE(SUM(quantity), 0) FROM stock_levels sl WHERE sl.variant_id = v.id) AS total_stock
      FROM product_variants v WHERE v.product_id = ? ORDER BY v.id
    `).all(productId);

    const optionRows = await db.prepare(`
      SELECT vav.variant_id, vav.attribute_id, vav.attribute_value_id,
             a.code AS attribute_code, a.name_en AS attribute_name_en, a.name_ar AS attribute_name_ar,
             av.value_en, av.value_ar, av.color_hex
      FROM variant_attribute_values vav
      JOIN attributes a       ON a.id  = vav.attribute_id
      JOIN attribute_values av ON av.id = vav.attribute_value_id
      WHERE vav.variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)
    `).all(productId);

    product.variants = variants.map((v) => ({
      ...v,
      options: optionRows.filter((o) => o.variant_id === v.id),
    }));
    return product;
  }
}

export class VariantRepository extends BaseRepository {
  constructor() {
    super({
      table: 'product_variants',
      columns: [
        'product_id', 'sku', 'barcode', 'variant_label', 'cost_price', 'selling_price',
        'wholesale_price', 'reorder_level', 'reorder_quantity', 'weight_grams',
        'image_url', 'is_active',
      ],
      searchable: ['sku', 'barcode', 'variant_label'],
    });
  }

  async byProduct(productId) {
    return this.db
      .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id')
      .all(productId);
  }

  async details(variantId) {
    return (await getDb().prepare('SELECT * FROM v_variant_details WHERE variant_id = ?').get(variantId)) || null;
  }

  /** Barcode/QR lookup for the scanner. Falls back to SKU so typed codes work too. */
  async findByCode(code) {
    return (await getDb().prepare(`
      SELECT * FROM v_variant_details
      WHERE barcode = ? OR sku = ? COLLATE NOCASE
      LIMIT 1
    `).get(code, code)) || null;
  }

  /** Type-ahead used by POS, purchase orders, transfers and label printing. */
  async lookup(term, limit = 20, warehouseId = null) {
    const like = `%${term}%`;
    if (warehouseId) {
      return getDb().prepare(`
        SELECT vd.*, COALESCE(sl.quantity, 0) AS quantity
        FROM v_variant_details vd
        LEFT JOIN stock_levels sl ON sl.variant_id = vd.variant_id AND sl.warehouse_id = ?
        WHERE vd.variant_active = 1 AND vd.product_active = 1
          AND (vd.sku LIKE ? OR vd.barcode LIKE ? OR vd.product_name_en LIKE ?
               OR vd.product_name_ar LIKE ? OR vd.variant_label LIKE ?)
        ORDER BY vd.product_name_en LIMIT ?
      `).all(warehouseId, like, like, like, like, like, limit);
    }
    return getDb().prepare(`
      SELECT vd.*, (SELECT COALESCE(SUM(quantity),0) FROM stock_levels sl WHERE sl.variant_id = vd.variant_id) AS quantity
      FROM v_variant_details vd
      WHERE vd.variant_active = 1 AND vd.product_active = 1
        AND (vd.sku LIKE ? OR vd.barcode LIKE ? OR vd.product_name_en LIKE ?
             OR vd.product_name_ar LIKE ? OR vd.variant_label LIKE ?)
      ORDER BY vd.product_name_en LIMIT ?
    `).all(like, like, like, like, like, limit);
  }

  async replaceOptions(variantId, options) {
    const db = getDb();
    await db.prepare('DELETE FROM variant_attribute_values WHERE variant_id = ?').run(variantId);
    const insert = db.prepare(`
      INSERT INTO variant_attribute_values (variant_id, attribute_id, attribute_value_id)
      VALUES (?, ?, ?)
    `);
    for (const option of options) {
      await insert.run(variantId, option.attribute_id, option.attribute_value_id);
    }
  }

  async isReferenced(variantId) {
    const db = getDb();
    const queries = [
      'SELECT 1 FROM sale_lines WHERE variant_id = ? LIMIT 1',
      'SELECT 1 FROM purchase_order_lines WHERE variant_id = ? LIMIT 1',
      'SELECT 1 FROM stock_movements WHERE variant_id = ? LIMIT 1',
    ];
    // `some()` cannot await, and the loop keeps the original short-circuit:
    // the first hit answers the question without running the rest.
    for (const sql of queries) {
      if (await db.prepare(sql).get(variantId)) return true;
    }
    return false;
  }
}
