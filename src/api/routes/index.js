/** API composition: mounts every module router under /api. */
import { Router } from 'express';
import config from '../../config/index.js';
import {
  asyncHandler, authenticate, requirePermission, requireLookup, sendImage, validate,
} from '../middleware/index.js';
import { crudRouter } from './crudRouter.js';
import * as v from '../validators.js';

import authService from '../../services/AuthService.js';
import dashboardService from '../../services/DashboardService.js';
import catalogService from '../../services/CatalogService.js';
import imageService from '../../services/ImageService.js';
import attachmentService from '../../services/AttachmentService.js';
import inventoryService from '../../services/InventoryService.js';
import purchaseService from '../../services/PurchaseService.js';
import salesService from '../../services/SalesService.js';
import returnService from '../../services/ReturnService.js';
import exchangeService from '../../services/ExchangeService.js';
import promotionService from '../../services/PromotionService.js';
import reportService from '../../services/ReportService.js';
import costService from '../../services/CostService.js';
import legacyInvoiceService from '../../services/LegacyInvoiceService.js';
import costCategoryService from '../../services/CostCategoryService.js';
import payrollService, { employeeService } from '../../services/PayrollService.js';
import labelService from '../../services/LabelService.js';
import auditService from '../../services/AuditService.js';
import { userService, settingsService, backupService } from '../../services/AdminService.js';
import dataExportService from '../../services/DataExportService.js';
import webAssetService, { brandSlot } from '../../services/WebAssetService.js';
import trashService from '../../services/trash/TrashService.js';
import passwordResetService from '../../services/PasswordResetService.js';
import webOrderService from '../../services/WebOrderService.js';
import {
  supplierService, brandService, categoryService, warehouseService,
  customerService, attributeService,
} from '../../services/masterDataServices.js';
import repositories from '../../infrastructure/repositories/index.js';
import purchaseReturnService from '../../services/PurchaseReturnService.js';
import { currentTenant, supportsFileBackup, driverName } from '../../infrastructure/database/connection.js';
import { buildBranding, companyNameFrom } from '../../shared/branding.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { deploymentInfo } from '../../shared/deploymentInfo.js';

const router = Router();

// ----------------------------------------------------------------- session

/**
 * Tenant metadata for the shell — which modules are enabled, whether the
 * website is on, the tenant's own display name. Deliberately unauthenticated
 * (like `/api/shop/config`): none of this is secret, and the sidebar needs it
 * before it knows whether a session even exists. `null` in single-shop mode,
 * where there is nothing to report and nothing changes.
 */
router.get('/session', asyncHandler(async (req, res) => {
  const tenant = currentTenant();
  res.json({
    tenant: tenant ? {
      slug: tenant.slug,
      name: tenant.name,
      modules: [...tenant.modules],
      websiteEnabled: tenant.websiteEnabled,
    } : null,
    // Which deployment this till is on. It rides on the call the shell already
    // makes before its first paint, so the staging frame is drawn with the
    // sidebar rather than after a second request — and a production ERP pays
    // one extra word in a JSON body it was already receiving.
    deployment: deploymentInfo(),
    // The shop's own identity, so the ERP sidebar shows the shop the staff
    // work for rather than the first tenant's monogram. Same block and the
    // same rules as `/api/shop/config` — built by shared/branding.js from the
    // same settings — so the two screens can never disagree about a shop's
    // name, mark or accent.
    branding: await erpBranding(),
  });
}));

/**
 * `branding` for the ERP shell.
 *
 * Read through the settings repository rather than the storefront's query,
 * because this is the ERP side of the house and the storefront's hand-written
 * SQL is its own by doctrine; the block itself is assembled by the same shared
 * builder, so the values are identical.
 *
 * Never throws. This runs on an unauthenticated route that the shell calls
 * before it knows whether a session exists, and it is the one endpoint that
 * must answer during first-run and while a database is being provisioned —
 * a sidebar without a logo is a cosmetic loss, a 500 here is a blank screen.
 *
 * `logo` points at the public storefront URL, which is the only place the
 * bytes are served without a permission a cashier does not have. A tenant that
 * has switched its website off closes that route with everything else public,
 * and the sidebar falls back to the monogram — which is exactly what a shop
 * with no logo shows anyway.
 */
async function erpBranding() {
  try {
    const [settings, logo] = await Promise.all([
      settingsService.all(),
      webAssetService.get('logo'),
    ]);
    const get = (key) => settings[key];
    return buildBranding({
      get,
      companyName: companyNameFrom(get, currentTenant()),
      hasLogo: logo.hasImage,
    });
  } catch {
    return null;
  }
}

