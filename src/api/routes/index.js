/** API composition: mounts every module router under /api. */
import { Router } from 'express';
import config from '../../config/index.js';
import {
  asyncHandler, authenticate, requirePermission, sendImage, validate,
} from '../middleware/index.js';
import { crudRouter } from './crudRouter.js';
import * as v from '../validators.js';

import authService from '../../services/AuthService.js';
import dashboardService from '../../services/DashboardService.js';
import catalogService from '../../services/CatalogService.js';
import imageService from '../../services/ImageService.js';
import inventoryService from '../../services/InventoryService.js';
import purchaseService from '../../services/PurchaseService.js';
import salesService from '../../services/SalesService.js';
import returnService from '../../services/ReturnService.js';
import promotionService from '../../services/PromotionService.js';
import reportService from '../../services/ReportService.js';
import labelService from '../../services/LabelService.js';
import auditService from '../../services/AuditService.js';
import { userService, settingsService, backupService } from '../../services/AdminService.js';
import passwordResetService from '../../services/PasswordResetService.js';
import webOrderService from '../../services/WebOrderService.js';
import {
  supplierService, brandService, categoryService, warehouseService,
  customerService, attributeService,
} from '../../services/masterDataServices.js';
import repositories from '../../infrastructure/repositories/index.js';
import { NotFoundError } from '../../shared/errors.js';

const router = Router();

// ----------------------------------------------------------------- session
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // offline LAN/localhost deployment
  maxAge: 12 * 60 * 60 * 1000,
};

router.post('/auth/login', validate(v.loginSchema), asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, req.context.request);
  res.cookie(config.auth.cookieName, result.token, cookieOptions);
  res.json({ user: result.user, token: result.token });
}));

router.post('/auth/logout', authenticate, asyncHandler(async (req, res) => {
  await authService.logout(req.context.actor, req.context.request);
  res.clearCookie(config.auth.cookieName);
  res.json({ ok: true });
}));

router.get('/auth/me', authenticate, asyncHandler(async (req, res) => {
  const [user, settings, warehouses] = await Promise.all([
    authService.profile(req.user.id),
    settingsService.all(),
    repositories.warehouses.activeOnly(),
  ]);
  res.json({ user, settings, warehouses });
}));

router.post('/auth/password', authenticate, validate(v.changePasswordSchema), asyncHandler(async (req, res) => {
  res.json(await authService.changePassword(req.user.id, req.body, req.context));
}));

router.put('/auth/preferences', authenticate, asyncHandler(async (req, res) => {
  res.json(await authService.updatePreferences(req.user.id, req.body, req.context));
}));

/**
 * Raising a password reset is deliberately unauthenticated — the whole point is
 * that the caller cannot sign in. The service always answers the same way, so
 * this cannot be used to discover which usernames exist.
 */
router.post('/auth/forgot-password', validate(v.forgotPasswordSchema), asyncHandler(async (req, res) => {
  res.json(await passwordResetService.request(req.body, req.context.request));
}));

// Everything below requires a session.
router.use(authenticate);

// --------------------------------------------------------------- dashboard
router.get('/dashboard', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  res.json(await dashboardService.overview({ warehouseId: req.query.warehouseId || null }));
}));

router.get('/dashboard/alerts', requirePermission('dashboard.view'), asyncHandler(async (req, res) => {
  res.json({ rows: await dashboardService.alerts({ warehouseId: req.query.warehouseId || null }) });
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
    r.get('/tree', perm('view'), asyncHandler(async (_req, res) => res.json({ rows: await categoryService.tree() })));
  },
}));

// One shop location. It is created by the seed and edited in Settings; there is
// deliberately no create/delete route.
router.get('/location', requirePermission('settings.view'), asyncHandler(async (_req, res) => {
  res.json(await repositories.warehouses.single());
}));
router.put('/location', requirePermission('settings.update'), validate(v.warehouseSchema.partial()),
  asyncHandler(async (req, res) => {
    const location = await repositories.warehouses.single();
    res.json(await warehouseService.update(location.id, req.body, req.context));
  }));

