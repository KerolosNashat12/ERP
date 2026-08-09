/** API composition: mounts every module router under /api. */
import { Router } from 'express';
import config from '../../config/index.js';
import { asyncHandler, authenticate, requirePermission, validate } from '../middleware/index.js';
import { crudRouter } from './crudRouter.js';
import * as v from '../validators.js';

import authService from '../../services/AuthService.js';
import dashboardService from '../../services/DashboardService.js';
import catalogService from '../../services/CatalogService.js';
import inventoryService from '../../services/InventoryService.js';
import purchaseService from '../../services/PurchaseService.js';
import salesService from '../../services/SalesService.js';
import returnService from '../../services/ReturnService.js';
import promotionService from '../../services/PromotionService.js';
import reportService from '../../services/ReportService.js';
import labelService from '../../services/LabelService.js';
import auditService from '../../services/AuditService.js';
import { userService, settingsService, backupService } from '../../services/AdminService.js';
import {
  supplierService, brandService, categoryService, warehouseService,
  customerService, attributeService,
} from '../../services/masterDataServices.js';
import repositories from '../../infrastructure/repositories/index.js';

const router = Router();

// ----------------------------------------------------------------- session
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // offline LAN/localhost deployment
  maxAge: 12 * 60 * 60 * 1000,
};

router.post('/auth/login', validate(v.loginSchema), asyncHandler((req, res) => {
  const result = authService.login(req.body, req.context.request);
  res.cookie(config.auth.cookieName, result.token, cookieOptions);
  res.json({ user: result.user, token: result.token });
}));

router.post('/auth/logout', authenticate, asyncHandler((req, res) => {
  authService.logout(req.context.actor, req.context.request);
  res.clearCookie(config.auth.cookieName);
  res.json({ ok: true });
}));

router.get('/auth/me', authenticate, asyncHandler((req, res) => {
  res.json({
    user: authService.profile(req.user.id),
    settings: settingsService.all(),
    warehouses: repositories.warehouses.activeOnly(),
  });
}));

router.post('/auth/password', authenticate, validate(v.changePasswordSchema), asyncHandler((req, res) => {
  res.json(authService.changePassword(req.user.id, req.body, req.context));
}));

router.put('/auth/preferences', authenticate, asyncHandler((req, res) => {
  res.json(authService.updatePreferences(req.user.id, req.body, req.context));
}));

// Everything below requires a session.
router.use(authenticate);

// --------------------------------------------------------------- dashboard
router.get('/dashboard', requirePermission('dashboard.view'), asyncHandler((req, res) => {
  res.json(dashboardService.overview({ warehouseId: req.query.warehouseId || null }));
}));

router.get('/dashboard/alerts', requirePermission('dashboard.view'), asyncHandler((req, res) => {
  res.json({ rows: dashboardService.alerts({ warehouseId: req.query.warehouseId || null }) });
}));

// ------------------------------------------------------------- master data
router.use('/suppliers', crudRouter({
  service: supplierService, module: 'suppliers', schema: v.supplierSchema,
}));

router.use('/brands', crudRouter({
  service: brandService, module: 'brands', schema: v.brandSchema,
}));

router.use('/categories', crudRouter({
  service: categoryService,
  module: 'categories',
  schema: v.categorySchema,
  extend: (r, { perm }) => {
    r.get('/tree', perm('view'), asyncHandler((_req, res) => res.json({ rows: categoryService.tree() })));
  },
}));

// One shop location. It is created by the seed and edited in Settings; there is
// deliberately no create/delete route.
router.get('/location', requirePermission('settings.view'), asyncHandler((_req, res) => {
  res.json(repositories.warehouses.single());
}));
router.put('/location', requirePermission('settings.update'), validate(v.warehouseSchema.partial()),
  asyncHandler((req, res) => {
    const location = repositories.warehouses.single();
    res.json(warehouseService.update(location.id, req.body, req.context));
  }));

router.use('/customers', crudRouter({
  service: customerService,
  module: 'customers',
  schema: v.customerSchema,
  extend: (r, { perm }) => {
    r.get('/search', perm('view'), asyncHandler((req, res) => {
      res.json({ rows: customerService.search(req.query.q || '', 15) });
    }));
    r.post('/:id/settle', requirePermission('customers.update'), validate(v.paymentSchema),
      asyncHandler((req, res) => {
        res.json(customerService.settleBalance(Number(req.params.id), req.body, req.context));
      }));
  },
}));

