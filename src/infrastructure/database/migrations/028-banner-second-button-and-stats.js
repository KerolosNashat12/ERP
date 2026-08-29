/**
 * The second banner button, and the figures band under it.
 *
 * ── Why rows at all, when a missing key already reads as "off" ─────────────
 * `StorefrontService` treats an absent `web.stats_enabled` as off, so the
 * feature is safe without this migration. What it is NOT without it is
 * VISIBLE: the ERP's website form builds its controls from the settings it was
 * handed, and a select with no stored value renders blank — a shop owner
 * looking at an empty dropdown cannot tell whether the band is off or whether
 * the screen is broken. Writing the default makes the form say "No".
 *
 * ── The default is off, deliberately ──────────────────────────────────────
 * The band announces how many products and brands a shop carries. That reads
 * as confidence at 250 products and as an apology at 11, and this platform
 * sells to shops of both sizes. A shop turns it on when it has something to
 * say; nobody's front page changes because an update landed.
 *
 * The two button fields default to empty, which is what the storefront already
 * treats as "no second button" — they exist here only so the form has
 * something to bind to and the owner sees three blank boxes rather than
 * wondering whether they saved.
 *
 * `ON CONFLICT DO NOTHING`, so a shop that has already chosen keeps its choice
 * when this runs again.
 */
export default {
  name: '028-banner-second-button-and-stats',

  async up({ getDb, hasTable }) {
    if (!(await hasTable('settings'))) return;
    const db = getDb();

    /*
     * The columns are `value_type` and `group_name` — not `type` and
     * `category`. SQLite answers the wrong names with "table settings has no
     * column named type" at BOOT, so the whole server refuses to start. It has
     * caught somebody once already; see 026.
     */
    const rows = [
      ['web.banner_cta2_label_en', '', 'string'],
      ['web.banner_cta2_label_ar', '', 'string'],
      ['web.banner_cta2_link', '', 'string'],
      ['web.stats_enabled', '0', 'string'],
    ];
    const insert = db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name)
      VALUES (?, ?, ?, 'website')
      ON CONFLICT(key) DO NOTHING
    `);
    for (const [key, value, kind] of rows) {
      // eslint-disable-next-line no-await-in-loop -- four statements, in order.
      await insert.run(key, value, kind);
    }
  },
};