router.use('/customers', crudRouter({
  service: customerService,
  module: 'customers',
  schema: v.customerSchema,
  extend: (r, { perm }) => {
    r.get('/search', perm('view'), asyncHandler(async (req, res) => {
      res.json({ rows: await customerService.search(req.query.q || '', 15) });
    }));
    r.post('/:id/settle', requirePermission('customers.update'), validate(v.paymentSchema),
      asyncHandler(async (req, res) => {
        res.json(await customerService.settleBalance(Number(req.params.id), req.body, req.context));
      }));
  },
}));

router.use('/attributes', crudRouter({
  service: attributeService,
  module: 'attributes',
  schema: v.attributeSchema,
  extend: (r, { perm }) => {
    r.get('/with-values', perm('view'), asyncHandler(async (_req, res) => {
      res.json({ rows: await attributeService.withValues() });
    }));
    r.post('/:id/values', requirePermission('attributes.create'), validate(v.attributeValueSchema),
      asyncHandler(async (req, res) => {
        res.status(201).json(await attributeService.addValue(Number(req.params.id), req.body, req.context));
      }));
    r.put('/values/:valueId', requirePermission('attributes.update'),
      validate(v.attributeValueSchema.partial()), asyncHandler(async (req, res) => {
        res.json(await attributeService.updateValue(Number(req.params.valueId), req.body, req.context));
      }));
    r.delete('/values/:valueId', requirePermission('attributes.delete'), asyncHandler(async (req, res) => {
      res.json(await attributeService.removeValue(Number(req.params.valueId), req.context));
    }));
  },
}));

// ---------------------------------------------------------------- products
router.get('/products', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.list(req.query));
}));

router.get('/products/lookup', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json({ rows: await catalogService.lookup(req.query.q, req.query.warehouseId) });
}));

router.get('/products/scan/:code', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.findByCode(req.params.code));
}));

router.post('/products/combinations', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json({ rows: await catalogService.generateCombinations(req.body.attribute_ids || []) });
}));

router.post('/products/bulk-price', requirePermission('products.update'), asyncHandler(async (req, res) => {
  res.json(await catalogService.bulkUpdatePrices(req.body, req.context));
}));

router.get('/products/variants/:variantId', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.variantDetails(Number(req.params.variantId)));
}));

router.get('/products/:id/overview', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.overview(Number(req.params.id), { days: req.query.days }));
}));

router.get('/products/:id', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.get(Number(req.params.id)));
}));

router.post('/products', requirePermission('products.create'), validate(v.productSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await catalogService.save(req.body, req.context));
  }));

router.put('/products/:id', requirePermission('products.update'), validate(v.productSchema),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.save(req.body, req.context, Number(req.params.id)));
  }));

router.delete('/products/:id', requirePermission('products.delete'), asyncHandler(async (req, res) => {
  res.json(await catalogService.remove(Number(req.params.id), req.context));
}));

// --------------------------------------------------------------- photos
// Uploading, arranging and deleting a photo is editing the product, so it is
// `products.update`; looking at one is `products.view`.
router.get('/products/:id/images', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json({ rows: await imageService.list(Number(req.params.id)) });
}));

/**
 * The bytes, for the editor's own gallery. The shop has its own endpoint that
 * needs no session — this one exists because a product is photographed long
 * before it is published, and until then it is only visible to staff.
 */
router.get('/products/:id/images/:imageId/raw', requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const image = await imageService.bytes(Number(req.params.imageId));
    if (!image) throw new NotFoundError('Product photo', req.params.imageId);
    sendImage(req, res, image, { cacheControl: 'private, max-age=31536000, immutable' });
  }));

router.post('/products/:id/images', requirePermission('products.update'),
  validate(v.productImageSchema), asyncHandler(async (req, res) => {
    res.status(201).json(await imageService.add(Number(req.params.id), req.body, req.context));
  }));

// Registered before `/:imageId`, which would otherwise swallow the word "order".
router.put('/products/:id/images/order', requirePermission('products.update'),
  validate(v.imageOrderSchema), asyncHandler(async (req, res) => {
    res.json(await imageService.reorder(Number(req.params.id), req.body.ids, req.context));
  }));

router.put('/products/:id/images/:imageId/primary', requirePermission('products.update'),
  asyncHandler(async (req, res) => {
    res.json(await imageService.setPrimary(Number(req.params.id), Number(req.params.imageId), req.context));
  }));

