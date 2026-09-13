/**
 * Checkout, order tracking, and the Fawaterak webhook — the only public
 * endpoints that write.
 *
 * Kept apart from the read-only storefront router so the write surface stays
 * one small file that can be read end to end when reasoning about abuse.
 * Payment is cash on delivery by default; a shop that turns Fawaterak on in
 * Settings → الدفع الإلكتروني adds exactly one more public write below —
 * the webhook Fawaterak calls to say an invoice was paid, refused, or
 * expired. It carries no session and no cookie, so it is verified the one
 * way it can be: its HMAC signature, checked here before anything it says is
 * believed. See `FawaterakService#verifyWebhookSignature` for the mechanics
 * and `WebOrderService#confirmPayment` / `#failPayment` for what happens once
 * it is.
 */
import { Router } from 'express';
import { asyncHandler, validate } from '../middleware/index.js';
import * as v from '../validators.js';
import webOrders from '../../services/WebOrderService.js';
import fawaterakService from '../../services/FawaterakService.js';
import { currentTenant } from '../../infrastructure/database/connection.js';

const router = Router();

/**
 * Same gate as `shop.js`, kept here too rather than relied on solely from the
 * sibling router: both are mounted at the same `/api/shop` prefix in
 * `server.js`, but a route here must still 404 on its own if this file is
 * ever mounted independently of `shop.js`.
 */
router.use((req, res, next) => {
  const tenant = currentTenant();
  if (tenant && !tenant.websiteEnabled) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
  }
  return next();
});

/** Place an order. Reserves stock; does not sell anything. */
router.post('/orders', validate(v.webOrderSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await webOrders.place(req.body, req.context.request));
}));

/**
 * Track an order. The number alone is not enough — the phone number used to
 * place it must match, so a guessed order number reveals nothing.
 */
router.get('/orders/:orderNo', asyncHandler(async (req, res) => {
  res.json(await webOrders.track(req.params.orderNo, req.query.phone));
}));

/**
 * Fawaterak's webhook. The `_json` in the path is not decorative — it is
 * what tells Fawaterak's own dashboard to send this endpoint JSON rather than
 * a form-encoded body, per their integration docs.
 *
 * Two request shapes reach here, per Fawaterak's own reference: a paid
 * invoice carries `invoice_status: 'paid'`, `invoice_id`, `invoice_key` and a
 * `hashKey` HMAC'd over exactly those three; anything else — a cancelled,
 * expired or failed attempt — is acknowledged with 200 (so Fawaterak stops
 * retrying something that will never resolve) but not acted on, because none
 * of those carry the `invoice_key` this shop needs to find the order and this
 * file is not going to guess at a mapping it cannot verify. In practice this
 * is rarely the whole story for an abandoned payment: the customer's own
 * browser also lands back on the order page with `?payment=failed` or
 * `?payment=pending` (see `WebOrderService#place`'s `redirectionUrls`), and a
 * web order nobody ever pays for is exactly the kind of stale `pending` order
 * staff already have a cancel button for.
 *
 * Never a 401 for a bad signature: that tells a prober whether it was close.
 * Every outcome that is not a genuine 'paid' invoice answers the same 200
 * with nothing revealing in the body.
 */
router.post('/payments/fawaterak/webhook_json', asyncHandler(async (req, res) => {
  const body = req.body || {};

  if (body.invoice_status === 'paid' && body.invoice_key && body.invoice_id) {
    const verified = await fawaterakService.verifyWebhookSignature({
      invoiceId: body.invoice_id,
      invoiceKey: body.invoice_key,
      paymentMethod: body.payment_method,
      hashKey: body.hashKey,
    });
    if (verified) {
      await webOrders.confirmPayment({
        invoiceKey: body.invoice_key,
        invoiceId: body.invoice_id,
        referenceNumber: body.referenceNumber,
      });
    }
  }

  res.status(200).json({ received: true });
}));

export default router;
