/**
 * Product + variant persistence.
 * A "product" is the catalogue entry; a "variant" is the sellable unit that
 * carries the SKU, barcode and price. Reads are denormalised through the
 * v_variant_details view so the UI never has to assemble 5 joins itself.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';
import { notInBin } from '../../shared/trashFilter.js';
import {
  VARIANT_DETAIL_ROW, normaliseTerm, productExact, productMatch, rankExpression, rowExact, rowMatch,
} from '../database/productSearch.js';

export class ProductRepository extends BaseRepository {
  constructor() {
    super({
      table: 'products',
      trashType: 'product',
      columns: [
        'sku_prefix', 'name_en', 'name_ar', 'description_en', 'description_ar',
        'brand_id', 'category_id', 'supplier_id', 'unit', 'tax_rate', 'base_cost',
        'base_price', 'track_inventory', 'image_url', 'tags', 'is_active', 'created_by',
        // Website: anything missing from this list is silently dropped by
        // BaseRepository.pick(), so a new column has to be added here as well
        // as to the schema — the save simply ignores it otherwise.
        'is_published', 'published_at', 'web_description_en', 'web_description_ar',
        'primary_image_id',
        // Who the piece is for, and the offer on it. Same rule as the line
        // above: absent from this list means silently dropped on save.
        'gender', 'discount_type', 'discount_value',
        'discount_starts_on', 'discount_ends_on',
      ],
      searchable: ['sku_prefix', 'name_en', 'name_ar', 'tags'],
    });
  }

  /**
   * Rich list used by the catalogue grid: brand/category names + variant rollups.
   *
   * The search half is `productMatch` — the one shared rule — so a barcode or a
   * variant's SKU finds the product that owns it, and it does so through an
   * `EXISTS` in SQL rather than by pulling rows into JavaScript to sift them.
   */
  /**
   * The WHERE behind both the products grid and the counters above it.
   *
   * They have to be one function. A summary that counts something the list
   * below it is not showing is worse than no summary at all - the owner filters
   * to one brand, the cards go on describing the whole shop, and the two
   * numbers on the same screen quietly contradict each other.
   */
  #scope({
    search = '', brandId, categoryId, supplierId, isActive, gender, onOffer,
  } = {}) {
    const where = [];
    const params = [];
    const term = normaliseTerm(search);
    if (term) {
      const match = productMatch(term, 'p');
      where.push(match.sql);
      params.push(...match.params);
    }
    if (brandId) { where.push('p.brand_id = ?'); params.push(brandId); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
    if (supplierId) { where.push('p.supplier_id = ?'); params.push(supplierId); }
    if (isActive !== undefined && isActive !== '') { where.push('p.is_active = ?'); params.push(Number(isActive)); }
    if (gender) { where.push('p.gender = ?'); params.push(String(gender)); }
    /*
     * "Show me what is on offer" - running TODAY, not merely configured. The
     * same four conditions the storefront asks, because a shopkeeper checking
     * his own offers and a shopper browsing them must be looking at one list.
     */
    if (onOffer === '1' || onOffer === 1 || onOffer === true) {
      where.push(`p.discount_type <> 'none' AND p.discount_value > 0
        AND (p.discount_starts_on IS NULL OR date(p.discount_starts_on) <= date('now'))
        AND (p.discount_ends_on   IS NULL OR date(p.discount_ends_on)   >= date('now'))`);
    }
    /*
     * The catalogue screen has its own SELECT - brand, category, supplier,
     * variant count, stock, price range - so it does NOT go through
     * `BaseRepository.list` and does not inherit its `trashType` filter. It has
     * to say so itself, or a product deleted this morning is still on the
     * products page this afternoon. (It was, and the shop's owner found it.)
     */
    where.push(notInBin('product', 'p.id'));
    return { whereSql: `WHERE ${where.join(' AND ')}`, params, term };
  }

  /**
   * The counters above the products grid: how many, of what, for whom.
   *
   * Written as one pass over the same rows the grid lists rather than eight
   * separate counts - on the hosted database each count is a network round trip,
   * and eight of them to draw a header is how a fast screen becomes a slow one.
   */
  async summary(filters = {}) {
    const { whereSql, params } = this.#scope(filters);
    const row = await getDb().prepare(`
      SELECT
        COUNT(*)                                                        AS products,
        COALESCE(SUM(CASE WHEN p.is_active = 1 THEN 1 END), 0)          AS active,
        COALESCE(SUM(CASE WHEN p.is_active = 0 THEN 1 END), 0)          AS stopped,
        COALESCE(SUM(CASE WHEN p.is_published = 1 THEN 1 END), 0)       AS published,
        COALESCE(SUM(CASE WHEN p.gender = 'women'  THEN 1 END), 0)      AS women,
        COALESCE(SUM(CASE WHEN p.gender = 'men'    THEN 1 END), 0)      AS men,
        COALESCE(SUM(CASE WHEN p.gender IS NULL
                            OR p.gender NOT IN ('women','men') THEN 1 END), 0) AS unisex,
        COALESCE(SUM(CASE WHEN p.discount_type <> 'none' AND p.discount_value > 0
                           AND (p.discount_starts_on IS NULL OR date(p.discount_starts_on) <= date('now'))
                           AND (p.discount_ends_on   IS NULL OR date(p.discount_ends_on)   >= date('now'))
                          THEN 1 END), 0)                               AS on_offer,
        COALESCE(SUM((SELECT COUNT(*) FROM product_variants v
                       WHERE v.product_id = p.id AND v.is_active = 1)), 0) AS variants,
        /*
         * Nothing left on the shelf under this product - the ones that cannot
         * be sold today however good they look on the website.
         *
         * Counted across ALL its variants, not just the ones still switched on,
         * for the same reason the stock valuation is: a piece that exists is a
         * piece the shop has. Counting only active variants would report a
         * product with nine boxes in the back as "out of stock" because
         * somebody unticked a box.
         */
        COALESCE(SUM(CASE WHEN COALESCE((
          SELECT SUM(sl.quantity) FROM stock_levels sl
            JOIN product_variants v ON v.id = sl.variant_id
           WHERE v.product_id = p.id), 0) <= 0 THEN 1 END), 0) AS out_of_stock,
        COALESCE(SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM product_images pi WHERE pi.product_id = p.id) THEN 1 END), 0) AS without_photo
      FROM products p
      ${whereSql}
    `).get(...params);
    return row;
  }

  async search({
    search = '', brandId, categoryId, supplierId, isActive, gender, onOffer,
    page = 1, pageSize = 25,
  }) {
    const { whereSql, params, term } = this.#scope({
      search, brandId, categoryId, supplierId, isActive, gender, onOffer,
    });
    const db = getDb();
    const total = (await db.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
    const current = Math.max(Number(page) || 1, 1);

    // A term that IS a code — a scan, or a number copied off a label — puts its
    // product first, ahead of anything that merely contains the string.
    const rank = term ? rankExpression(productExact(term, 'p')) : null;
    const orderSql = rank ? `ORDER BY ${rank.sql}, p.updated_at DESC` : 'ORDER BY p.updated_at DESC';

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
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, ...(rank ? rank.params : []), size, (current - 1) * size);

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
      WHERE v.product_id = ? AND r.status <> 'reversed'
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

  /**
   * One variant, with everything needed to price it.
   *
   * The offer columns are joined for rather than read off `v_variant_details`,
   * because that view is created before the migrations run and can only name
   * columns that have existed since the baseline (the view itself says so).
   * One extra join on a single-row lookup, and in exchange the till never has
   * to make a second read to find out whether a piece is on offer today.
   */
  async details(variantId) {
    return (await getDb().prepare(`
      SELECT vd.*,
             p.gender             AS gender,
             p.discount_type      AS discount_type,
             p.discount_value     AS discount_value,
             p.discount_starts_on AS discount_starts_on,
             p.discount_ends_on   AS discount_ends_on
      FROM v_variant_details vd
      JOIN products p ON p.id = vd.product_id
      WHERE vd.variant_id = ?
    `).get(variantId)) || null;
  }

  /** Barcode/QR lookup for the scanner. Falls back to SKU so typed codes work too. */
  async findByCode(code) {
    return (await getDb().prepare(`
      SELECT vd.*,
             p.gender             AS gender,
             p.discount_type      AS discount_type,
             p.discount_value     AS discount_value,
             p.discount_starts_on AS discount_starts_on,
             p.discount_ends_on   AS discount_ends_on
      FROM v_variant_details vd
      JOIN products p ON p.id = vd.product_id
      WHERE vd.barcode = ? OR vd.sku = ? COLLATE NOCASE
      LIMIT 1
    `).get(code, code)) || null;
  }

  /**
   * Type-ahead used by POS, purchase orders, transfers and label printing.
   *
   * This is the behaviour the owner expects everywhere, so it is now expressed
   * in the shared predicate rather than in an inline `OR` list that the rest of
   * the system had to imitate from memory. The one change to it: an exact SKU
   * or barcode now sorts to the top instead of being alphabetised among the
   * partial matches.
   */
  async lookup(term, limit = 20, warehouseId = null) {
    const match = rowMatch(term, 'vd', VARIANT_DETAIL_ROW);
    const rank = rankExpression(rowExact(term, 'vd', VARIANT_DETAIL_ROW));
    /*
     * The offer columns ride along here too. The POS picker prices a line the
     * moment it is picked, so if this row did not carry the offer the till
     * would show the list price for as long as it took a second request to come
     * back — and a price that changes after the cashier has read it out is
     * worse than one that was never discounted.
     */
    const offer = `
             p.discount_type      AS discount_type,
             p.discount_value     AS discount_value,
             p.discount_starts_on AS discount_starts_on,
             p.discount_ends_on   AS discount_ends_on`;
    if (warehouseId) {
      return getDb().prepare(`
        SELECT vd.*, COALESCE(sl.quantity, 0) AS quantity,${offer}
        FROM v_variant_details vd
        JOIN products p ON p.id = vd.product_id
        LEFT JOIN stock_levels sl ON sl.variant_id = vd.variant_id AND sl.warehouse_id = ?
        WHERE vd.variant_active = 1 AND vd.product_active = 1 AND ${match.sql}
        ORDER BY ${rank.sql}, vd.product_name_en LIMIT ?
      `).all(warehouseId, ...match.params, ...rank.params, limit);
    }
    return getDb().prepare(`
      SELECT vd.*, (SELECT COALESCE(SUM(quantity),0) FROM stock_levels sl WHERE sl.variant_id = vd.variant_id) AS quantity,${offer}
      FROM v_variant_details vd
      JOIN products p ON p.id = vd.product_id
      WHERE vd.variant_active = 1 AND vd.product_active = 1 AND ${match.sql}
      ORDER BY ${rank.sql}, vd.product_name_en LIMIT ?
    `).all(...match.params, ...rank.params, limit);
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