router.put('/products/:id/images/:imageId', requirePermission('products.update'),
  validate(v.productImageUpdateSchema), asyncHandler(async (req, res) => {
    res.json(await imageService.update(
      Number(req.params.id), Number(req.params.imageId), req.body, req.context,
    ));
  }));

router.delete('/products/:id/images/:imageId', requirePermission('products.update'),
  asyncHandler(async (req, res) => {
    res.json(await imageService.remove(Number(req.params.id), Number(req.params.imageId), req.context));
  }));

// --------------------------------------------------------------- inventory
router.get('/inventory/stock', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventoryService.stockOnHand({
    ...req.query,
    lowStockOnly: req.query.lowStockOnly === '1' || req.query.lowStockOnly === 'true',
  }));
}));

router.get('/inventory/low-stock', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json({ rows: await inventoryService.lowStock(req.query.warehouseId) });
}));

router.get('/inventory/movements', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventoryService.movements(req.query));
}));

router.post('/inventory/quick-adjust', requirePermission('inventory.adjust'),
  validate(v.quickAdjustSchema), asyncHandler(async (req, res) => {
    res.json(await inventoryService.quickAdjust(req.body, req.context));
  }));

router.get('/inventory/count-sheet', requirePermission('inventory.count'), asyncHandler(async (req, res) => {
  res.json({ rows: await inventoryService.buildCountSheet(req.query) });
}));

router.get('/inventory/adjustments', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventoryService.listAdjustments(req.query));
}));
router.get('/inventory/adjustments/:id', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventoryService.getAdjustment(Number(req.params.id)));
}));
router.post('/inventory/adjustments', requirePermission('inventory.adjust'), validate(v.adjustmentSchema),
  asyncHandler(async (req, res) => res.status(201).json(await inventoryService.saveAdjustment(req.body, req.context))));
router.put('/inventory/adjustments/:id', requirePermission('inventory.adjust'), validate(v.adjustmentSchema),
  asyncHandler(async (req, res) => res.json(
    await inventoryService.saveAdjustment(req.body, req.context, Number(req.params.id)),
  )));
router.post('/inventory/adjustments/:id/post', requirePermission('inventory.adjust'),
  asyncHandler(async (req, res) => res.json(await inventoryService.postAdjustment(Number(req.params.id), req.context))));

// --------------------------------------------------------------- purchases
router.get('/purchases', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseService.list(req.query));
}));
router.get('/purchases/reorder-suggestions', requirePermission('purchases.create'),
  asyncHandler(async (req, res) => res.json({ rows: await purchaseService.suggestReorder(req.query.warehouseId) })));
router.get('/purchases/:id', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseService.get(Number(req.params.id)));
}));
router.post('/purchases', requirePermission('purchases.create'), validate(v.purchaseOrderSchema),
  asyncHandler(async (req, res) => res.status(201).json(await purchaseService.save(req.body, req.context))));
router.put('/purchases/:id', requirePermission('purchases.update'), validate(v.purchaseOrderSchema),
  asyncHandler(async (req, res) => res.json(await purchaseService.save(req.body, req.context, Number(req.params.id)))));
router.post('/purchases/:id/approve', requirePermission('purchases.approve'),
  asyncHandler(async (req, res) => res.json(await purchaseService.approve(Number(req.params.id), req.context))));
router.post('/purchases/:id/receive', requirePermission('purchases.receive'), validate(v.receiveSchema),
  asyncHandler(async (req, res) => res.json(await purchaseService.receive(Number(req.params.id), req.body, req.context))));
router.post('/purchases/:id/payment', requirePermission('purchases.update'), validate(v.paymentSchema),
  asyncHandler(async (req, res) => res.json(
    await purchaseService.registerPayment(Number(req.params.id), req.body, req.context),
  )));
router.post('/purchases/:id/cancel', requirePermission('purchases.update'),
  asyncHandler(async (req, res) => res.json(
    await purchaseService.cancel(Number(req.params.id), req.body?.reason, req.context),
  )));
router.delete('/purchases/:id', requirePermission('purchases.delete'),
  asyncHandler(async (req, res) => res.json(await purchaseService.remove(Number(req.params.id), req.context))));

