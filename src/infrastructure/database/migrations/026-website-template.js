/**
 * Which of the two storefronts a shop wears.
 *
 * ── The setting ─────────────────────────────────────────────────────────────
 * `web.template` — 'classic' or 'luxe'. See `TEMPLATES` in shared/branding.js
 * for what each one is; in one line, classic is white cards on grey paper and
 * luxe is the near-black boutique design.
 *
 * ── Why the value is derived rather than defaulted ──────────────────────────
 * The default for a NEW shop is 'classic', and that is deliberate: a platform
 * does not redesign its customers' shops because its owner liked a mock-up.
 *
 * But this migration is not running on new shops. It is running on shops that
 * already exist, and for one release the night storefront was driven by
 * `web.theme_dark` — so a shop with that switch on is, right now, looking at
 * the luxe design on its live site. Writing 'classic' into every row would
 * take that away from them overnight, on an update they installed for
 * something else entirely, with no warning and nothing to click.
 *
 * So the value is READ FROM WHAT THE SHOP IS ALREADY WEARING. A shop with
 * `theme_dark` on keeps the design it has and now owns it as a real setting; a
 * shop with it off gets classic, which is also what it has. Nobody's site
 * changes on the day this runs, which is the only acceptable behaviour for a
 * migration that touches appearance.
 *
 * After this, the two settings are independent again — `theme_dark` goes back
 * to meaning only what colour the BANDS are, which is what it meant before and
 * what the classic design was built around.
 *
 * ── Idempotent, and it never overwrites ─────────────────────────────────────
 * `ON CONFLICT DO NOTHING`: a shop that has already chosen a template — because
 * this ran, or because somebody set it in the console — keeps its choice. A
 * migration that re-derived the value on every run would silently undo a shop
 * owner's decision the next time anything else shipped.
 */
export default {
  name: '026-website-template',

  async up({ getDb, hasTable }) {
    if (!(await hasTable('settings'))) return;
    const db = getDb();

    /*
     * What the shop is wearing today. The absence of the row is not "off": the
     * default for `theme_dark` has always been TRUE (see `booleanOr` in
     * shared/branding.js), so a shop that never opened the colour screen is
     * currently on the dark bands and, this release, on the luxe storefront.
     * Reading it as 'classic' here would be the exact silent downgrade this
     * migration exists to prevent.
     */
    const row = await db
      .prepare("SELECT value FROM settings WHERE key = 'web.theme_dark'")
      .get();
    const dark = row === undefined || row === null
      ? true
      : !['0', 'false', '', 'no'].includes(String(row.value ?? '').trim().toLowerCase());

    /*
     * The columns are `value_type` and `group_name` — not `type` and
     * `category`, which is what the seed's own four-tuples read like and what
     * this said on its first draft. SQLite answers that with "table settings
     * has no column named type" at BOOT, so the whole server refuses to start
     * rather than the migration failing quietly. Loud is the right direction,
     * and it is why this is worth a comment: the next person writing a
     * settings migration will read the seed and reach for the same two names.
     */
    await db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name)
      VALUES ('web.template', ?, 'string', 'website')
      ON CONFLICT(key) DO NOTHING
    `).run(dark ? 'luxe' : 'classic');
  },
};