/**
 * The session cookie, scoped to the shop it belongs to.
 *
 * Three things here, and each one is load-bearing:
 *
 *   · `path` is the tenant's own base, so the BROWSER does not send one shop's
 *     cookie to another shop on the same domain. The server refuses such a
 *     token anyway (see the tenant claim in middleware/index.js), but a cookie
 *     that is never sent cannot be replayed, logged by a proxy, or picked up by
 *     a mistake in some future route. Two shops open in two tabs also stop
 *     fighting over one cookie, which they did.
 *   · `secure` follows the connection rather than being hard-coded off. The
 *     deployment is HTTPS and the shop PC is plain HTTP on a LAN; a fixed
 *     `false` meant the live shop's session cookie was allowed onto an
 *     unencrypted connection, and a fixed `true` would lock the shop PC out.
 *     `req.secure` answers it per request (the app sets `trust proxy`, so a
 *     load balancer's X-Forwarded-Proto is honoured).
 *   · `sameSite: 'lax'` stays: it blocks the cross-site POST shape of CSRF
 *     while leaving ordinary navigation to the shop working.
 */
function cookieOptionsFor(req) {
  const slug = req.tenant?.slug || null;
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    path: slug ? `/t/${slug}` : '/',
    maxAge: 12 * 60 * 60 * 1000,
  };
}

router.post('/auth/login', validate(v.loginSchema), asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, req.context.request);
  res.cookie(config.auth.cookieName, result.token, cookieOptionsFor(req));
  res.json({ user: result.user, token: result.token });
}));

router.post('/auth/logout', authenticate, asyncHandler(async (req, res) => {
  await authService.logout(req.context.actor, req.context.request);
  // Cleared with the same scope it was set with, or the browser keeps it.
  res.clearCookie(config.auth.cookieName, cookieOptionsFor(req));
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
// Registered before the CRUD router, which would otherwise read "summary" as an id.
router.get('/suppliers/summary', requirePermission('suppliers.view'), asyncHandler(async (_req, res) => {
  res.json(await repositories.suppliers.summary());
}));

router.use('/suppliers', crudRouter({
  service: supplierService, module: 'suppliers', schema: v.supplierSchema,
}));

router.use('/brands', crudRouter({
  service: brandService,
  module: 'brands',
  schema: v.brandSchema,
  /**
   * A brand's own logo — the picture a shopper actually recognises.
   *
   * The storefront's brands rail used to be sixty identical text pills, and the
   * shop's answer to "which of these is ديور" was to read all sixty. A mark is
   * what makes that scannable, so a brand gets a picture the same way the
   * banner and the shop's own logo do: a row in `web_assets`, in a slot named
   * after the brand. No new table, no second mechanism, and the same audit
   * trail — see WebAssetService.
   *
   * Uploading one is `brands.update`: it is editing the brand, not a settings
   * change, and the person who may rename a brand may give it a logo.
   */
  extend: (r, { perm }) => {
    const slotOf = async (req) => {
      // 404 before anything else, so an id that is not a brand cannot be used
      // to probe or to occupy a slot.
      await brandService.get(Number(req.params.id));
      return brandSlot(req.params.id);
    };

    r.get('/:id/logo', perm('view'), asyncHandler(async (req, res) => {
      res.json(await webAssetService.get(await slotOf(req)));
    }));

    r.get('/:id/logo/raw', perm('view'), asyncHandler(async (req, res) => {
      const image = await webAssetService.bytes(await slotOf(req));
      if (!image) throw new NotFoundError('Brand logo', req.params.id);
      // One URL that outlives the bytes behind it, exactly as the banner's is:
      // an owner who replaces a logo must not be told it worked by a cache.
      sendImage(req, res, { ...image, created_at: image.updated_at }, { cacheControl: 'private, no-cache' });
    }));

    r.put('/:id/logo', perm('update'), validate(v.websiteLogoSchema), asyncHandler(async (req, res) => {
      res.json(await webAssetService.set(req.body.dataUrl, req.context, await slotOf(req)));
    }));

    r.delete('/:id/logo', perm('update'), asyncHandler(async (req, res) => {
      res.json(await webAssetService.clear(req.context, await slotOf(req)));
    }));
  },
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

/*
 * The counters above the products grid. Same filters as the list below them, on
 * purpose - see ProductRepository#scope.
 */
router.get('/products/summary', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.summary(req.query));
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

/**
 * Change one field on many products at once.
 *
 * `products.update` — the same right as editing one, because that is all this
 * is. The service decides which fields may be touched; this route only carries
 * the request.
 */
/*
 * الاستبدال — an exchange.
 *
 * `sales.exchange`, which migration 023 grants to whoever already takes
 * returns. Every refusal a return has still applies underneath: this route is
 * the door, and `ExchangeService` runs both halves inside one transaction.
 */
router.get('/exchanges', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await exchangeService.list(req.query));
}));
router.get('/exchanges/:id', requirePermission('sales.view'), asyncHandler(async (req, res) => {
  res.json(await exchangeService.get(Number(req.params.id)));
}));
router.post('/exchanges', requirePermission('sales.exchange'), validate(v.exchangeSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await exchangeService.create(req.body, req.context));
  }));

router.post('/products/bulk', requirePermission('products.update'), validate(v.bulkProductSchema),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.bulkUpdate(req.body, req.context));
  }));

