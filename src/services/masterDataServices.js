/**
 * Concrete master-data use-cases built on CrudService.
 * Only the behaviour that differs per module lives here.
 */
import repositories from '../infrastructure/repositories/index.js';
import { CrudService, referencedBy, referencedByAny } from './CrudService.js';
import { BusinessRuleError, ValidationError } from '../shared/errors.js';
import { transaction } from '../infrastructure/database/connection.js';
import auditService from './AuditService.js';

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

  get(id) {
    const supplier = super.get(id);
    return {
      ...supplier,
      statistics: this.repository.statistics(id),
      recentOrders: repositories.purchaseOrders.listDetailed({ supplierId: id, pageSize: 10 }).rows,
      productCount: this.repository.db
        .prepare('SELECT COUNT(*) AS n FROM products WHERE supplier_id = ?').get(id).n,
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

  list(query) {
    if (query?.all) return { rows: this.repository.listWithCounts(), total: undefined };
    return super.list(query);
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

  beforeSave(data, before) {
    if (before && Number(data.parent_id) === Number(before.id)) {
      throw new ValidationError('A category cannot be its own parent');
    }
    return data;
  }

  tree() {
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

  makeDefault(id, context) {
    return transaction(() => {
      const before = this.repository.requireById(id, 'warehouse');
      const after = this.repository.makeDefault(id);
      auditService.recordChange(context, {
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

  get(id) {
    const customer = super.get(id);
    return {
      ...customer,
      statistics: this.repository.statistics(id),
      recentSales: repositories.sales.listDetailed({ customerId: id, pageSize: 10 }).rows,
      topProducts: this.repository.db.prepare(`
        SELECT l.sku, l.description, SUM(l.quantity) AS qty, SUM(l.line_total) AS value
        FROM sale_lines l JOIN sales s ON s.id = l.sale_id
        WHERE s.customer_id = ? AND s.status = 'completed'
        GROUP BY l.variant_id ORDER BY value DESC LIMIT 5
      `).all(id),
    };
  }

  search(term, limit = 15) {
    const like = `%${term}%`;
    return this.repository.db.prepare(`
      SELECT id, code, name, phone, customer_group, balance, loyalty_points, credit_limit
      FROM customers
      WHERE is_active = 1 AND (name LIKE ? OR phone LIKE ? OR code LIKE ?)
      ORDER BY name LIMIT ?
    `).all(like, like, like, limit);
  }

  /** Manual receipt against an outstanding balance (credit customers). */
  settleBalance(id, { amount, method = 'cash', reference }, context = {}) {
    return transaction(() => {
      const customer = this.repository.requireById(id, 'customer');
      const value = Number(amount);
      if (!(value > 0)) throw new ValidationError('Amount must be greater than zero');
      this.repository.adjustBalance(id, -value);
      const after = this.repository.findById(id);
      auditService.record({
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

  withValues() {
    return this.repository.withValues();
  }

  addValue(attributeId, data, context = {}) {
    return transaction(() => {
      const attribute = this.repository.requireById(attributeId, 'attribute');
      if (this.values.db
        .prepare('SELECT 1 FROM attribute_values WHERE attribute_id = ? AND code = ?')
        .get(attributeId, data.code)) {
        throw new BusinessRuleError(`Value code "${data.code}" already exists for this attribute`);
      }
      const created = this.values.create({ ...data, attribute_id: attributeId });
      auditService.recordChange(context, {
        action: 'CREATE', module: 'attributes', entityType: 'attribute_value',
        entityId: created.id, entityLabel: `${attribute.name_en} / ${created.value_en}`,
        after: created,
      });
      return created;
    });
  }

  updateValue(valueId, data, context = {}) {
    return transaction(() => {
      const before = this.values.requireById(valueId, 'attribute value');
      const after = this.values.update(valueId, data);
      auditService.recordChange(context, {
        action: 'UPDATE', module: 'attributes', entityType: 'attribute_value',
        entityId: valueId, entityLabel: after.value_en, before, after,
      });
      return after;
    });
  }

  removeValue(valueId, context = {}) {
    return transaction(() => {
      const before = this.values.requireById(valueId, 'attribute value');
      if (this.values.isUsedByVariant(valueId)) {
        throw new BusinessRuleError('This value is used by existing product variants');
      }
      this.values.remove(valueId);
      auditService.recordChange(context, {
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
