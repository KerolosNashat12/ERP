/**
 * Turn the figures band ON for a shop that has something to say with it.
 *
 * ── Why this exists one migration after the setting was created ────────────
 * 028 created `web.stats_enabled` and defaulted it to '0', on the reasoning
 * that a band announcing a product count reads as confidence at 250 and as an
 * apology at 11, and this platform sells to shops of both sizes.
 *
 * That reasoning is sound about the PLATFORM and was wrong about the person
 * who asked for the band. He sent a reference, said «واللاحصائيات اللي تحت» —
 * and the figures — and then published a release in which the feature he asked
 * for was invisible until he found a switch nobody had told him where to look
 * for. "Where are the statistics???" is the correct response to that, and the
 * fix is not to explain the switch better. A default that makes the person who
 * requested a feature go looking for it is the wrong default.
 *
 * ── Derived, not imposed ───────────────────────────────────────────────────
 * So the value is READ FROM THE SHOP rather than set to '1' for everybody,
 * which is the same shape as 026: a shop with a real catalogue gets the band,
 * a shop with a handful of products does not, and neither of them has to know
 * the setting exists to get the sensible answer. A shop that disagrees with
 * what it got changes it in Settings, and — because a migration that has run
 * never runs again — that choice is never revisited.
 *
 * ── The threshold, and why it is where it is ───────────────────────────────
 * `MIN_PRODUCTS` is the point at which the band stops being an apology. Below
 * about twenty, "12 PRODUCTS" beside "5 BRANDS" tells a shopper the shop is
 * nearly empty — the exact opposite of what a confidence band is for. Above
 * it, the figures round down to something like "40+" and read as a claim.
 *
 * Brands are checked too, because the middle cell is a brand count: a shop
 * with 200 products all from one supplier would print "1 BRANDS", which is
 * worse than printing nothing.
 */
const MIN_PRODUCTS = 20;
const MIN_BRANDS = 3;

export default {
  name: '029-stats-on-for-real-catalogues',

  async up({ getDb, hasTable }) {
    if (!(await hasTable('settings')) || !(await hasTable('products'))) return;
    const db = getDb();

    /*
     * Only ever '0' -> '1'. A shop that has already turned the band ON, or has
     * turned it off deliberately since 028 ran, is left exactly as it is: this
     * migration exists to fix a default nobody chose, not to overrule a choice
     * somebody made.
     */
    const current = await db
      .prepare("SELECT value FROM settings WHERE key = 'web.stats_enabled'")
      .get();
    if (!current) return;
    if (String(current.value ?? '').trim() !== '0') return;

    /*
     * The same definition of "on the shelves" the storefront itself uses:
     * active AND published. Counting a product a shopper cannot reach would be
     * the band telling them the shop is bigger than it is — which is the whole
     * thing the figures are careful not to do.
     */
    const products = await db.prepare(`
      SELECT COUNT(*) AS n FROM products
      WHERE is_active = 1 AND is_published = 1
    `).get();
    const brands = await db.prepare(`
      SELECT COUNT(*) AS n FROM brands b
      WHERE EXISTS (SELECT 1 FROM products p
                     WHERE p.brand_id = b.id AND p.is_active = 1 AND p.is_published = 1)
    `).get();

    if (Number(products?.n || 0) < MIN_PRODUCTS) return;
    if (Number(brands?.n || 0) < MIN_BRANDS) return;

    await db
      .prepare("UPDATE settings SET value = '1' WHERE key = 'web.stats_enabled'")
      .run();
  },
};
