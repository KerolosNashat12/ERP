/**
 * Round 4: one search box behaviour everywhere.
 *
 * Every ERP list that is about products now searches by product name or code
 * through the same predicate (`database/productSearch.js`), and the document
 * lists reach their contents through their line tables. That last step is a
 * lookup *by variant*, which every line table needed indexed in that direction.
 *
 * Most of those indexes live in `schema.js`, which is re-applied on every start
 * and is all `CREATE … IF NOT EXISTS` — so they land on existing databases
 * without a migration. `web_order_lines` is the exception: the web storefront's
 * tables were introduced by migrations 002/004 and have never been described in
 * `schema.js`, so its index has to be created here or it would exist only on
 * databases young enough to have been built after this change.
 *
 * Idempotent twice over: guarded by `hasTable` (a shop that has never enabled
 * the website may not have the table at all) and `IF NOT EXISTS`.
 */
export default {
  name: '009-search-indexes',

  async up({ hasTable, ddl }) {
    if (!(await hasTable('web_order_lines'))) return;
    await ddl(`CREATE INDEX IF NOT EXISTS idx_web_order_lines_variant
                 ON web_order_lines(variant_id)`);
  },
};
