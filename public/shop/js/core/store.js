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
 * What the customer pays for delivery on a basket of this size.
 * The threshold is measured against the goods total, matching what
 * `WebOrderService.#totals` does on the server — the two must agree or the
 * basket promises a discount the order does not give.
 */
export function deliveryFor(goodsTotal) {
  const threshold = freeDeliveryOver();
  if (threshold !== null && Number(goodsTotal) >= threshold) return 0;
  return deliveryFee();
}
