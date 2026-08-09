/**
 * Repositories for master data whose persistence needs are plain CRUD.
 * Anything that grows behaviour later gets promoted to its own file.
 */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';

export class SupplierRepository extends BaseRepository {
  constructor() {
    super({
      table: 'suppliers',
      columns: [
        'code', 'name_en', 'name_ar', 'contact_person', 'phone', 'email', 'address',
        'city', 'country', 'tax_number', 'payment_terms_days', 'credit_limit',
        'opening_balance', 'lead_time_days', 'notes', 'is_active', 'created_by',
      ],
      searchable: ['code', 'name_en', 'name_ar', 'phone', 'email', 'contact_person'],
    });
  }

  /** Purchase totals per supplier — used by the supplier report and detail page. */
  statistics(supplierId) {
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
      columns: ['code', 'name_en', 'name_ar', 'description', 'country', 'supplier_id',
        'logo_url', 'is_active', 'created_by'],
      searchable: ['code', 'name_en', 'name_ar', 'country'],
    });
  }

  listWithCounts() {
    return getDb().prepare(`
      SELECT b.*, s.name_en AS supplier_name,
             (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count
      FROM brands b
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      ORDER BY b.name_en
    `).all();
  }
}

export class CategoryRepository extends BaseRepository {
  constructor() {
    super({
      table: 'categories',
      columns: ['code', 'name_en', 'name_ar', 'parent_id', 'description', 'is_active', 'created_by'],
      searchable: ['code', 'name_en', 'name_ar'],
      defaultSort: 'name_en ASC',
    });
  }

  tree() {
    const rows = getDb().prepare(`
      SELECT c.*, p.name_en AS parent_name,
             (SELECT COUNT(*) FROM products pr WHERE pr.category_id = c.id) AS product_count
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
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

  getDefault() {
    return this.findBy('is_default', 1) || this.db.prepare('SELECT * FROM warehouses ORDER BY id LIMIT 1').get();
  }

  /** There is exactly one location; this is its record. */
  single() {
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

  withValues() {
    const attributes = this.all();
    const values = getDb()
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

  byAttribute(attributeId) {
    return this.db
      .prepare('SELECT * FROM attribute_values WHERE attribute_id = ? ORDER BY display_order, value_en')
      .all(attributeId);
  }

  isUsedByVariant(valueId) {
    return Boolean(this.db
      .prepare('SELECT 1 FROM variant_attribute_values WHERE attribute_value_id = ? LIMIT 1')
      .get(valueId));
  }
}

export class CustomerRepository extends BaseRepository {
  constructor() {
    super({
      table: 'customers',
      columns: [
        'code', 'name', 'phone', 'email', 'address', 'city', 'customer_group',
        'tax_number', 'credit_limit', 'balance', 'loyalty_points', 'notes',
        'is_active', 'created_by',
      ],
      searchable: ['code', 'name', 'phone', 'email'],
    });
  }

  statistics(customerId) {
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

  adjustBalance(customerId, delta) {
    this.db.prepare('UPDATE customers SET balance = ROUND(balance + ?, 2) WHERE id = ?')
      .run(delta, customerId);
  }

  adjustLoyalty(customerId, delta) {
    this.db.prepare('UPDATE customers SET loyalty_points = ROUND(loyalty_points + ?, 2) WHERE id = ?')
      .run(delta, customerId);
  }
}
