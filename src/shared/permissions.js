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
  // فواتيرك — the invoices the shop already had ON PAPER before it had this
  // system: photographs, a supplier, and the payments recorded against them.
  //
  // Its OWN module rather than a corner of `purchases`, for two reasons that
  // point the same way. The platform SELLS modules, and this is a feature a
  // shop can be sold or not sold — a small package that bought purchasing has
  // not bought an archive of its old paperwork, and `requirePermission`
  // enforces that against the matched code's module with no extra work here.
  // And the archive is precisely the thing that must NOT be confused with
  // purchasing: these amounts never touch stock, costs, profit or a supplier
  // balance (see shared/legacyInvoices.js), so `purchases.view` had better not
  // be what opens them. `pay` and `reverse_payment` are split off the same way
  // they are in `purchases` above. Migration 015 grants them to the roles that
  // already hold the rights they were carved out of.
  legacy_invoices: ['view', 'create', 'update', 'delete', 'pay', 'reverse_payment'],
  // The people the shop pays. Separate from `users` on purpose: a delivery man
  // has a salary and no login. `pay` is money leaving the shop, which is not
  // the same act as editing somebody's record — see `purchases.pay` above for
  // the same distinction.
  employees: ['view', 'create', 'update', 'delete', 'pay'],
  users: ['view', 'create', 'update', 'delete', 'reset_password'],
  audit: ['view', 'export'],
  // `backup` is the file copy an on-premise shop keeps on its own PC — it never
  // leaves the building. `export_data` is the shop taking its WHOLE BOOK out of
  // the building in one file, which is a different act with a different risk and
  // therefore a different code; see UNDELEGATABLE below.
  settings: ['view', 'update', 'backup', 'export_data'],
  labels: ['view', 'print'],
  weborders: ['view', 'confirm', 'cancel'],
  /*
   * الهدر — stock the shop paid for and will never sell.
   *
   * Its own module rather than a corner of `inventory`, for the reason the
   * platform exists: a module is a thing that can be sold, and the owner asked
   * for this one to be visible and switchable per shop in the console. It is
   * also a genuinely different act — reading what the shop is holding and
   * writing off what it has lost are not the same trust, and a stock clerk who
   * may count the shelves has no business deciding four bottles are gone.
   */
  wastage: ['view', 'record'],
  /*
   * سلة المهملات. `view` is seeing what was deleted; `restore` is bringing it
   * back; `purge` is destroying it early, before the thirty days are up.
   *
   * Three codes and not one, because they are three different amounts of
   * damage: seeing the bin is harmless, restoring puts a hidden record back on
   * screens other people read, and purging is the only irreversible act in this
   * system that a person can reach with a button.
   */
  trash: ['view', 'restore', 'purge'],
};

export const ALL_PERMISSIONS = Object.entries(MODULES).flatMap(([module, actions]) =>
  actions.map((action) => ({ code: `${module}.${action}`, module, action })),
);

/**
 * Permissions that the role editor may not hand to anybody.
 *
 * Every other code in this file is a decision the shop's administrator makes:
 * he decides whether his manager may void a sale or his clerk may receive
 * goods, and if he gets one of those wrong the damage is inside the shop and
 * inside the audit log. `settings.export_data` is not that kind of decision. It
 * produces ONE FILE containing every price, every cost, every customer's phone
 * number and every employee's salary, and the moment it exists it is on a
 * laptop, in an email, on a phone — outside everything this system can see.
 *
 * Today a shop administrator could tick `settings.backup` for the cashier role
 * in four clicks, and on a shop PC that is defensible: it makes a file on the
 * machine the cashier is already standing at. Ticking a box that lets the
 * cashier walk out with the shop's whole book is not the same click, and it is
 * exactly the click somebody makes at five o'clock without reading it.
 *
 * So this one is not delegable at all. It belongs to the administrator role,
 * which by construction holds every permission and cannot be edited (see
 * `UserService.updateRolePermissions`), and a shop that wants a second person
 * able to take a copy makes that person an administrator — a deliberate act,
 * visible on the Users screen, that nobody performs by accident.
 */
export const UNDELEGATABLE = new Set(['settings.export_data']);

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
        'weborders', 'costs', 'employees', 'legacy_invoices',
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
      // And the old paper invoices, read-only: what the shop still owes on
      // them is a real obligation even though it is deliberately outside the
      // system's own totals.
      'legacy_invoices.view',
      'reports.view', 'reports.export',
      'audit.view', 'audit.export',
      'settings.view',
    ],
  },
];
