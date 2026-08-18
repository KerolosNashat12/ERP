/**
 * The one piece of shop-wide state: the config every page needs before it can
 * paint a price. Fetched once on boot and then read synchronously, so a product
 * card does not have to be async just to know what a pound is called.
 */
export const shop = {
  config: null,
  categories: [],
  brands: [],
};

export function setConfig(config) {
  shop.config = config;
}

export const isOpen = () => Boolean(shop.config?.shopEnabled);
export const deliveryFee = () => Number(shop.config?.deliveryFee || 0);
export const freeDeliveryOver = () => {
  const value = Number(shop.config?.freeDeliveryOver);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * `config.delivery` as `StorefrontService.config()` sends it (see
 * `src/services/StorefrontService.js`): mode/fee/percent already coerced to
 * numbers, min/max/freeOver `null` when unset. Re-coerced defensively here too
 * — a config fetched before this page reloaded, or a future server bug,
 * should still behave as "unset", never as `NaN`.
 */
export function deliverySettings() {
  const d = shop.config?.delivery || {};
  const optionalNumber = (value) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    mode: d.mode === 'percent' ? 'percent' : 'flat',
    fee: Number(d.fee) || 0,
    percent: Number(d.percent) || 0,
    min: optionalNumber(d.min),
    max: optionalNumber(d.max),
    freeOver: optionalNumber(d.freeOver),
  };
}

// Mirrors `src/shared/money.js#round2` — the storefront has no build step and
// cannot `import` from `src/`, so the one-line formula is retyped here.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * What the customer pays for delivery on a basket of this size.
 *
 * This is a line-for-line mirror of `src/shared/delivery.js#deliveryFor` — the
 * storefront is static files with no build step and cannot `import` from
 * `src/`, so the rule is retyped here by hand. If the two ever disagree the
 * basket promises a price the order does not charge, so any change to the
 * server rule must be copied here too. `WebOrderService` never trusts a
 * delivery figure the client sends; it re-runs the server copy on the priced
 * lines every time an order is placed, so this mirror only ever affects what
 * the customer is shown before that.
 */
export function deliveryFor(goodsTotal) {
  const goods = Number.isFinite(Number(goodsTotal)) ? Number(goodsTotal) : 0;
  const { mode, fee, percent, min, max, freeOver } = deliverySettings();

  if (freeOver !== null && goods >= freeOver) return 0;

  if (mode === 'percent') {
    let value = round2(goods * percent / 100);
    if (min !== null && value < min) value = min;
    if (max !== null && value > max) value = max;
    return Math.max(round2(value), 0);
  }

  return Math.max(round2(fee), 0);
}
