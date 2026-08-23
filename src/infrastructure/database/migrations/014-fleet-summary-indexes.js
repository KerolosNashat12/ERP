/**
 * Round 8: make a shop cheap to summarise.
 *
 * The owner's console no longer computes the fleet overview by opening every
 * shop — each shop's figures are written into one control-plane table and read
 * from there (see `platform/FleetSummaryService.js`). What that moves rather
 * than removes is the per-shop read itself: something still has to produce
 * those figures, hourly, for every shop on the platform.
 *
 * Every one of those reads is bounded by the same predicate:
 *
 *     WHERE status = 'completed' AND date(sale_date) BETWEEN … AND …
 *
 * and the thirty-day trend groups by `date(sale_date)` on top of it. The
 * existing indexes cannot serve either: `idx_sales_status` is a single column
 * on a value that is 'completed' for very nearly every row, and `idx_sales_date`
 * indexes `sale_date`, which `date()` wraps — so SQLite has no range to seek and
 * reads the whole table, once per shop, once per sweep.
 *
 * The index below is on the expression the queries actually use, restricted to
 * the rows they actually want. `date(X)` is deterministic, which is what makes
 * an expression index legal; the partial `WHERE` is what makes it small — a
 * shop's voids are a rounding error and are never in it.
 *
 * Why a migration and not just `schema.js`: it is in `schema.js` too, and on a
 * database being created today that is where it comes from. This exists for the
 * shops that already have a year of sales in them, which is precisely the set
 * for which it matters, and for the ordinary reason every structural change
 * here is paired — `schema.js` is the current shape, migrations carry existing
 * databases to it.
 *
 * `IF NOT EXISTS` throughout, and guarded by `hasTable`, so re-running it on a
 * restored database is a no-op rather than an error.
 */
export default {
  name: '014-fleet-summary-indexes',

  async up({ hasTable, ddl, analyze }) {
    if (await hasTable('sales')) {
      await ddl(`CREATE INDEX IF NOT EXISTS idx_sales_completed_day
                   ON sales(date(sale_date), total_amount)
                 WHERE status = 'completed'`);

      /**
       * The index is useless without this, and that is not obvious.
       *
       * With no `sqlite_stat1` the planner has no way to know that
       * `status = 'completed'` matches essentially every row, so it keeps
       * choosing `idx_sales_status` and reads the whole table anyway —
       * measured on a 20,000-sale shop, the same query is 6.0ms before
       * `ANALYZE` and 0.10ms after it, with the plan changing from
       * "SEARCH … USING INDEX idx_sales_status" to
       * "SEARCH … USING INDEX idx_sales_completed_day (<expr>>? AND <expr><?)".
       * Shipping the index without the statistics would have been a migration
       * that changed nothing and a benchmark that proved it.
       *
       * One pass over this shop's indexes, once, on a database that is being
       * migrated anyway. `platform/FleetSummaryService.js` keeps the statistics
       * from drifting afterwards with a `PRAGMA optimize` on the hourly sweep,
       * which is what covers a shop that was empty when this ran.
       *
       * Through `analyze()` and never `ddl('ANALYZE')`: Turso refuses the
       * statement, and sending it inside a migration's transaction took the
       * whole platform down once already. See the helper for the full story.
       */
      await analyze();
    }
    /**
     * `MAX(created_at) FROM web_orders` is one of the four reads behind "when
     * did anything last happen in this shop". `idx_web_orders_status` leads on
     * `status`, so it cannot answer a MAX over the whole table; this can, and
     * costs one seek. The table is created by migrations 002/004 rather than by
     * `schema.js`, which is why this one has to live here and cannot be an
     * `IF NOT EXISTS` line in the schema — same reasoning as migration 009.
     */
    if (await hasTable('web_orders')) {
      await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_created ON web_orders(created_at DESC)');
    }
  },
};
