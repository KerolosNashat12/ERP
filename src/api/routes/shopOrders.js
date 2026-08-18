/**
 * Checkout and order tracking — the only public endpoints that write.
 *
 * Kept apart from the read-only storefront router so the write surface stays
 * one small file that can be read end to end when reasoning about abuse.
 * Payment is cash on delivery: nothing here takes a card, and there is no
 * gateway to integrate.
 */
import { Router } from 'express';
import { asyncHandler, validate } from '../middleware/index.js';
import * as v from '../validators.js';
import webOrders from '../../services/WebOrderService.js';

const router = Router();

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

export default router;
