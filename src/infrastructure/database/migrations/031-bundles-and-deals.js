/**
 * Bundles, and Deals of the Day.
 *
 * ── The ask, verbatim ────────────────────────────────────────────────────────
 * "Can you please add a new section at the website and same at the dashboard
 * called deals of the day... let me choose the specific products to add on
 * it from my dashboard. And can I add bundles too — more than one product,
 * with a selling price I type or one calculated from each product's price.
 * Bundle should appear at the dashboard with new SKU and at website — maybe
 * at dashboard we should add it on Category Bundles, to appear on website
 * filtering with this category, and can choose it to appear in the new
 * section deals of the day."
 *
 * ── Deals of the day ─────────────────────────────────────────────────────────
 * A pure curation flag (`products.is_deal_of_day`), deliberately separate
 * from the price-offer columns migration 022 already added: a piece can be
 * discounted without being featured on the shelf, and featured on the shelf
 * without being discounted at all. `web.deals_enabled` (seeded in seed.js,
 * alongside every other website toggle) switches the whole section on or off
 * on the storefront without touching which products are on it.
 *
 * ── Bundles, and the decision that shapes every service touched by this ────
 * A bundle sells several products as one line, under a new SKU of its own.
 * The owner was asked directly whether a bundle should carry its own
 * independent stock count, or auto-deduct from each component's stock when
 * one sells — the simpler of the two, and the one this project would
 * normally recommend, is independent stock. He chose the harder one:
 * component stock, deducted automatically. That is why this migration adds
 * `bundle_items` — the recipe — rather than a stock-bearing bundle row: a
 * bundle never gets its own `stock_levels` entry that means anything. Its
 * availability, everywhere from the till to the storefront card, is derived
 * from its components at read time (`InventoryService#availableQuantity`),
 * and selling one posts a real ledger movement against EACH component
 * (`InventoryService#expandLine`, wired into `SalesService`, `ReturnService`
 * and `WebOrderService`) — never against the bundle's own variant, which
 * never appears in `stock_movements` at all.
 *
 * `bundle_price_mode` records where the bundle's price came from: typed by
 * hand ('fixed'), or the sum of what is inside it, recalculated by
 * `CatalogService#save` every time the recipe is saved ('sum'). Both are
 * "the selling price" on the bundle's own generated variant — nothing else
 * in the system needs to know which one produced it.
 *
 * Bundles get their own category (`code = 'BUNDLES'`, seeded in seed.js
 * exactly like the one default warehouse), assigned automatically by
 * CatalogService whenever `is_bundle` is on — so "filter the website by
 * Bundles" is the storefront's ordinary, pre-existing category filter, not a
 * new code path.
 */
export default {
  name: '031-bundles-and-deals',

  async up({ hasColumn, addColumn, ddl }) {
    if (!(await hasColumn('products', 'is_bundle'))) {
      await addColumn('products', 'is_bundle', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (!(await hasColumn('products', 'bundle_price_mode'))) {
      await addColumn('products', 'bundle_price_mode', "TEXT NOT NULL DEFAULT 'fixed'");
    }
    if (!(await hasColumn('products', 'is_deal_of_day'))) {
      await addColumn('products', 'is_deal_of_day', 'INTEGER NOT NULL DEFAULT 0');
    }

    // Safe on a brand-new database too (schema.js already created this table
    // with the same DDL) — CREATE ... IF NOT EXISTS makes both orders correct.
    await ddl(`
      CREATE TABLE IF NOT EXISTS bundle_items (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        bundle_variant_id    INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
        component_variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
        quantity             REAL    NOT NULL DEFAULT 1 CHECK (quantity > 0),
        display_order        INTEGER NOT NULL DEFAULT 0,
        UNIQUE (bundle_variant_id, component_variant_id)
      )
    `);
    await ddl('CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle    ON bundle_items(bundle_variant_id)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_bundle_items_component ON bundle_items(component_variant_id)');

    // These two are read on the storefront's Deals of the Day query and on
    // "which of my products are bundles" respectively — both are WHERE
    // clauses over the whole products table, so both earn an index the same
    // way gender and discount_type did in migration 022.
    await ddl('CREATE INDEX IF NOT EXISTS idx_products_is_bundle ON products(is_bundle)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_products_deal_of_day ON products(is_deal_of_day)');
  },
};
