/**
 * The single source of truth for RBAC.
 * Permission codes are `<module>.<action>`; roles are bundles of codes.
 * Adding a module means adding it here and referencing it in routes — no
 * scattered role checks anywhere else in the codebase.
 */

export const MODULES = {
  dashboard: ['view'],
  suppliers: ['view', 'create', 'update', 'delete'],
  brands: ['view', 'create', 'update', 'delete'],
  categories: ['view', 'create', 'update', 'delete'],
  attributes: ['view', 'create', 'update', 'delete'],
  products: ['view', 'create', 'update', 'delete'],
  inventory: ['view', 'adjust', 'count'],
  // `pay` and `reverse_payment` are money leaving the shop, which is not the
  // same act as editing the document it leaves against: a stock clerk who can
  // raise and amend a purchase order has no business recording what was paid
  // for it, and undoing a recorded payment is rarer still. See
  // migration 011 for how existing shops are granted them.
  purchases: ['view', 'create', 'update', 'delete', 'receive', 'approve', 'pay', 'reverse_payment'],
  customers: ['view', 'create', 'update', 'delete'],
  sales: ['view', 'create', 'void', 'return', 'return_no_receipt', 'discount'],
  promotions: ['view', 'create', 'update', 'delete'],
  reports: ['view', 'export'],
  // What the shop spends that is not stock — electricity, rent, taxes, wages.
  // Its own module rather than a corner of `reports` or `settings`, because
  // the platform sells modules: a shop on a small package has not paid for the
  // costs page and must not be given it, and `requirePermission` enforces that
  // against the matched code's module with no extra work here.
  costs: ['view', 'create', 'update', 'delete'],
  // The people the shop pays. Separate from `users` on purpose: a delivery man
  // has a salary and no login. `pay` is money leaving the shop, which is not
  // the same act as editing somebody's record — see `purchases.pay` above for
  // the same distinction.
  employees: ['view', 'create', 'update', 'delete', 'pay'],
  users: ['view', 'create', 'update', 'delete', 'reset_password'],
  audit: ['view', 'export'],
  settings: ['view', 'update', 'backup'],
  labels: ['view', 'print'],
  weborders: ['view', 'confirm', 'cancel'],
};

export const ALL_PERMISSIONS = Object.entries(MODULES).flatMap(([module, actions]) =>
  actions.map((action) => ({ code: `${module}.${action}`, module, action })),
);

const all = () => ALL_PERMISSIONS.map((p) => p.code);
const forModules = (...modules) =>
  ALL_PERMISSIONS.filter((p) => modules.includes(p.module)).map((p) => p.code);

export const ROLE_DEFINITIONS = [
  {
    code: 'admin',
    name_en: 'Administrator',
    name_ar: 'مدير النظام',
    description: 'Unrestricted access to every module including users and settings.',
    permissions: all(),
  },
  {
    code: 'manager',
    name_en: 'Store Manager',
    name_ar: 'مدير المتجر',
    description: 'Runs day-to-day operations; cannot manage system users.',
    permissions: [
      ...forModules(
        'dashboard', 'suppliers', 'brands', 'categories', 'attributes', 'products',
        'inventory', 'purchases', 'customers', 'sales', 'promotions', 'reports', 'labels',
        'weborders', 'costs', 'employees',
      ),
      'audit.view',
      'settings.view',
    ],
  },
  {
    code: 'inventory',
    name_en: 'Inventory Clerk',
    name_ar: 'أمين المخزن',
    description: 'Receives goods, counts stock, moves items between locations.',
    permissions: [
      'dashboard.view',
      'suppliers.view', 'brands.view', 'categories.view', 'attributes.view',
      'products.view', 'products.create', 'products.update',
      ...forModules('inventory', 'labels'),
      'purchases.view', 'purchases.create', 'purchases.update', 'purchases.receive',
      'reports.view', 'reports.export',
    ],
  },
  {
    code: 'cashier',
    name_en: 'Cashier',
    name_ar: 'أمين الصندوق',
    description: 'Sells at the counter, registers customers, applies promo codes.',
    permissions: [
      'dashboard.view',
      'products.view', 'brands.view', 'categories.view', 'inventory.view',
      'customers.view', 'customers.create', 'customers.update',
      'sales.view', 'sales.create', 'sales.return',
      'promotions.view',
      'labels.view', 'labels.print',
    ],
  },
  {
    code: 'accountant',
    name_en: 'Accountant / Auditor',
    name_ar: 'محاسب / مراجع',
    description: 'Read-only across the business plus full reporting and audit trail.',
    permissions: [
      'dashboard.view',
      'suppliers.view', 'brands.view', 'categories.view', 'attributes.view',
      'products.view', 'inventory.view', 'purchases.view', 'customers.view',
      'sales.view', 'promotions.view',
      // Read-only, and deliberately including the costs and the payroll: an
      // auditor who cannot see the electricity bill or the wages cannot audit
      // the profit those come off.
      'costs.view', 'employees.view',
      'reports.view', 'reports.export',
      'audit.view', 'audit.export',
      'settings.view',
    ],
  },
];
