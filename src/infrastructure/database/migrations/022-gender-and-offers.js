/**
 * Round 14: who a piece is for, and what it costs this week.
 *
 * Five columns on `products`, and the reason each one is a COLUMN rather than a
 * tag, an attribute or a promotion:
 *
 * `gender` — perfume is shopped by gender before anything else. As a tag it
 * would be a string nobody spells the same way twice; as an attribute it would
 * be a variant-level answer to a product-level question. The website filters on
 * it, so it needs an index and a CHECK, and it gets both. Every existing row
 * becomes 'unisex' — the only default that cannot be WRONG, because it shows
 * the piece to everybody rather than hiding it from half the shop while nobody
 * has classified it yet.
 *
 * `discount_type` / `discount_value` / `discount_starts_on` / `discount_ends_on`
 * — an offer on the product itself. The shop already had `promotions`, and they
 * are a different thing: a promotion is a CODE a customer types, evaluated
 * against a whole basket. This is a price on a shelf. A shopper does not type
 * anything to get it, it shows as a struck-through price on the card, and while
 * it runs it is what the till charges too. Every existing row becomes 'none',
 * so not one price in the shop moves the day this ships.
 *
 * ── On CHECK constraints and existing tables ────────────────────────────────
 * SQLite cannot add a CHECK to a live table, so the constraints in `schema.js`
 * apply to databases created from it and the columns added here carry only
 * their defaults. The service layer validates every write against
 * `shared/pricing.js`, which is the thing that would have to be right anyway —
 * a CHECK is a second net, never the first one.
 *
 * ── The view, and why the columns are NOT in it ─────────────────────────────
 * `v_variant_details` does not gain them, and must not. `schema.js` is applied
 * BEFORE the migrations on every start, and a view can only name columns that
 * exist at the moment it is created — naming one that a migration two steps
 * later will add fails at CREATE VIEW and takes the whole boot down with it.
 * So the view stays baseline-only and the four call sites that price a line
 * (`ProductRepository.details`, `.lookup`, `.findByCode`, and
 * `WebOrderService.#orderableVariant`) join `products` for the offer columns
 * themselves. The indexes below are here for the same reason.
 */
export default {
  name: '022-gender-and-offers',

  async up({ hasColumn, addColumn, getDb }) {
    if (!await hasColumn('products', 'gender')) {
      await addColumn('products', 'gender', "TEXT NOT NULL DEFAULT 'unisex'");
    }
    if (!await hasColumn('products', 'discount_type')) {
      await addColumn('products', 'discount_type', "TEXT NOT NULL DEFAULT 'none'");
    }
    if (!await hasColumn('products', 'discount_value')) {
      await addColumn('products', 'discount_value', 'REAL NOT NULL DEFAULT 0');
    }
    if (!await hasColumn('products', 'discount_starts_on')) {
      await addColumn('products', 'discount_starts_on', 'TEXT');
    }
    if (!await hasColumn('products', 'discount_ends_on')) {
      await addColumn('products', 'discount_ends_on', 'TEXT');
    }

    /*
     * And one column on the sale line: what the piece cost BEFORE the offer.
     *
     * `unit_price` stays what it has always been — what was actually charged —
     * so every total, every report and every profit figure in this system is
     * untouched by this release. `list_price` sits beside it purely so a
     * receipt, a returns screen or a question six months from now can answer
     * "was this on offer, and by how much". Zero on every existing line, which
     * reads as "no offer" wherever it is checked.
     */
    if (!await hasColumn('sale_lines', 'list_price')) {
      await addColumn('sale_lines', 'list_price', 'REAL NOT NULL DEFAULT 0');
    }

    /*
     * `prepare().run()` and not `exec()`: a migration runs inside the open
     * transaction, and `exec` bypasses it — the connection facade refuses it
     * for exactly that reason.
     */
    const db = getDb();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_products_gender ON products(gender)').run();
    // Partial: the shop window asks "what is on sale" constantly and almost
    // nothing ever is, so this index is the size of the offers, not the catalogue.
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_products_on_offer ON products(discount_type)
        WHERE discount_type <> 'none'
    `).run();
  },
};
