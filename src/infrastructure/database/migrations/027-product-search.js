/**
 * The search index table, and its first fill.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 * Search was `LIKE '%term%'` over six columns, which is exactly right for a
 * scanned barcode and useless for a person: «أحمر» did not find «احمر»,
 * `tobacco` did not find «توباكو», and «عطر» typed with the keyboard still on
 * English produced `u'v` and no results at all. Those reductions cannot be
 * expressed in SQLite — it has no Unicode-aware `lower()`, nothing that strips
 * tashkeel and nothing that folds a hamza — so the reduced text is computed in
 * JavaScript on save and stored here. See `src/services/searchIndex.js`.
 *
 * ── Why a table and not a column on `products` ──────────────────────────────
 * Three reasons, in order. `products` is read on every till screen and every
 * storefront page, and two long text columns would cost all of those reads.
 * The index can be rebuilt with one DELETE and one INSERT without touching a
 * product row, which matters because it IS derived data and will occasionally
 * need repairing. And `schema.js` is applied BEFORE the migrations, so a new
 * column on `products` could not be named by `v_variant_details` without
 * taking the whole boot down — the trap this project has hit before.
 *
 * ── Filling it here, rather than lazily ─────────────────────────────────────
 * A shop that installs this update has a catalogue already. An index that
 * filled itself as products were re-saved would leave search WORSE than before
 * for months — the new tiers finding nothing while the old ones had been
 * removed. So the table is populated for every existing product as part of the
 * same transaction that creates it, and a shop's first search after updating
 * works on its whole catalogue.
 *
 * ── ON DELETE CASCADE ───────────────────────────────────────────────────────
 * A deleted product must not stay findable. The service deletes the row too,
 * but the constraint is what makes it true even when a product is removed by a
 * path nobody remembered to teach.
 */
export default {
  name: '027-product-search',

  async up({ getDb, hasTable }) {
    if (!(await hasTable('products'))) return;
    const db = getDb();

    /*
     * `prepare().run()` and never `exec()`: a migration runs inside the open
     * transaction, and the connection facade refuses `exec()` there because it
     * bypasses that transaction and deadlocks on a second write lock.
     */
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS product_search (
        product_id INTEGER PRIMARY KEY
                   REFERENCES products(id) ON DELETE CASCADE,
        -- Every token a product can be found by, reduced to its search key and
        -- separated by single spaces, with a leading and trailing space so
        -- "does a WORD start with this" is a plain LIKE '% term%'.
        search_key TEXT NOT NULL DEFAULT '',
        -- The same names as consonant skeletons, which is how the English
        -- spelling of a name finds the Arabic one. Names only: a code is not a
        -- word in any script. (No backticks in here: this whole statement is a
        -- JS template literal and one would end it mid-comment.)
        bones      TEXT NOT NULL DEFAULT ''
      )
    `).run();

    /*
     * The index earns its place only for the anchored half of the work — a
     * prefix search (`LIKE 'lx08%'`) can seek, and that is the common case
     * when somebody is typing. An unanchored `LIKE '%...%'` scans whatever
     * happens, and on a table of one short row per product that scan is
     * measured in single-digit milliseconds for catalogues far larger than any
     * shop on this platform.
     */
    await db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_product_search_key ON product_search(search_key)',
    ).run();

    // Fill it. Imported here rather than at the top of the file so a migration
    // list can be loaded without dragging a service and its dependencies in.
    const { reindexAll } = await import('../../../services/searchIndex.js');
    await reindexAll(db);
  },
};
