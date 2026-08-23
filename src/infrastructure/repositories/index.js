/**
 * Composition root for the data layer.
 * Services depend on these instances, never on the database driver directly —
 * which is what keeps the business logic swappable and testable.
 */
import {
  SupplierRepository, BrandRepository, CategoryRepository, WarehouseRepository,
  AttributeRepository, AttributeValueRepository, CustomerRepository,
} from './masterData.js';
import { ProductRepository, VariantRepository } from './ProductRepository.js';
import { InventoryRepository, StockAdjustmentRepository } from './InventoryRepository.js';
import { PurchaseOrderRepository } from './PurchaseRepository.js';
import { SalesRepository, SalesReturnRepository } from './SalesRepository.js';
import { PromotionRepository } from './PromotionRepository.js';
import {
  CostRepository, CostCategoryRepository, RecurringCostRepository, EmployeeRepository,
} from './CostRepository.js';
import { LegacyInvoiceRepository } from './LegacyInvoiceRepository.js';
import {
  UserRepository, RoleRepository, AuditRepository, SettingsRepository, SequenceRepository,
} from './SystemRepository.js';

export const repositories = {
  suppliers: new SupplierRepository(),
  brands: new BrandRepository(),
  categories: new CategoryRepository(),
  warehouses: new WarehouseRepository(),
  attributes: new AttributeRepository(),
  attributeValues: new AttributeValueRepository(),
  customers: new CustomerRepository(),
  products: new ProductRepository(),
  variants: new VariantRepository(),
  inventory: new InventoryRepository(),
  adjustments: new StockAdjustmentRepository(),
  purchaseOrders: new PurchaseOrderRepository(),
  sales: new SalesRepository(),
  salesReturns: new SalesReturnRepository(),
  promotions: new PromotionRepository(),
  costs: new CostRepository(),
  costCategories: new CostCategoryRepository(),
  recurringCosts: new RecurringCostRepository(),
  employees: new EmployeeRepository(),
  legacyInvoices: new LegacyInvoiceRepository(),
  users: new UserRepository(),
  roles: new RoleRepository(),
  audit: new AuditRepository(),
  settings: new SettingsRepository(),
  sequences: new SequenceRepository(),
};

export default repositories;