router.post('/products/bulk-price', requirePermission('products.update'), asyncHandler(async (req, res) => {
  res.json(await catalogService.bulkUpdatePrices(req.body, req.context));
}));

/**
 * The gender classifier: what the shop has, and what each name suggests.
 *
 * A read behind `products.view` and a write behind `products.update` — the same
 * two rights that govern opening a product and editing one, because that is all
 * this is: the same edit, made three hundred times, by somebody who would
 * otherwise be making it three hundred times by hand.
 */
router.get('/products/gender-review', requirePermission('products.view'), asyncHandler(async (req, res) => {
  res.json(await catalogService.genderReview({ onlyUnset: req.query.onlyUnset === '1' }));
}));

router.post('/products/gender', requirePermission('products.update'), validate(v.genderAssignSchema),
  asyncHandler(async (req, res) => {
    res.json(await catalogService.assignGenders(req.body.assignments, req.context));
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

// ------------------------------------------------------------- attachments
/**
 * Photographs of paper, for any kind of owner that has registered one.
 *
 * These four routes are the whole serving half of the attachment contract — a
 * cost or a salary payment gets them for free the moment its service calls
 * `attachmentService.registerOwner()`. Nothing here mentions a purchase.
 *
 * The permission is not written in the route because it cannot be: it belongs
 * to the owner type, which arrives in the URL. So the registration is looked up
 * first and `requirePermission` is then applied with the code it named — which
 * keeps RBAC *and* the tenant's module entitlement exactly as they are
 * everywhere else, rather than inventing a second, weaker check here.
 */
const runGuard = (code, req, res) => new Promise((resolve, reject) => {
  requirePermission(code)(req, res, (error) => (error ? reject(error) : resolve()));
});

/** Guard by the owner type in the path. Unknown type -> 404, not 403. */
const guardOwnerType = (right) => asyncHandler(async (req, res, next) => {
  const rules = attachmentService.owner(req.params.ownerType);
  await runGuard(rules[right], req, res);
  next();
});

/**
 * The bytes. `?size=thumb` is the small preview a list shows; anything else is
 * the readable photograph, which is only fetched when somebody opens one.
 *
 * Registered BEFORE `/:ownerType/:ownerId`, which is the same three segments
 * and would otherwise swallow this one and go looking for an owner type called
 * "1". (A registered owner type named `raw` would collide the other way — so
 * do not name one that.)
 *
 * The row has to be read before the permission can be known — the id alone
 * says nothing about who owns it — so the guard runs on what the row says its
 * owner type is, never on anything the caller sent.
 */
router.get('/attachments/:id/raw', asyncHandler(async (req, res) => {
  const meta = await attachmentService.find(Number(req.params.id));
  const rules = attachmentService.owner(meta.owner_type);
  await runGuard(rules.view, req, res);
  const bytes = await attachmentService.bytes(meta.id, req.query.size === 'thumb' ? 'thumb' : 'full');
  sendImage(req, res, bytes, { cacheControl: 'private, max-age=31536000, immutable' });
}));

router.get('/attachments/:ownerType/:ownerId', guardOwnerType('view'),
  asyncHandler(async (req, res) => res.json({
    rows: await attachmentService.list(req.params.ownerType, Number(req.params.ownerId)),
  })));

router.post('/attachments/:ownerType/:ownerId', guardOwnerType('attach'),
  validate(v.attachedPhotoSchema), asyncHandler(async (req, res) => res.status(201).json(
    await attachmentService.attach(
      req.params.ownerType, Number(req.params.ownerId), req.body, req.context,
    ),
  )));

router.delete('/attachments/:id', asyncHandler(async (req, res) => {
  const meta = await attachmentService.find(Number(req.params.id));
  const rules = attachmentService.owner(meta.owner_type);
  await runGuard(rules.attach, req, res);
  res.json(await attachmentService.remove(meta.id, req.context));
}));

// --------------------------------------------------------------- inventory
router.get('/inventory/stock', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventoryService.stockOnHand({
    ...req.query,
    lowStockOnly: req.query.lowStockOnly === '1' || req.query.lowStockOnly === 'true',
  }));
}));

/*
 * The counters above the stock grid, from the SAME query the home screen's stock
 * tile and the valuation report use - one shelf, one set of numbers.
 */
/* ------------------------------------------- goods going back to the supplier */
router.get('/purchase-returns', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseReturnService.list(req.query));
}));

router.get('/purchase-returns/:id', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseReturnService.get(Number(req.params.id)));
}));

router.post('/purchase-returns', requirePermission('purchases.return'), validate(v.purchaseReturnSchema),
  asyncHandler(async (req, res) => res.status(201).json(
    await purchaseReturnService.create(req.body, req.context),
  )));

router.post('/purchase-returns/:id/reverse', requirePermission('purchases.return'),
  asyncHandler(async (req, res) => res.json(
    await purchaseReturnService.reverse(Number(req.params.id), req.body?.reason, req.context),
  )));

