/**
 * The one shipping rule — pure and synchronous, so it can run identically
 * wherever a price needs to be shown or charged: the ERP settings preview,
 * `WebOrderService` (which is the only place a delivery fee is actually
 * charged) and `StorefrontService.config()` (which only echoes the terms).
 *
 * The storefront basket cannot import from `src/` at all — it is served as
 * static files with no build step — so `public/shop/js/core/store.js` carries
 * a line-for-line translation of this same function, each side commented with
 * the other's path. If the two ever disagree the basket promises a price the
 * order does not charge, which is why WebOrderService NEVER trusts a delivery
 * figure the client sends: this module is re-run, server side, on the priced
 * lines every time an order is placed.
 */
import { round2 } from './money.js';

export { round2 };

/** A bad or missing number behaves as 0 — never NaN, never negative. */
const safeNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** null/undefined/non-finite means "not set"; anything else is the number. */
const optionalNumber = (value) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {number} goodsTotal subtotal + tax — what the customer is buying,
 *   not what they will pay in total. Matches what the free-delivery threshold
 *   is measured against everywhere else in the system.
 * @param {{mode: string, fee: number, percent: number,
 *          min: number|null, max: number|null, freeOver: number|null}} settings
 * @returns {number} the delivery fee, rounded to 2 decimals, never negative.
 */
export function deliveryFor(goodsTotal, settings = {}) {
  const goods = safeNumber(goodsTotal);
  const { mode, fee, percent, min, max, freeOver } = settings;

  const freeOverValue = optionalNumber(freeOver);
  if (freeOverValue !== null && goods >= freeOverValue) return 0;

  if (mode === 'percent') {
    let value = round2(goods * safeNumber(percent) / 100);
    const minValue = optionalNumber(min);
    const maxValue = optionalNumber(max);
    if (minValue !== null && value < minValue) value = minValue;
    if (maxValue !== null && value > maxValue) value = maxValue;
    return Math.max(round2(value), 0);
  }

  return Math.max(round2(safeNumber(fee)), 0);
}

export default deliveryFor;