router.use('/attributes', crudRouter({
  service: attributeService,
  module: 'attributes',
  schema: v.attributeSchema,
  extend: (r, { perm }) => {
    r.get('/with-values', perm('view'), asyncHandler((_req, res) => {
      res.json({ rows: attributeService.withValues() });
    }));
    r.post('/:id/values', requirePermission('attributes.create'), validate(v.attributeValueSchema),
      asyncHandler((req, res) => {
        res.status(201).json(attributeService.addValue(Number(req.params.id), req.body, req.context));
      }));
    r.put('/values/:valueId', requirePermission('attributes.update'),
      validate(v.attributeValueSchema.partial()), asyncHandler((req, res) => {
        res.json(attributeService.updateValue(Number(req.params.valueId), req.body, req.context));
      }));
    r.delete('/values/:valueId', requirePermission('attributes.delete'), asyncHandler((req, res) => {
      res.json(attributeService.removeValue(Number(req.params.valueId), req.context));
    }));
  },
}));

// ---------------------------------------------------------------- products
router.get('/products', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json(catalogService.list(req.query));
}));

router.get('/products/lookup', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json({ rows: catalogService.lookup(req.query.q, req.query.warehouseId) });
}));

router.get('/products/scan/:code', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json(catalogService.findByCode(req.params.code));
}));

router.post('/products/combinations', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json({ rows: catalogService.generateCombinations(req.body.attribute_ids || []) });
}));

router.post('/products/bulk-price', requirePermission('products.update'), asyncHandler((req, res) => {
  res.json(catalogService.bulkUpdatePrices(req.body, req.context));
}));

router.get('/products/variants/:variantId', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json(catalogService.variantDetails(Number(req.params.variantId)));
}));

router.get('/products/:id/overview', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json(catalogService.overview(Number(req.params.id), { days: req.query.days }));
}));

router.get('/products/:id', requirePermission('products.view'), asyncHandler((req, res) => {
  res.json(catalogService.get(Number(req.params.id)));
}));

router.post('/products', requirePermission('products.create'), validate(v.productSchema),
  asyncHandler((req, res) => {
    res.status(201).json(catalogService.save(req.body, req.context));
  }));

router.put('/products/:id', requirePermission('products.update'), validate(v.productSchema),
  asyncHandler((req, res) => {
    res.json(catalogService.save(req.body, req.context, Number(req.params.id)));
  }));

router.delete('/products/:id', requirePermission('products.delete'), asyncHandler((req, res) => {
  res.json(catalogService.remove(Number(req.params.id), req.context));
}));

// --------------------------------------------------------------- inventory
router.get('/inventory/stock', requirePermission('inventory.view'), asyncHandler((req, res) => {
  res.json(inventoryService.stockOnHand({
    ...req.query,
    lowStockOnly: req.query.lowStockOnly === '1' || req.query.lowStockOnly === 'true',
  }));
}));

router.get('/inventory/low-stock', requirePermission('inventory.view'), asyncHandler((req, res) => {
  res.json({ rows: inventoryService.lowStock(req.query.warehouseId) });
}));

router.get('/inventory/movements', requirePermission('inventory.view'), asyncHandler((req, res) => {
  res.json(inventoryService.movements(req.query));
}));

router.post('/inventory/quick-adjust', requirePermission('inventory.adjust'),
  validate(v.quickAdjustSchema), asyncHandler((req, res) => {
    res.json(inventoryService.quickAdjust(req.body, req.context));
  }));

router.get('/inventory/count-sheet', requirePermission('inventory.count'), asyncHandler((req, res) => {
  res.json({ rows: inventoryService.buildCountSheet(req.query) });
}));

router.get('/inventory/adjustments', requirePermission('inventory.view'), asyncHandler((req, res) => {
  res.json(inventoryService.listAdjustments(req.query));
}));
router.get('/inventory/adjustments/:id', requirePermission('inventory.view'), asyncHandler((req, res) => {
  res.json(inventoryService.getAdjustment(Number(req.params.id)));
}));
router.post('/inventory/adjustments', requirePermission('inventory.adjust'), validate(v.adjustmentSchema),
  asyncHandler((req, res) => res.status(201).json(inventoryService.saveAdjustment(req.body, req.context))));
router.put('/inventory/adjustments/:id', requirePermission('inventory.adjust'), validate(v.adjustmentSchema),
  asyncHandler((req, res) => res.json(
    inventoryService.saveAdjustment(req.body, req.context, Number(req.params.id)),
  )));
router.post('/inventory/adjustments/:id/post', requirePermission('inventory.adjust'),
  asyncHandler((req, res) => res.json(inventoryService.postAdjustment(Number(req.params.id), req.context))));

