/**
 * Money helpers. SQLite has no decimal type, so every monetary figure is
 * normalised to 2 decimals at the boundary of each calculation to avoid
 * floating-point drift accumulating across invoice lines.
 */

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

export const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Sum a list of numbers with 2-decimal normalisation. */
export const sum = (values) => round2(values.reduce((acc, v) => acc + toNumber(v), 0));

/** Percentage of an amount, e.g. percentOf(200, 14) === 28 */
export const percentOf = (amount, percent) => round2(toNumber(amount) * (toNumber(percent) / 100));

/**
 * Compute a single document line.
 * Discount is applied before tax, which matches Egyptian VAT practice.
 */
export function calculateLine({ quantity, unitPrice, discountPercent = 0, discountAmount = 0, taxRate = 0 }) {
  const qty = toNumber(quantity);
  const price = toNumber(unitPrice);
  const gross = round2(qty * price);
  const pctDiscount = percentOf(gross, discountPercent);
  const discount = round2(pctDiscount + toNumber(discountAmount));
  const net = round2(Math.max(gross - discount, 0));
  const tax = percentOf(net, taxRate);
  return {
    gross,
    discountAmount: discount,
    netAmount: net,
    taxAmount: tax,
    lineTotal: round2(net + tax),
  };
}

/**
 * Moving-average cost — the valuation method used for stock receipts.
 * Returns the new average unit cost after adding `inQty` at `inCost`.
 */
export function movingAverageCost(currentQty, currentAvg, inQty, inCost) {
  const q0 = toNumber(currentQty);
  const q1 = toNumber(inQty);
  const totalQty = q0 + q1;
  if (totalQty <= 0) return round3(toNumber(inCost));
  const value = q0 * toNumber(currentAvg) + q1 * toNumber(inCost);
  return round3(value / totalQty);
}