router.get('/inventory/summary', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await repositories.inventory.valuation({
    warehouseId: req.query.warehouseId || null,
    brandId: req.query.brandId || null,
    categoryId: req.query.categoryId || null,
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

/*
 * الهدر — what the shop lost.
 *
 * Its own module, so it can be sold and switched per shop from the console, and
 * its own two codes: seeing what was lost is the same order of secret as seeing
 * what the shop holds, and writing four bottles off is the same trust as
 * adjusting the shelf they were on. Migration 020 hands both to the roles that
 * already held the rights they were carved out of.
 */
router.get('/inventory/wastage', requirePermission('wastage.view'), asyncHandler(async (req, res) => {
  const window = {
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
    warehouseId: req.query.warehouseId ? Number(req.query.warehouseId) : null,
  };
  const [summary, rows] = await Promise.all([
    inventoryService.wastageSummary(window),
    inventoryService.wastageList(window),
  ]);
  res.json({ summary, rows });
}));
router.post('/inventory/wastage', requirePermission('wastage.record'), validate(v.wastageSchema),
  asyncHandler(async (req, res) => res.status(201).json(
    await inventoryService.recordWastage(req.body, req.context),
  )));

/*
 * سلة المهملات — one door for deleting anything, one register of what was
 * deleted, one way back. See services/trash/TrashService.js for the whole
 * design, and services/trash/policies.js for what may be deleted and what
 * deleting it costs.
 *
 * `preview` changes nothing and is what the confirm dialog shows. `remove`
 * asks the same question again before it acts, so a blocker cannot be skipped
 * by calling this API directly.
 */
router.get('/trash', requirePermission('trash.view'), asyncHandler(async (req, res) => {
  res.json(await trashService.list(req.query));
}));
router.get('/trash/summary', requirePermission('trash.view'), asyncHandler(async (_req, res) => {
  res.json(await trashService.summary());
}));
/**
 * May this person delete this kind of thing?
 *
 * NOT `trash.view`. That is the right to READ the register — who deleted what,
 * across every module — and by design it goes out with the audit log, to few
 * people. Deleting is a different act with a different right, and it is the
 * right to delete THE THING: whoever may delete a product deletes one here,
 * and the bin is merely where it lands. Gating either of these two routes on
 * `trash.view` would mean every delete button in the shop worked for the
 * administrator and for nobody else.
 *
 * `req.permissions` is what `authenticate` puts on the request — the codes this
 * user actually holds. Any ONE of the three is enough, and which one applies
 * depends on what the thing is: master data is deleted by whoever may delete
 * it, an invoice by whoever may void one, a document with no delete right of
 * its own by whoever may edit it. Both routes run behind
 * `router.use(authenticate)`, so neither is ever open to a stranger.
 */
async function assertMayDelete(req, entityType) {
  const policy = await trashService.policyFor(entityType);
  const codes = [`${policy.module}.delete`, `${policy.module}.void`, `${policy.module}.update`];
  const held = req.permissions || [];
  if (!codes.some((code) => held.includes(code))) {
    throw new ForbiddenError(
      `You do not have permission to delete this (${policy.module}.delete)`,
    );
  }
  return policy;
}

// The confirm dialog every delete button opens: the same right as the delete
// it is about to ask for, because a person who may do it may read what it costs.
router.get('/trash/preview/:entityType/:entityId', asyncHandler(async (req, res) => {
  await assertMayDelete(req, req.params.entityType);
  res.json(await trashService.preview(req.params.entityType, Number(req.params.entityId)));
}));
router.post('/trash', validate(v.trashDeleteSchema),
  asyncHandler(async (req, res) => {
    await assertMayDelete(req, req.body.entityType);
    res.status(201).json(await trashService.remove(req.body.entityType, req.body.entityId, {
      reason: req.body.reason || null,
      context: req.context,
    }));
  }));
router.post('/trash/:id/restore', requirePermission('trash.restore'),
  asyncHandler(async (req, res) => res.json(
    await trashService.restore(Number(req.params.id), { context: req.context }),
  )));
router.delete('/trash/:id', requirePermission('trash.purge'),
  asyncHandler(async (req, res) => res.json(
    await trashService.purge(Number(req.params.id), {
      context: req.context,
      // Destroying something before its thirty days are up is a deliberate,
      // separate act — not the default, and not reachable by accident.
      force: req.query.force === '1',
    }),
  )));
router.post('/trash/sweep', requirePermission('trash.purge'), asyncHandler(async (req, res) => {
  res.json(await trashService.sweep({ context: req.context }));
}));

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
/*
 * What is still returnable on this order, and what the shop still owes on it.
 * Both read-only, both behind `purchases.view`: seeing the state of an order is
 * not the same right as sending goods back under it.
 */
router.get('/purchases/:id/returnable', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseReturnService.returnable(Number(req.params.id)));
}));

router.get('/purchases/:id/balance', requirePermission('purchases.view'), asyncHandler(async (req, res) => {
  res.json(await purchaseReturnService.balance(Number(req.params.id)));
}));