// --------------------------------------------------------------- purchases
router.get('/purchases', requirePermission('purchases.view'), asyncHandler((req, res) => {
  res.json(purchaseService.list(req.query));
}));
router.get('/purchases/reorder-suggestions', requirePermission('purchases.create'),
  asyncHandler((req, res) => res.json({ rows: purchaseService.suggestReorder(req.query.warehouseId) })));
router.get('/purchases/:id', requirePermission('purchases.view'), asyncHandler((req, res) => {
  res.json(purchaseService.get(Number(req.params.id)));
}));
router.post('/purchases', requirePermission('purchases.create'), validate(v.purchaseOrderSchema),
  asyncHandler((req, res) => res.status(201).json(purchaseService.save(req.body, req.context))));
router.put('/purchases/:id', requirePermission('purchases.update'), validate(v.purchaseOrderSchema),
  asyncHandler((req, res) => res.json(purchaseService.save(req.body, req.context, Number(req.params.id)))));
router.post('/purchases/:id/approve', requirePermission('purchases.approve'),
  asyncHandler((req, res) => res.json(purchaseService.approve(Number(req.params.id), req.context))));
router.post('/purchases/:id/receive', requirePermission('purchases.receive'), validate(v.receiveSchema),
  asyncHandler((req, res) => res.json(purchaseService.receive(Number(req.params.id), req.body, req.context))));
router.post('/purchases/:id/payment', requirePermission('purchases.update'), validate(v.paymentSchema),
  asyncHandler((req, res) => res.json(
    purchaseService.registerPayment(Number(req.params.id), req.body, req.context),
  )));
router.post('/purchases/:id/cancel', requirePermission('purchases.update'),
  asyncHandler((req, res) => res.json(
    purchaseService.cancel(Number(req.params.id), req.body?.reason, req.context),
  )));
router.delete('/purchases/:id', requirePermission('purchases.delete'),
  asyncHandler((req, res) => res.json(purchaseService.remove(Number(req.params.id), req.context))));

// ------------------------------------------------------------------- sales
router.get('/sales', requirePermission('sales.view'), asyncHandler((req, res) => {
  res.json(salesService.list(req.query));
}));
router.post('/sales/quote', requirePermission('sales.create'), asyncHandler((req, res) => {
  res.json(salesService.quote(req.body));
}));
router.get('/sales/shift-summary', requirePermission('sales.view'), asyncHandler((req, res) => {
  res.json(salesService.shiftSummary({
    userId: req.query.userId || req.user.id,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  }));
}));
router.get('/returns/policy', requirePermission('sales.return', 'sales.view'),
  asyncHandler((_req, res) => res.json(returnService.policy())));
router.get('/returns/lookup', requirePermission('sales.return'), asyncHandler((req, res) => {
  res.json(returnService.lookupInvoice(req.query.reference));
}));
router.get('/returns/item/:code', requirePermission('sales.return'), asyncHandler((req, res) => {
  res.json(returnService.lookupItem(req.params.code));
}));
router.get('/returns/reasons', requirePermission('reports.view', 'sales.view'),
  asyncHandler((req, res) => res.json({ rows: returnService.reasonBreakdown(req.query) })));
router.get('/returns', requirePermission('sales.view'), asyncHandler((req, res) => {
  res.json(returnService.list(req.query));
}));
router.get('/returns/:id', requirePermission('sales.view'), asyncHandler((req, res) => {
  res.json(returnService.get(Number(req.params.id)));
}));
router.post('/returns', requirePermission('sales.return'), validate(v.returnSchema),
  asyncHandler((req, res) => res.status(201).json(
    returnService.create(req.body, { ...req.context, permissions: req.permissions }),
  )));
router.get('/sales/:id', requirePermission('sales.view'), asyncHandler((req, res) => {
  res.json(salesService.get(Number(req.params.id)));
}));
router.post('/sales', requirePermission('sales.create'), validate(v.saleSchema),
  asyncHandler((req, res) => res.status(201).json(salesService.checkout(req.body, req.context))));
router.post('/sales/:id/void', requirePermission('sales.void'),
  asyncHandler((req, res) => res.json(salesService.void(Number(req.params.id), req.body?.reason, req.context))));
router.post('/sales/:id/payment', requirePermission('sales.create'), validate(v.paymentSchema),
  asyncHandler((req, res) => res.json(
    salesService.registerPayment(Number(req.params.id), req.body, req.context),
  )));

