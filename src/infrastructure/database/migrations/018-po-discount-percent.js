/**
 * Round 12: the discount on a purchase order is a RATE, not an amount.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * A supplier does not say "take forty pounds off". He says "take five percent",
 * and the shop's own owner said so plainly: الخصم at PO should be a ratio.
 * Typing an amount meant doing the supplier's arithmetic by hand for every
 * order, and doing it again by hand the moment a line changed — which is
 * exactly the kind of sum a computer should be doing, and exactly the kind a
 * person gets wrong at the end of a long day.
 *
 * ── What this column does and does not change ────────────────────────────────
 * `discount_amount` stays what it has always been: the money, in the header,
 * and the single thing every total, every report, every supplier statement and
 * every printed order already reads. Nothing downstream of this file changes,
 * and nothing has to.
 *
 * `discount_percent` is the INPUT. `PurchaseService` multiplies it by the
 * subtotal and writes the result into `discount_amount`, so the two can never
 * drift apart and the amount remains authoritative for anybody reading the row.
 *
 * ── Orders that already exist ────────────────────────────────────────────────
 * They keep their amount and get a percent of zero, which is exactly right:
 * nobody's history is rewritten and no total moves by a piastre. An old order
 * opened for editing shows the rate its amount works out to, so the field is
 * never blank on a discount that plainly exists — see `PurchaseService.save`.
 */
export default {
  name: '018-po-discount-percent',

  async up({ hasColumn, addColumn }) {
    if (await hasColumn('purchase_orders', 'discount_percent')) return;
    await addColumn('purchase_orders', 'discount_percent', 'REAL NOT NULL DEFAULT 0');
  },
};