router.post('/purchases/:id/approve', requirePermission('purchases.approve'),
  asyncHandler(async (req, res) => res.json(await purchaseService.approve(Number(req.params.id), req.context))));
router.post('/purchases/:id/receive', requirePermission('purchases.receive'), validate(v.receiveSchema),
  asyncHandler(async (req, res) => res.json(await purchaseService.receive(Number(req.params.id), req.body, req.context))));
/**
 * Money out, as a row.
 *
 * `/payment` (singular) is the address the shop's browsers have been posting to
 * since before payments were rows at all; it is kept, pointing at the same
 * service call, so a tab left open across the deploy still works. `/payments`
 * is the one to use.
 *
 * `purchases.pay` rather than `purchases.update`: paying a supplier is not
 * editing the document, and migration 011 grants the new code to the roles that
 * could already commit the shop to the spend. See shared/permissions.js.
 */
router.get('/purchases/:id/payments', requirePermission('purchases.view'),
  asyncHandler(async (req, res) => res.json(await purchaseService.payments(Number(req.params.id)))));

const recordPayment = asyncHandler(async (req, res) => res.json(
  await purchaseService.registerPayment(Number(req.params.id), req.body, req.context),
));
router.post('/purchases/:id/payments', requirePermission('purchases.pay'),
  validate(v.paymentSchema), recordPayment);
router.post('/purchases/:id/payment', requirePermission('purchases.pay'),
  validate(v.paymentSchema), recordPayment);

router.post('/purchases/:id/payments/:paymentId/reverse',
  requirePermission('purchases.reverse_payment'), validate(v.paymentReversalSchema),
  asyncHandler(async (req, res) => res.json(await purchaseService.reversePayment(
    Number(req.params.id), Number(req.params.paymentId), req.body.reason, req.context,
  ))));
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
// session, because delivering one issues stock and raises a paid invoice.
router.get('/web-orders', requirePermission('weborders.view'), asyncHandler(async (req, res) => {
  res.json(await webOrderService.list({
    search: req.query.search, status: req.query.status, page: req.query.page,
  }));
}));

// Registered before `/:id`, which would otherwise swallow the word "count".
router.get('/web-orders/count', requirePermission('weborders.view'), asyncHandler(async (_req, res) => {
  res.json({ pending: await webOrderService.pendingCount() });
}));

router.get('/web-orders/:id', requirePermission('weborders.view'), asyncHandler(async (req, res) => {
  res.json(await webOrderService.get(Number(req.params.id)));
}));

// One route per step of the lifecycle. `weborders.confirm` covers the three
// that carry an order forward — they are one job, and whoever may start it must
// be able to finish it — while the two that end an order early and put the
// held stock back sit behind `weborders.cancel`.
router.post('/web-orders/:id/accept', requirePermission('weborders.confirm'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.accept(Number(req.params.id), req.context));
  }));

router.post('/web-orders/:id/dispatch', requirePermission('weborders.confirm'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.dispatch(Number(req.params.id), req.context));
  }));

// The only step that sells anything: it issues the stock and raises the paid
// invoice, because this is where the box and the cash change hands.
router.post('/web-orders/:id/deliver', requirePermission('weborders.confirm'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.deliver(Number(req.params.id), req.context));
  }));

router.post('/web-orders/:id/not-received', requirePermission('weborders.cancel'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.markNotReceived(
      Number(req.params.id), req.body?.reason, req.context,
    ));
  }));