// ------------------------------------------------------------------- sales
router.get('/sales', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await salesService.list(req.query));
}));
router.post('/sales/quote', requirePermission('sales.create'), asyncHandler(async (req, res) => {
  res.json(await salesService.quote(req.body));
}));
router.get('/sales/shift-summary', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await salesService.shiftSummary({
    userId: req.query.userId || req.user.id,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  }));
}));
router.get('/returns/policy', requirePermission('sales.return', 'sales.view'),
  asyncHandler(async (_req, res) => res.json(await returnService.policy())));
router.get('/returns/lookup', requirePermission('sales.return'), asyncHandler(async (req, res) => {
  res.json(await returnService.lookupInvoice(req.query.reference));
}));
router.get('/returns/item/:code', requirePermission('sales.return'), asyncHandler(async (req, res) => {
  res.json(await returnService.lookupItem(req.params.code));
}));
router.get('/returns/reasons', requirePermission('reports.view', 'sales.view'),
  asyncHandler(async (req, res) => res.json({ rows: await returnService.reasonBreakdown(req.query) })));
router.get('/returns', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await returnService.list(req.query));
}));
router.get('/returns/:id', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await returnService.get(Number(req.params.id)));
}));
router.post('/returns', requirePermission('sales.return'), validate(v.returnSchema),
  asyncHandler(async (req, res) => res.status(201).json(
    await returnService.create(req.body, { ...req.context, permissions: req.permissions }),
  )));
router.get('/sales/:id', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await salesService.get(Number(req.params.id)));
}));
router.post('/sales', requirePermission('sales.create'), validate(v.saleSchema),
  asyncHandler(async (req, res) => res.status(201).json(await salesService.checkout(req.body, req.context))));
router.post('/sales/:id/void', requirePermission('sales.void'),
  asyncHandler(async (req, res) => res.json(await salesService.void(Number(req.params.id), req.body?.reason, req.context))));
router.post('/sales/:id/payment', requirePermission('sales.create'), validate(v.paymentSchema),
  asyncHandler(async (req, res) => res.json(
    await salesService.registerPayment(Number(req.params.id), req.body, req.context),
  )));

// -------------------------------------------------------------- web orders
// The staff side of the shop. Placing and tracking an order is public and lives
// in `shopOrders.js`; everything that decides an order's fate is here, behind a
// session, because confirming one issues stock and raises an invoice.
router.get('/web-orders', requirePermission('weborders.view'), asyncHandler(async (req, res) => {
  res.json(await webOrderService.list({ status: req.query.status, page: req.query.page }));
}));

// Registered before `/:id`, which would otherwise swallow the word "count".
router.get('/web-orders/count', requirePermission('weborders.view'), asyncHandler(async (_req, res) => {
  res.json({ pending: await webOrderService.pendingCount() });
}));

router.get('/web-orders/:id', requirePermission('weborders.view'), asyncHandler(async (req, res) => {
  res.json(await webOrderService.get(Number(req.params.id)));
}));

router.post('/web-orders/:id/confirm', requirePermission('weborders.confirm'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.confirm(Number(req.params.id), req.context));
  }));

router.post('/web-orders/:id/cancel', requirePermission('weborders.cancel'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.cancel(Number(req.params.id), req.body?.reason, req.context));
  }));

// Delivery is the end of the same job as confirming it, so it needs no
// permission of its own.
router.post('/web-orders/:id/delivered', requirePermission('weborders.confirm'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.markDelivered(Number(req.params.id), req.context));
  }));

// -------------------------------------------------------------- promotions
router.use('/promotions', crudRouter({
  service: promotionService,
  module: 'promotions',
  schema: v.promotionSchema,
  extend: (r, { perm }) => {
    r.post('/evaluate', requirePermission('sales.create', 'promotions.view'), asyncHandler(async (req, res) => {
      res.json(await promotionService.evaluate(req.body));
    }));
    r.get('/validate/:code', perm('view'), asyncHandler(async (req, res) => {
      res.json(await promotionService.validateCode(req.params.code, req.context));
    }));
    r.get('/usage', perm('view'), asyncHandler(async (req, res) => {
      res.json({ rows: await promotionService.usageReport(req.query) });
    }));
    r.post('/vouchers/generate', requirePermission('promotions.create'), validate(v.voucherBatchSchema),
      asyncHandler(async (req, res) => res.status(201).json({
        rows: await promotionService.generateVouchers(req.body, req.context),
      })));
  },
}));

