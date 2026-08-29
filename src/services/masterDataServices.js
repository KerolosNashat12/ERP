/**
 * Concrete master-data use-cases built on CrudService.
 * Only the behaviour that differs per module lives here.
 */
import repositories from '../infrastructure/repositories/index.js';
import { CrudService, referencedBy, referencedByAny } from './CrudService.js';
import { BusinessRuleError, ValidationError } from '../shared/errors.js';
import { transaction, getDb } from '../infrastructure/database/connection.js';
import { likeParam } from '../infrastructure/database/productSearch.js';
import auditService from './AuditService.js';
import { reindexWhere } from './searchIndex.js';

export class SupplierService extends CrudService {
  constructor() {
    super({
      repository: repositories.suppliers,
      module: 'suppliers',
      entityType: 'supplier',
      codePrefix: 'SUP',
      isReferenced: referencedByAny([
        referencedBy('products', 'supplier_id'),
        referencedBy('purchase_orders', 'supplier_id'),
        referencedBy('brands', 'supplier_id'),
      ]),
    });
  }

  async get(id) {
    const supplier = await super.get(id);
    return {
      ...supplier,
      statistics: await this.repository.statistics(id),
      recentOrders: (await repositories.purchaseOrders
        .listDetailed({ supplierId: id, pageSize: 10 })).rows,
      productCount: (await this.repository.db
        .prepare('SELECT COUNT(*) AS n FROM products WHERE supplier_id = ?').get(id)).n,
    };
  }
}

export class BrandService extends CrudService {
  constructor() {
    super({
      repository: repositories.brands,
      module: 'brands',
      entityType: 'brand',
      codePrefix: 'BRD',
      isReferenced: referencedBy('products', 'brand_id'),
    });
  }

  /**
   * Renaming a brand rewrites the search text of every product under it.
   *
   * The index carries the brand's name so that typing «ديور» finds Dior's
   * products rather than only the brand row. The cost of that is this hook:
   * without it, renaming a brand leaves its products findable by the name it
   * used to have and not by the one it now has — a search failure with no
   * visible cause, on a screen nobody would think to look at.
   *
   * `reindexWhere` never throws, so a rename is not rolled back because the
   * index could not be rebuilt; `reindexAll()` repairs it.
   */
  async update(id, data, context = {}) {
    const after = await super.update(id, data, context);
    await reindexWhere('brand_id', id);
    return after;
  }

  async list(query) {
    if (query?.all) return { rows: await this.#withLogos(await this.repository.listWithCounts()) };
    const page = await super.list(query);
    return { ...page, rows: await this.#withLogos(page.rows) };
  }

  /**
   * Which of these brands has a picture, in one query rather than one per row.
   *
   * The brands screen shows the mark beside the name, because the question an
   * owner actually has on that screen is "which of my brands still looks like a
   * letter on the website". The bytes live in `web_assets` under a slot named
   * for the brand (see WebAssetService); only the fact that a row exists is
   * needed here, never the BLOB — reading a page of logos to draw a list would
   * be megabytes to answer a yes/no.
   */
  async #withLogos(rows) {
    if (!rows.length) return rows;
    const slots = rows.map((row) => `brand:${row.id}`);
    const found = await getDb().prepare(
      `SELECT slot FROM web_assets WHERE slot IN (${slots.map(() => '?').join(', ')})`,
    ).all(...slots);
    const has = new Set(found.map((row) => row.slot));
    return rows.map((row) => ({ ...row, has_logo: has.has(`brand:${row.id}`) ? 1 : 0 }));
  }
}

export class CategoryService extends CrudService {
  constructor() {
    super({
      repository: repositories.categories,
      module: 'categories',
      entityType: 'category',
      codePrefix: 'CAT',
      isReferenced: referencedByAny([
        referencedBy('products', 'category_id'),
        referencedBy('categories', 'parent_id'),
      ]),
    });
  }

  /** The same as BrandService.update, for the same reason — see the note there. */
  async update(id, data, context = {}) {
    const after = await super.update(id, data, context);
    await reindexWhere('category_id', id);
    return after;
  }

  async beforeSave(data, before) {
    if (before && Number(data.parent_id) === Number(before.id)) {
      throw new ValidationError('A category cannot be its own parent');
    }
    return data;
  }

  async tree() {
    return this.repository.tree();
  }
}

export class WarehouseService extends CrudService {
  constructor() {
    super({
      repository: repositories.warehouses,
      module: 'settings',
      entityType: 'warehouse',
      codePrefix: 'WH',
      isReferenced: referencedByAny([
        referencedBy('stock_movements', 'warehouse_id'),
        referencedBy('sales', 'warehouse_id'),
        referencedBy('purchase_orders', 'warehouse_id'),
      ]),
    });
  }