router.post('/web-orders/:id/cancel', requirePermission('weborders.cancel'),
  asyncHandler(async (req, res) => {
    res.json(await webOrderService.cancel(Number(req.params.id), req.body?.reason, req.context));
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

// ------------------------------------------------------------------- costs
/**
 * صفحة التكاليف — what the shop spends that is not stock.
 *
 * `/costs/recurring…` is registered BEFORE `/costs/:id`, which is the same two
 * segments and would otherwise swallow it and go looking for a cost with the id
 * "recurring". Cost categories live at their own path for the same reason.
 *
 * Every POST here is covered by the idempotency guard mounted in front of this
 * router (see server.js), so a double-tapped "save" on a cost cannot produce
 * two of it — the same protection purchase orders got, inherited rather than
 * re-implemented.
 */
router.use('/cost-categories', crudRouter({
  service: costCategoryService, module: 'costs', schema: v.costCategorySchema,
}));

router.get('/costs', requirePermission('costs.view'), asyncHandler(async (req, res) => {
  res.json(await costService.list(req.query));
}));
router.get('/costs/summary', requirePermission('costs.view'), asyncHandler(async (req, res) => {
  res.json(await costService.summary(req.query));
}));

/**
 * What the repeating costs owe, and posting it.
 *
 * `GET /due` writes nothing: it is the list the shop is shown so a person can
 * confirm it. `POST /generate` is that confirmation for everything waiting;
 * `POST /:id/post` is one month, with the amount corrected if the bill was not
 * what the template guessed. Nothing else in the system posts a recurring cost.
 */
router.get('/costs/recurring', requirePermission('costs.view'), asyncHandler(async (req, res) => {
  res.json(await costService.listRecurring(req.query));
}));
router.get('/costs/recurring/due', requirePermission('costs.view'), asyncHandler(async (req, res) => {
  res.json(await costService.due({ asOf: req.query.asOf || null }));
}));
router.post('/costs/recurring/generate', requirePermission('costs.create'),
  asyncHandler(async (req, res) => res.json(
    await costService.generate({ asOf: req.body?.asOf || null }, req.context),
  )));
router.post('/costs/recurring', requirePermission('costs.create'), validate(v.recurringCostSchema),
  asyncHandler(async (req, res) => res.status(201).json(
    await costService.saveRecurring(req.body, req.context),
  )));
router.put('/costs/recurring/:id', requirePermission('costs.update'), validate(v.recurringCostSchema),
  asyncHandler(async (req, res) => res.json(
    await costService.saveRecurring(req.body, req.context, Number(req.params.id)),
  )));
router.post('/costs/recurring/:id/post', requirePermission('costs.create'),
  validate(v.recurringPostSchema), asyncHandler(async (req, res) => res.status(201).json(
    await costService.postOccurrence(Number(req.params.id), req.body.period_key, {
      amount: req.body.amount ?? null, spentOn: req.body.spent_on || null,
    }, req.context),
  )));
router.post('/costs/recurring/:id/stop', requirePermission('costs.update'),
  asyncHandler(async (req, res) => res.json(
    await costService.setRecurringActive(Number(req.params.id), false, req.context),
  )));
router.post('/costs/recurring/:id/resume', requirePermission('costs.update'),
  asyncHandler(async (req, res) => res.json(
    await costService.setRecurringActive(Number(req.params.id), true, req.context),
  )));
router.delete('/costs/recurring/:id', requirePermission('costs.delete'),
  asyncHandler(async (req, res) => res.json(
    await costService.removeRecurring(Number(req.params.id), req.context),
  )));

router.get('/costs/:id', requirePermission('costs.view'), asyncHandler(async (req, res) => {
  res.json(await costService.get(Number(req.params.id)));
}));
router.post('/costs', requirePermission('costs.create'), validate(v.costSchema),
  asyncHandler(async (req, res) => res.status(201).json(await costService.create(req.body, req.context))));
router.put('/costs/:id', requirePermission('costs.update'), validate(v.costSchema.partial()),
  asyncHandler(async (req, res) => res.json(
    await costService.update(Number(req.params.id), req.body, req.context),
  )));
router.delete('/costs/:id', requirePermission('costs.delete'), asyncHandler(async (req, res) => {
  res.json(await costService.remove(Number(req.params.id), req.context));
}));

// --------------------------------------------------------------- employees
/**
 * The people the shop pays — a separate list from the ERP's login users, and
 * deliberately so: a delivery man has a salary and no login.
 *
 * `POST /:id/payments` records what was actually handed over. It writes a COST
 * row — there is no salary payments table — so the money lands in the same
 * ledger the rent does and comes off the same profit, exactly once. Correcting
 * or removing one is therefore done through `/api/costs/:id`, which is the same
 * row: there is no second copy that could be edited in one screen and not the
 * other.
 */
router.get('/employees/payroll', requirePermission('employees.view'),
  asyncHandler(async (req, res) => res.json(await payrollService.roster(req.query))));
router.use('/employees', crudRouter({
  service: employeeService,
  module: 'employees',
  schema: v.employeeSchema,
  extend: (r, { perm }) => {
    r.get('/:id/payments', perm('view'), asyncHandler(async (req, res) => {
      res.json(await payrollService.payments(Number(req.params.id)));
    }));
    r.post('/:id/payments', requirePermission('employees.pay'), validate(v.salaryPaymentSchema),
      asyncHandler(async (req, res) => res.status(201).json(
        await payrollService.pay(Number(req.params.id), req.body, req.context),
      )));
  },
}));

// ------------------------------------------------------------- فواتيرك
/**
 * The invoices the shop already had ON PAPER, before it had this system.
 *
 * Its own module (`legacy_invoices`), not a corner of `purchases`, so a shop on
 * a small package is not silently given it and so that opening the archive is
 * not the same right as opening purchasing. Nothing under here touches stock,
 * costs, profit or a supplier balance — read the head of
 * `shared/legacyInvoices.js` before adding a route that does.
 *
 * There are no routes for the photographs: the generic
 * `/api/attachments/legacy_invoice/:id` endpoints already serve them, because
 * the service registered the owner type. That is the whole point of the
 * attachment contract.
 *
 * `/summary` is registered BEFORE `/:id`, the same two-segment collision the
 * costs routes above avoid — otherwise Express hands "summary" to the detail
 * route as an id.
 */
router.get('/legacy-invoices', requirePermission('legacy_invoices.view'),
  asyncHandler(async (req, res) => res.json(await legacyInvoiceService.list(req.query))));
router.get('/legacy-invoices/summary', requirePermission('legacy_invoices.view'),
  asyncHandler(async (req, res) => res.json(await legacyInvoiceService.summary(req.query))));
router.get('/legacy-invoices/:id', requirePermission('legacy_invoices.view'),
  asyncHandler(async (req, res) => res.json(await legacyInvoiceService.get(Number(req.params.id)))));
router.post('/legacy-invoices', requirePermission('legacy_invoices.create'),
  validate(v.legacyInvoiceSchema), asyncHandler(async (req, res) => res.status(201).json(
    await legacyInvoiceService.create(req.body, req.context),
  )));
router.put('/legacy-invoices/:id', requirePermission('legacy_invoices.update'),
  validate(v.legacyInvoiceSchema.partial()), asyncHandler(async (req, res) => res.json(
    await legacyInvoiceService.update(Number(req.params.id), req.body, req.context),
  )));
router.delete('/legacy-invoices/:id', requirePermission('legacy_invoices.delete'),
  asyncHandler(async (req, res) => res.json(
    await legacyInvoiceService.remove(Number(req.params.id), req.context),
  )));

/**
 * Money he paid against one of those invoices, over time, until it is settled.
 *
 * `legacy_invoices.pay` rather than `.update`: recording what was paid is not
 * editing the record, and undoing one is rarer still — the same split
 * `purchases` makes, and migration 015 grants the codes to the roles that
 * already held the rights they were carved out of.
 */
router.get('/legacy-invoices/:id/payments', requirePermission('legacy_invoices.view'),
  asyncHandler(async (req, res) => res.json(
    await legacyInvoiceService.payments(Number(req.params.id)),
  )));
router.post('/legacy-invoices/:id/payments', requirePermission('legacy_invoices.pay'),
  validate(v.legacyInvoicePaymentSchema), asyncHandler(async (req, res) => res.json(
    await legacyInvoiceService.registerPayment(Number(req.params.id), req.body, req.context),
  )));
router.post('/legacy-invoices/:id/payments/:paymentId/reverse',
  requirePermission('legacy_invoices.reverse_payment'), validate(v.paymentReversalSchema),
  asyncHandler(async (req, res) => res.json(await legacyInvoiceService.reversePayment(
    Number(req.params.id), Number(req.params.paymentId), req.body.reason, req.context,
  ))));

// ----------------------------------------------------------------- reports
router.get('/reports', requirePermission('reports.view'), asyncHandler((req, res) => {
  res.json({ rows: reportService.catalogue(req.permissions) });
}));
router.get('/reports/:key', requirePermission('reports.view'), asyncHandler(async (req, res) => {
  // A report may need a second permission — the costs and payroll ones do. It
  // is applied through `requirePermission` rather than a hand-rolled check so
  // the tenant's module entitlement is enforced exactly as it is everywhere
  // else: a shop whose plan has no costs module cannot read its wage bill out
  // of the report centre. Same helper the attachment routes use.
  const extra = reportService.permissionFor(req.params.key);
  if (extra) await runGuard(extra, req, res);
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
// Same idea as /labels/qr but for any symbology — defaults to labels.symbology
// when ?symbology= is omitted, and a payload that can't be encoded (letters
// in an EAN-13, say) reaches here as the ValidationError's 422, never a
// silently-wrong code.
router.get('/labels/code', requirePermission('labels.view'), asyncHandler(async (req, res) => {
  const { dataUri, aspect, symbology } = await labelService.codeImage(req.query.payload || '', {
    symbology: req.query.symbology, size: Number(req.query.size) || 180,
  });
  res.json({ dataUri, symbology, aspect });
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
/* ------------------------------------------------------- the shop's own data
 *
 * «بياناتك بتاعتك، وتقدر تاخد نسخة منها» — the promise the landing page makes,
 * kept here. Two routes, and they are not the same thing:
 *
 *   /settings/data-export   works on EVERY deployment, hosted or on a shop PC.
 *                           Reads this shop row by row and streams back one
 *                           .zip holding a restorable snapshot and two
 *                           bilingual workbooks — the same file the platform
 *                           console hands over, assembled by the same code.
 *   /settings/backups       the local database-file copy. Works only where
 *                           there IS a file (a shop PC), which is what it has
 *                           always been; nothing about it has been taken away.
 *
 * `settings.export_data` rather than `settings.backup`: see UNDELEGATABLE in
 * shared/permissions.js.
 *
 * And `requireLookup` rather than `requirePermission`, which is the one place in
 * this file where the module ENTITLEMENT is deliberately lifted. The RBAC check
 * is untouched — this is still the administrator and nobody else — but a shop
 * whose owner was sold a package without the `settings` module would otherwise
 * be a shop that cannot get its own books out of a system it pays for. That is
 * not a smaller ERP, it is a hostage situation, and the landing page this
 * platform is sold with says the opposite in both languages: «بياناتك بتاعتك».
 * Taking your own data out is not a feature that is sold; it is the promise
 * everything else is sold on top of.
 *
 * One honest limit on that: the ERP's sidebar hides the whole Settings entry
 * when the `settings` module is off (see `moduleEnabled` in
 * public/js/core/store.js), so on such a plan this door is open but the button
 * to it is not drawn. That is a nav-gating question rather than an entitlement
 * one, and it is left alone here — a shop that cannot open Settings at all
 * cannot set its own name either, which is a bigger conversation than this
 * route. What must never happen is the ANSWER being no, and it is not.
 */
router.get('/settings/data-export', requireLookup('settings.export_data'),
  asyncHandler(async (_req, res) => {
    res.json(await dataExportService.status());
  }));

/**
 * Build it and stream it.
 *
 * A POST rather than a link, deliberately: every refusal — no permission, too
 * soon, one already running — arrives as JSON with a code BEFORE a single byte
 * of archive is written, which is what lets the screen say it in Arabic. A
 * `<a download>` would have handed the browser a file called "error.zip".
 *
 * No `Content-Length`: the finished size is not known until the last byte, and
 * counting it first would mean holding a shop's whole book in memory. Back
 * pressure is respected, so a slow connection slows the build rather than
 * filling a buffer.
 */
router.post('/settings/data-export', requireLookup('settings.export_data'),
  asyncHandler(async (req, res) => {
    const { takenAt, filename, names } = await dataExportService.begin(req.context);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    try {
      await dataExportService.stream({
        takenAt,
        names,
        context: req.context,
        write: async (chunk) => {
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        },
      });
      res.end();
    } catch (error) {
      // Once the first chunk is on the wire there is no status code left to
      // change and no JSON body to send: an error now can only be told by
      // ABANDONING the response, so the browser sees a failed download rather
      // than a complete-looking archive that is half a shop. The reason is in
      // the shop's audit log either way (`EXPORT_FAILED`), which is the copy a
      // person can actually read afterwards.
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      throw error;
    }
  }));

// backupService.list() and .resolve() only touch the filesystem, so they stay sync.
router.get('/settings/backups', requirePermission('settings.backup'), asyncHandler((_req, res) => {
  // `fileBackups` is how the screen knows whether to draw this card at all: on
  // a hosted shop there is no file to copy, and a list that is always empty
  // with a button that always refuses is the screen that was photographed.
  res.json({
    rows: backupService.list(),
    fileBackups: supportsFileBackup(),
    driver: driverName(),
  });
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

// The storefront banner image. `web.*` text settings ride the ordinary
// `/settings` endpoints above; only the bytes need a dedicated route because
// they cannot go through JSON-in-a-settings-row like the rest of `web.*` can.
router.get('/settings/website/banner', requirePermission('settings.view'), asyncHandler(async (_req, res) => {
  res.json(await webAssetService.get('banner'));
}));
router.get('/settings/website/banner/raw', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const image = await webAssetService.bytes('banner');
  if (!image) throw new NotFoundError('Website banner image', 'banner');
  // Unlike a product photo, this URL has no id in it and stays the same after
  // an owner replaces the image — so, unlike the product raw route, this must
  // NOT be `immutable`. `no-cache` still lets the ETag skip re-sending the
  // bytes on every load; it just makes the browser ask first.
  sendImage(req, res, { ...image, created_at: image.updated_at }, { cacheControl: 'private, no-cache' });
}));
router.put('/settings/website/banner', requirePermission('settings.update'), validate(v.websiteBannerSchema),
  asyncHandler(async (req, res) => {
    res.json(await webAssetService.set(req.body.dataUrl, req.context, 'banner'));
  }));
router.delete('/settings/website/banner', requirePermission('settings.update'), asyncHandler(async (req, res) => {
  res.json(await webAssetService.clear(req.context, 'banner'));
}));

// The shop's logo, in the `logo` slot of the same table, through the same
// service, with the same four endpoints. It is a second row, not a second
// mechanism — and there is deliberately no `favicon` slot: the browser tab is
// drawn from this one image, so an owner cannot end up with a site whose tab
// belongs to a logo they replaced a year ago.
router.get('/settings/website/logo', requirePermission('settings.view'), asyncHandler(async (_req, res) => {
  res.json(await webAssetService.get('logo'));
}));
router.get('/settings/website/logo/raw', requirePermission('settings.view'), asyncHandler(async (req, res) => {
  const image = await webAssetService.bytes('logo');
  if (!image) throw new NotFoundError('Website logo image', 'logo');
  // Same reasoning as the banner's raw route: one URL that outlives the bytes
  // behind it, so `no-cache` with an ETag rather than anything `immutable`.
  sendImage(req, res, { ...image, created_at: image.updated_at }, { cacheControl: 'private, no-cache' });
}));
router.put('/settings/website/logo', requirePermission('settings.update'), validate(v.websiteLogoSchema),
  asyncHandler(async (req, res) => {
    res.json(await webAssetService.set(req.body.dataUrl, req.context, 'logo'));
  }));
router.delete('/settings/website/logo', requirePermission('settings.update'), asyncHandler(async (req, res) => {
  res.json(await webAssetService.clear(req.context, 'logo'));
}));

export default router;
