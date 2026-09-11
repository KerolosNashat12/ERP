/**
 * The "Bundles" category, for a shop that already existed when 031 shipped.
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 * 031 added the columns and the `bundle_items` table a bundle needs, and its
 * own doc comment said the category itself was "seeded in seed.js exactly
 * like the one default warehouse" — true, but `seedBaseline()` only ever
 * runs once, when a shop's database is first created. It does not run again
 * on every boot the way migrations do. A shop created before 031 shipped —
 * every shop that already existed, which is every shop that matters — got
 * the new columns and the new table from 031, and never got the category
 * row, because nothing in 031 itself inserted one.
 *
 * The result: `CatalogService#bundlesCategoryId` throws "The Bundles
 * category has not been set up on this shop yet" the first time anyone on
 * an existing shop tries to save a bundle — not a missing feature, a missing
 * row, on every shop except a brand new one created after this fix ships.
 *
 * ── Why this is its own migration rather than an edit to 031 ───────────────
 * A migration that has already run never runs again (see the rules at the
 * top of index.js) — 031 already ran on every shop that hit this bug, so
 * editing it would reach nobody who needed it. New row, new file, same shape
 * as 029 fixing what 028 got wrong for shops that had already migrated past
 * it.
 *
 * ── Why this is safe to run on a shop that never had the bug ───────────────
 * `ON CONFLICT(code) DO NOTHING`, the same guard seed.js's own insert uses —
 * a shop provisioned after this fix ships already has the row from
 * `seedBaseline()`, and running this against it is a no-op.
 */
export default {
  name: '032-bundles-category-backfill',

  async up({ getDb, hasTable }) {
    if (!(await hasTable('categories'))) return;
    const db = getDb();
    await db.prepare(`
      INSERT INTO categories (code, name_en, name_ar, is_published, display_order)
      VALUES ('BUNDLES', 'Bundles', 'باقات', 1, 0)
      ON CONFLICT(code) DO NOTHING
    `).run();
  },
};
