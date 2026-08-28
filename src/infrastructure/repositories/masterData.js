/**
 * Repositories for master data whose persistence needs are plain CRUD.
 * Anything that grows behaviour later gets promoted to its own file.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';
import { notInBin } from '../../shared/trashFilter.js';

export class SupplierRepository extends BaseRepository {
  constructor() {
    super({
      table: 'suppliers',
      trashType: 'supplier',
      columns: [
        'code', 'name_en', 'name_ar', 'contact_person', 'phone', 'email', 'address',
        'city', 'country', 'tax_number', 'payment_terms_days', 'credit_limit',
        'opening_balance', 'lead_time_days', 'notes', 'is_active', 'created_by',
      ],
      searchable: ['code', 'name_en', 'name_ar', 'phone', 'email', 'contact_person'],
    });
  }

  /**
   * The counters above the suppliers list.
   *
   * The question a shop owner actually has about this screen is not "how many
   * suppliers do I have" - it is "how much do I owe, and to how many of them".
   * So the money comes first and the count is the small print.
   */
  async summary() {
    const db = getDb();
    const [people, orders] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS suppliers,
               COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 END), 0) AS active
        FROM suppliers
        WHERE ${notInBin('supplier', 'suppliers.id')}
      `).get(),
      db.prepare(`
        SELECT
          COUNT(*)                                                            AS orders,
          COUNT(DISTINCT supplier_id)                                         AS suppliers_used,
          COALESCE(SUM(total_amount), 0)                                      AS purchased,
          COALESCE(SUM(total_amount - paid_amount), 0)                        AS outstanding,
          COUNT(DISTINCT CASE WHEN total_amount - paid_amount > 0.01
                              THEN supplier_id END)                           AS suppliers_owed,
          COALESCE(SUM(CASE WHEN status IN ('ordered','partially_received')
                            THEN 1 END), 0)                                   AS open_orders,
          COALESCE(SUM(CASE WHEN status IN ('ordered','partially_received')
                            THEN total_amount END), 0)                        AS open_value
        FROM purchase_orders
        WHERE status <> 'cancelled'
      `).get(),
    ]);
    return { ...people, ...orders };
  }

  /** Purchase totals per supplier — used by the supplier report and detail page. */
  async statistics(supplierId) {
    return getDb().prepare(`
      SELECT
        COUNT(*)                                        AS order_count,
        COALESCE(SUM(total_amount), 0)                  AS total_purchased,
        COALESCE(SUM(total_amount - paid_amount), 0)    AS outstanding,
        MAX(order_date)                                 AS last_order_date
      FROM purchase_orders
      WHERE supplier_id = ? AND status <> 'cancelled'
    `).get(supplierId);
  }
}

export class BrandRepository extends BaseRepository {
  constructor() {
    super({
      table: 'brands',
      trashType: 'brand',
      /*
       * `is_published` is editable here now. It always existed and always
       * decided whether the storefront shows the brand - it just could not be
       * changed from any screen, so a brand that arrived unpublished stayed
       * invisible on the website with nothing anywhere to say why.
       */
      columns: ['code', 'name_en', 'name_ar', 'description', 'country', 'supplier_id',
        'logo_url', 'is_active', 'is_published', 'created_by'],
      searchable: ['code', 'name_en', 'name_ar', 'country'],
    });
  }

  /**
   * The brands list, and - for each - WHETHER THE WEBSITE SHOWS IT.
   *
   * The shop's owner uploaded logos in the ERP and asked where they had gone on
   * the website. Nothing was broken: the storefront shows a brand only when the
   * brand is published AND at least one of its products is published, which is
   * the right rule (an empty brand on a shop window is a dead end) and was
   * invisible - the ERP said nothing, so the only way to find out was to look
   * at the site and guess.
   *
   * So the same two facts the storefront decides on are returned here, and the
   * screen says which one is missing. The counts use the storefront's own
   * definition of published, including the recycle bin, so the answer cannot be
   * subtly different from what the shop window actually does.
   */
  async listWithCounts() {
    return getDb().prepare(`
      SELECT b.*, s.name_en AS supplier_name,
             (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count,
             (SELECT COUNT(*) FROM products p
               WHERE p.brand_id = b.id
                 AND p.is_active = 1 AND p.is_published = 1
                 AND NOT EXISTS (SELECT 1 FROM trash_items t
                                  WHERE t.entity_type = 'product' AND t.entity_id = p.id
                                    AND t.status = 'in_bin')) AS published_product_count,
             EXISTS (SELECT 1 FROM web_assets w WHERE w.slot = 'brand:' || b.id) AS has_logo
      FROM brands b
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE ${notInBin('brand', 'b.id')}
      ORDER BY b.name_en
    `).all();
  }
}

export class CategoryRepository extends BaseRepository {
  constructor() {
    super({
      table: 'categories',
      trashType: 'category',
      columns: ['code', 'name_en', 'name_ar', 'parent_id', 'description', 'is_active', 'created_by'],
      searchable: ['code', 'name_en', 'name_ar'],
      defaultSort: 'name_en ASC',
    });
  }

  async tree() {
    const rows = await getDb().prepare(`
      SELECT c.*, p.name_en AS parent_name,
             (SELECT COUNT(*) FROM products pr WHERE pr.category_id = c.id) AS product_count
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
      WHERE ${notInBin('category', 'c.id')}
      ORDER BY COALESCE(c.parent_id, c.id), c.name_en
    `).all();
    return rows;
  }
}

export class WarehouseRepository extends BaseRepository {
  constructor() {
    super({
      table: 'warehouses',
      columns: ['code', 'name_en', 'name_ar', 'address', 'phone', 'is_default', 'is_active'],
      searchable: ['code', 'name_en', 'name_ar'],
      defaultSort: 'is_default DESC, name_en ASC',
    });
  }

  async getDefault() {
    return (await this.findBy('is_default', 1))
      || (await this.db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get());
  }

  /** There is exactly one location; this is its record. */
  async single() {
    return this.getDefault();
  }
}

export class AttributeRepository extends BaseRepository {
  constructor() {
    super({
      table: 'attributes',
      columns: ['code', 'name_en', 'name_ar', 'input_type', 'display_order', 'is_active'],
      searchable: ['code', 'name_en', 'name_ar'],
      defaultSort: 'display_order ASC, name_en ASC',
    });
  }

  async withValues() {
    const attributes = await this.all();
    const values = await getDb()
      .prepare('SELECT * FROM attribute_values ORDER BY display_order, value_en')
      .all();
    return attributes.map((attribute) => ({
      ...attribute,
      values: values.filter((v) => v.attribute_id === attribute.id),
    }));
  }
}

export class AttributeValueRepository extends BaseRepository {
  constructor() {
    super({
      table: 'attribute_values',
      columns: ['attribute_id', 'code', 'value_en', 'value_ar', 'color_hex', 'display_order', 'is_active'],
      searchable: ['code', 'value_en', 'value_ar'],
      timestamps: false,
      defaultSort: 'display_order ASC, value_en ASC',
    });
  }

  async byAttribute(attributeId) {
    return this.db
      .prepare('SELECT * FROM attribute_values WHERE attribute_id = ? ORDER BY display_order, value_en')
      .all(attributeId);
  }

  async isUsedByVariant(valueId) {
    return Boolean(await this.db
      .prepare('SELECT 1 FROM variant_attribute_values WHERE attribute_value_id = ? LIMIT 1')
      .get(valueId));
  }
}

export class CustomerRepository extends BaseRepository {
  constructor() {
    super({
      table: 'customers',
      trashType: 'customer',
      columns: [
        'code', 'name', 'phone', 'email', 'address', 'city', 'customer_group',
        'tax_number', 'credit_limit', 'balance', 'loyalty_points', 'notes',
        'is_active', 'created_by',
      ],
      searchable: ['code', 'name', 'phone', 'email'],
    });
  }

  async statistics(customerId) {
    return getDb().prepare(`
      SELECT
        COUNT(*)                                     AS invoice_count,
        COALESCE(SUM(total_amount), 0)               AS total_spent,
        COALESCE(SUM(total_amount - paid_amount), 0) AS outstanding,
        COALESCE(AVG(total_amount), 0)               AS average_basket,
        MAX(sale_date)                               AS last_purchase_date
      FROM sales
      WHERE customer_id = ? AND status = 'completed'
    `).get(customerId);
  }

  async adjustBalance(customerId, delta) {
    await this.db.prepare('UPDATE customers SET balance = ROUND(balance + ?, 2) WHERE id = ?')
      .run(delta, customerId);
  }

  async adjustLoyalty(customerId, delta) {
    await this.db.prepare('UPDATE customers SET loyalty_points = ROUND(loyalty_points + ?, 2) WHERE id = ?')
      .run(delta, customerId);
  }
}