  async makeDefault(id, context) {
    return transaction(async () => {
      const before = await this.repository.requireById(id, 'warehouse');
      const after = await this.repository.makeDefault(id);
      await auditService.recordChange(context, {
        action: 'UPDATE', module: 'settings', entityType: 'warehouse', entityId: id,
        entityLabel: after.name_en, before, after,
      });
      return after;
    });
  }
}

export class CustomerService extends CrudService {
  constructor() {
    super({
      repository: repositories.customers,
      module: 'customers',
      entityType: 'customer',
      labelField: 'name',
      codePrefix: 'CUS',
      isReferenced: referencedByAny([
        referencedBy('sales', 'customer_id'),
        referencedBy('sales_returns', 'customer_id'),
      ]),
    });
  }

  async get(id) {
    const customer = await super.get(id);
    return {
      ...customer,
      statistics: await this.repository.statistics(id),
      recentSales: (await repositories.sales.listDetailed({ customerId: id, pageSize: 10 })).rows,
      topProducts: await this.repository.db.prepare(`
        SELECT l.sku, l.description, SUM(l.quantity) AS qty, SUM(l.line_total) AS value
        FROM sale_lines l JOIN sales s ON s.id = l.sale_id
        WHERE s.customer_id = ? AND s.status = 'completed'
        GROUP BY l.variant_id ORDER BY value DESC LIMIT 5
      `).all(id),
    };
  }

  /**
   * Customer type-ahead at the till. A customer is not a product, so this keeps
   * its own three columns — but it shares the escaping, and an exact code or
   * phone number now leads, because a cashier who typed a whole phone number
   * meant that customer.
   */
  async search(term, limit = 15) {
    const like = likeParam(term);
    const exact = String(term ?? '').trim();
    return this.repository.db.prepare(`
      SELECT id, code, name, phone, customer_group, balance, loyalty_points, credit_limit
      FROM customers
      WHERE is_active = 1 AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                               OR code LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN phone = ? OR code = ? COLLATE NOCASE THEN 0 ELSE 1 END, name
      LIMIT ?
    `).all(like, like, like, exact, exact, limit);
  }

  /** Manual receipt against an outstanding balance (credit customers). */
  async settleBalance(id, { amount, method = 'cash', reference }, context = {}) {
    return transaction(async () => {
      const customer = await this.repository.requireById(id, 'customer');
      const value = Number(amount);
      if (!(value > 0)) throw new ValidationError('Amount must be greater than zero');
      await this.repository.adjustBalance(id, -value);
      const after = await this.repository.findById(id);
      await auditService.record({
        action: 'PAYMENT', module: 'customers', entityType: 'customer', entityId: id,
        entityLabel: customer.name,
        before: { balance: customer.balance }, after: { balance: after.balance, method, reference },
        actor: context.actor, request: context.request,
      });
      return after;
    });
  }
}

export class AttributeService extends CrudService {
  constructor() {
    super({
      repository: repositories.attributes,
      module: 'attributes',
      entityType: 'attribute',
      codePrefix: 'ATTR',
      isReferenced: referencedByAny([
        referencedBy('product_attributes', 'attribute_id'),
        referencedBy('variant_attribute_values', 'attribute_id'),
      ]),
    });
    this.values = repositories.attributeValues;
  }

  async withValues() {
    return this.repository.withValues();
  }

  async addValue(attributeId, data, context = {}) {
    return transaction(async () => {
      const attribute = await this.repository.requireById(attributeId, 'attribute');
      if (await this.values.db
        .prepare('SELECT 1 FROM attribute_values WHERE attribute_id = ? AND code = ?')
        .get(attributeId, data.code)) {
        throw new BusinessRuleError(`Value code "${data.code}" already exists for this attribute`);
      }
      const created = await this.values.create({ ...data, attribute_id: attributeId });
      await auditService.recordChange(context, {
        action: 'CREATE', module: 'attributes', entityType: 'attribute_value',
        entityId: created.id, entityLabel: `${attribute.name_en} / ${created.value_en}`,
        after: created,
      });
      return created;
    });
  }

  async updateValue(valueId, data, context = {}) {
    return transaction(async () => {
      const before = await this.values.requireById(valueId, 'attribute value');
      const after = await this.values.update(valueId, data);
      await auditService.recordChange(context, {
        action: 'UPDATE', module: 'attributes', entityType: 'attribute_value',
        entityId: valueId, entityLabel: after.value_en, before, after,
      });
      return after;
    });
  }

  async removeValue(valueId, context = {}) {
    return transaction(async () => {
      const before = await this.values.requireById(valueId, 'attribute value');
      if (await this.values.isUsedByVariant(valueId)) {
        throw new BusinessRuleError('This value is used by existing product variants');
      }
      await this.values.remove(valueId);
      await auditService.recordChange(context, {
        action: 'DELETE', module: 'attributes', entityType: 'attribute_value',
        entityId: valueId, entityLabel: before.value_en, before,
      });
      return { deleted: true };
    });
  }
}

export const supplierService = new SupplierService();
export const brandService = new BrandService();
export const categoryService = new CategoryService();
export const warehouseService = new WarehouseService();
export const customerService = new CustomerService();
export const attributeService = new AttributeService();