// ----------------------------------------------------------------- reports
router.get('/reports', requirePermission('reports.view'), asyncHandler((req, res) => {
  res.json({ rows: reportService.catalogue(req.permissions) });
}));
router.get('/reports/:key', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  const report = await reportService.run(req.params.key, req.query);
  if (req.query.format === 'csv') {
    await auditService.record({
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
router.get('/audit', requirePermission('audit.view'), asyncHandler(async (req, res) => {
  res.json(await auditService.list(req.query));
}));
router.get('/audit/filters', requirePermission('audit.view'), asyncHandler(async (_req, res) => {
  res.json(await auditService.filters());
}));

// ------------------------------------------------------------------- users
router.get('/users', requirePermission('users.view'), asyncHandler(async (req, res) => {
  res.json(await userService.list(req.query));
}));
router.get('/users/roles', requirePermission('users.view'), asyncHandler(async (_req, res) => {
  res.json({ rows: await userService.roles(), permissions: userService.permissionCatalogue() });
}));
router.put('/users/roles/:id/permissions', requirePermission('users.update'), asyncHandler(async (req, res) => {
  res.json(await userService.updateRolePermissions(Number(req.params.id), req.body.permissions || [], req.context));
}));
router.get('/users/reset-requests', requirePermission('users.view'), asyncHandler(async (req, res) => {
  res.json(await passwordResetService.list({ status: req.query.status || 'pending' }));
}));

router.get('/users/reset-requests/count', requirePermission('users.view'), asyncHandler(async (_req, res) => {
  res.json({ pending: await passwordResetService.pendingCount() });
}));

router.post('/users/reset-requests/:id/approve', requirePermission('users.reset_password'),
  asyncHandler(async (req, res) => {
    res.json(await passwordResetService.approve(Number(req.params.id), req.context));
  }));

router.post('/users/reset-requests/:id/reject', requirePermission('users.reset_password'),
  asyncHandler(async (req, res) => {
    res.json(await passwordResetService.reject(Number(req.params.id), req.context));
  }));

router.get('/users/:id', requirePermission('users.view'), asyncHandler(async (req, res) => {
  res.json(await userService.get(Number(req.params.id)));
}));
router.post('/users', requirePermission('users.create'), validate(v.userSchema),
  asyncHandler(async (req, res) => res.status(201).json(await userService.create(req.body, req.context))));
router.put('/users/:id', requirePermission('users.update'), validate(v.userUpdateSchema),
  asyncHandler(async (req, res) => res.json(await userService.update(Number(req.params.id), req.body, req.context))));
router.delete('/users/:id', requirePermission('users.delete'),
  asyncHandler(async (req, res) => res.json(await userService.remove(Number(req.params.id), req.context))));

// ---------------------------------------------------------------- settings
router.get('/settings', requirePermission('settings.view'), asyncHandler(async (_req, res) => {
  res.json(await settingsService.all());
}));
router.put('/settings', requirePermission('settings.update'), asyncHandler(async (req, res) => {
  res.json(await settingsService.update(req.body, req.context));
}));
// backupService.list() and .resolve() only touch the filesystem, so they stay sync.
router.get('/settings/backups', requirePermission('settings.backup'), asyncHandler((_req, res) => {
  res.json({ rows: backupService.list() });
}));
router.post('/settings/backups', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  res.status(201).json(await backupService.create(req.context));
}));
router.get('/settings/backups/:file/download', requirePermission('settings.backup'), asyncHandler((req, res) => {
  res.download(backupService.resolve(req.params.file));
}));
router.post('/settings/backups/:file/restore', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  res.json(await backupService.restore(req.params.file, req.context));
}));
router.delete('/settings/backups/:file', requirePermission('settings.backup'), asyncHandler(async (req, res) => {
  res.json(await backupService.remove(req.params.file, req.context));
}));

export default router;