// -------------------------------------------------------------- promotions
router.use('/promotions', crudRouter({
  service: promotionService,
  module: 'promotions',
  schema: v.promotionSchema,
  extend: (r, { perm }) => {
    r.post('/evaluate', requirePermission('sales.create', 'promotions.view'), asyncHandler((req, res) => {
      res.json(promotionService.evaluate(req.body));
    }));
    r.get('/validate/:code', perm('view'), asyncHandler((req, res) => {
      res.json(promotionService.validateCode(req.params.code, req.context));
    }));
    r.get('/usage', perm('view'), asyncHandler((req, res) => {
      res.json({ rows: promotionService.usageReport(req.query) });
    }));
    r.post('/vouchers/generate', requirePermission('promotions.create'), validate(v.voucherBatchSchema),
      asyncHandler((req, res) => res.status(201).json({
        rows: promotionService.generateVouchers(req.body, req.context),
      })));
  },
}));

// ----------------------------------------------------------------- reports
router.get('/reports', requirePermission('reports.view'), asyncHandler((req, res) => {
  res.json({ rows: reportService.catalogue(req.permissions) });
}));
router.get('/reports/:key', requirePermission('reports.view'), asyncHandler((req, res) => {
  const report = reportService.run(req.params.key, req.query);
  if (req.query.format === 'csv') {
    auditService.record({
      action: 'EXPORT', module: 'reports', entityType: 'report', entityId: req.params.key,
      entityLabel: report.titleEn, after: { rows: report.rows.length, filters: req.query },
      actor: req.context.actor, request: req.context.request,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}.csv"`);
    return res.send(reportService.toCsv(report, req.query.lang || 'en'));
  }
  return res.json(report);
}));

// ------------------------------------------------------------------ labels
router.post('/labels/batch', requirePermission('labels.print'), validate(v.labelBatchSchema),
  asyncHandler(async (req, res) => {
    res.json(await labelService.buildBatch(req.body.items, req.body, req.context));
  }));
router.get('/labels/qr', requirePermission('labels.view'), asyncHandler(async (req, res) => {
  res.json({ dataUri: await labelService.qrDataUri(req.query.payload || '', { size: Number(req.query.size) || 160 }) });
}));

// ------------------------------------------------------------------- audit
router.get('/audit', requirePermission('audit.view'), asyncHandler((req, res) => {
  res.json(auditService.list(req.query));
}));
router.get('/audit/filters', requirePermission('audit.view'), asyncHandler((_req, res) => {
  res.json(auditService.filters());
}));

// ------------------------------------------------------------------- users
router.get('/users', requirePermission('users.view'), asyncHandler((req, res) => {
  res.json(userService.list(req.query));
}));
router.get('/users/roles', requirePermission('users.view'), asyncHandler((_req, res) => {
  res.json({ rows: userService.roles(), permissions: userService.permissionCatalogue() });
}));
router.put('/users/roles/:id/permissions', requirePermission('users.update'), asyncHandler((req, res) => {
  res.json(userService.updateRolePermissions(Number(req.params.id), req.body.permissions || [], req.context));
}));
router.get('/users/:id', requirePermission('users.view'), asyncHandler((req, res) => {
  res.json(userService.get(Number(req.params.id)));
}));
router.post('/users', requirePermission('users.create'), validate(v.userSchema),
  asyncHandler((req, res) => res.status(201).json(userService.create(req.body, req.context))));
router.put('/users/:id', requirePermission('users.update'), validate(v.userUpdateSchema),
  asyncHandler((req, res) => res.json(userService.update(Number(req.params.id), req.body, req.context))));
router.delete('/users/:id', requirePermission('users.delete'),
  asyncHandler((req, res) => res.json(userService.remove(Number(req.params.id), req.context))));

// ---------------------------------------------------------------- settings
router.get('/settings', requirePermission('settings.view'), asyncHandler((_req, res) => {
  res.json(settingsService.all());
}));
router.put('/settings', requirePermission('settings.update'), asyncHandler((req, res) => {
  res.json(settingsService.update(req.body, req.context));
}));
router.get('/settings/backups', requirePermission('settings.backup'), asyncHandler((_req, res) => {
  res.json({ rows: backupService.list() });
}));
router.post('/settings/backups', requirePermission('settings.backup'), asyncHandler((req, res) => {
  res.status(201).json(backupService.create(req.context));
}));
router.get('/settings/backups/:file/download', requirePermission('settings.backup'), asyncHandler((req, res) => {
  res.download(backupService.resolve(req.params.file));
}));
router.post('/settings/backups/:file/restore', requirePermission('settings.backup'), asyncHandler((req, res) => {
  res.json(backupService.restore(req.params.file, req.context));
}));
router.delete('/settings/backups/:file', requirePermission('settings.backup'), asyncHandler((req, res) => {
  res.json(backupService.remove(req.params.file, req.context));
}));

export default router;
