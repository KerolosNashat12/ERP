/**
 * Round 10: make the shop's WHOLE HISTORY cheap to add up.
 *
 * Two reports now open on all of it by default — "Everything the shop has
 * spent" and "Profit after costs" — because the questions behind them have no
 * month in them: "انا صارف كام لحد دلوقتي علي المحل". Every other report in the
 * centre reads a few weeks; these two read every sale, every supplier payment
 * and every cost the shop has ever recorded, and they have to open without the
 * owner waiting for them.
 *
 * Measured on a seeded shop with three years in it — 20,000 sales, 60,000 sale
 * lines, 2,500 purchase orders, 3,167 supplier payments, 5,000 costs — the
 * lifetime profit report took 61ms before this and 24ms after. The four
 * indexes below are where the difference is, and each one is here because a
 * plan was read rather than because it seemed likely:
 *
 *   1. `idx_sales_completed_day` already existed (migration 014) but carried
 *      only the expression and, on databases created since, not even the
 *      amount. Both readers then went back to the table for every matched row.
 *      Widening it to carry `sale_date`, `total_amount` and `total_cost` makes
 *      it COVERING for both: the lifetime profit query drops 19ms → 5.1ms, and
 *      the fleet summary's own read — which is what 014 was for — drops
 *      13.6ms → 1.1ms as a side effect.
 *   2. `idx_sale_lines_no_cost` is new and is the reason the honesty check is
 *      affordable. "Which items were sold with no cost recorded against them?"
 *      had to walk 60,000 lines through the sale they belong to; a partial
 *      index on the handful of lines that qualify turns it into a seek:
 *      32ms → 3.6ms, and on a shop with no such lines it is empty.
 *   3. `idx_costs_spent_day` and 4. `idx_po_payments_day` index the two
 *      expressions every dated read of those tables actually uses. All-time is
 *      a scan either way and unchanged, but one month of the costs ledger goes
 *      0.83ms → 0.06ms and one month of supplier payments 0.59ms → 0.11ms — so
 *      this is as much for the costs SCREEN as for the reports.
 *
 * And `ANALYZE`, for the reason migration 014 spelled out at length: without
 * statistics the planner keeps choosing `idx_sales_status`, which matches
 * essentially every row, and ships an index that changes nothing.
 *
 * `IF NOT EXISTS` throughout and guarded by `hasTable`, so a restored database
 * that is already in this shape re-runs it as a no-op.
 */
export default {
  name: '016-lifetime-report-indexes',

  async up({ hasTable, ddl }) {
    if (await hasTable('sales')) {
      // Dropped rather than left alongside a wider twin: two indexes on the
      // same expression are two indexes to write on every sale, and the narrow
      // one answers nothing the wide one cannot. The name is kept so there is
      // still exactly one index here and `schema.js` agrees with it.
      await ddl('DROP INDEX IF EXISTS idx_sales_completed_day');
      await ddl(`CREATE INDEX IF NOT EXISTS idx_sales_completed_day
                   ON sales(date(sale_date), sale_date, total_amount, total_cost)
                 WHERE status = 'completed'`);
    }
    if (await hasTable('sale_lines')) {
      await ddl(`CREATE INDEX IF NOT EXISTS idx_sale_lines_no_cost
                   ON sale_lines(sale_id, quantity, line_total)
                 WHERE unit_cost <= 0`);
    }
    // Both tables arrived in migrations of their own (012 and 011), so their
    // index cannot be an `IF NOT EXISTS` line in `schema.js` alone — the same
    // reasoning as migrations 009 and 014. It is in the shared SQL string each
    // of them applies, which is what a database created today gets.
    if (await hasTable('costs')) {
      await ddl('CREATE INDEX IF NOT EXISTS idx_costs_spent_day ON costs(date(spent_on), amount)');
    }
    if (await hasTable('purchase_payments')) {
      await ddl(`CREATE INDEX IF NOT EXISTS idx_po_payments_day
                   ON purchase_payments(date(paid_on), purchase_order_id, amount)
                 WHERE status = 'recorded'`);
    }
    await ddl('ANALYZE');
  },
};
