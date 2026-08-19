/**
 * Round 4: a shop's own identity.
 *
 * The storefront used to carry one tenant's brand as string literals — the
 * letters M&M in the header, a search box that said "search bags, perfumes,
 * jewellery", a footer describing a small accessories shop, and one shop's
 * gold. The second shop on the platform sells clothes, opened its website and
 * found somebody else's. These ten rows are where that identity now lives.
 *
 * The text keys are seeded EMPTY on purpose. A default that reads well is a
 * default that names a category, and every shop that never edits it inherits
 * another shop's words; empty means `buildBranding()` falls back to something
 * true of any shop — the shop's own name, "Search products…" — and the ERP
 * form shows a blank field the owner can see is theirs to fill.
 *
 * The logo itself needs no migration: `web_assets` has held one row per named
 * slot since 005, so the logo is a row in a table that already exists.
 *
 * Same shape as 007-barcode-symbology.js and for the same reason — rows
 * inserted with `INSERT OR IGNORE`, so a fresh install and a database that has
 * been running for years both end up with every key present, and re-running
 * this can never clobber a value a shop owner already typed.
 *
 * See seed.js's `seedBaseline()` for the same defaults — the two must stay in
 * lockstep so a fresh install and a migrated one are identical.
 */

/** [key, value, value_type, group_name] */
const NEW_SETTINGS = [
  // --- words that describe a shop rather than a product category
  ['web.tagline_en', '', 'string', 'website'],
  ['web.tagline_ar', '', 'string', 'website'],
  ['web.about_en', '', 'string', 'website'],
  ['web.about_ar', '', 'string', 'website'],
  ['web.search_placeholder_en', '', 'string', 'website'],
  ['web.search_placeholder_ar', '', 'string', 'website'],
  ['web.meta_description_en', '', 'string', 'website'],
  ['web.meta_description_ar', '', 'string', 'website'],

  // --- colour. One accent and one mode; the rest of the palette is derived
  // from them in the browser, so there is nothing per-component to store.
  // The default is the gold the first shop already had, which is a starting
  // point rather than a claim about what any shop sells.
  ['web.theme_accent', '#c8a24a', 'string', 'website'],
  ['web.theme_dark', '1', 'boolean', 'website'],
];

export default {
  name: '008-shop-branding',

  async up({ getDb }) {
    // One statement per row, each its own prepare().run() — never exec() inside
    // a transaction, and OR IGNORE means an owner's existing value survives a
    // repeat run untouched.
    const insertSetting = getDb().prepare(`
      INSERT OR IGNORE INTO settings (key, value, value_type, group_name)
      VALUES (?, ?, ?, ?)
    `);
    for (const [key, value, type, group] of NEW_SETTINGS) {
      await insertSetting.run(key, value, type, group);
    }
  },
};
