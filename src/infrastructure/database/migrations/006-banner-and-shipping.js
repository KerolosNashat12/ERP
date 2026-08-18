/**
 * Round 2: banner text placement and configurable shipping.
 *
 * Same shape as 005-website-settings.js and for the same reason — nine rows
 * inserted with `INSERT OR IGNORE` into the existing `settings` table, so a
 * fresh install and a database that has been running for a year both end up
 * with every key present, and re-running this can never clobber a value a
 * shop owner already typed.
 *
 * See seed.js's `seedBaseline()` for the same defaults — the two must stay in
 * lockstep so a fresh install and a migrated one are identical.
 */

/** [key, value, value_type, group_name] */
const NEW_SETTINGS = [
  // --- banner text placement (website): physical, not language-relative —
  // the owner picks what they see in the preview, both languages show the same.
  ['web.banner_align', 'right', 'string', 'website'],
  ['web.banner_valign', 'middle', 'string', 'website'],
  ['web.banner_text_size', 'medium', 'string', 'website'],
  ['web.banner_text_color', 'light', 'string', 'website'],
  ['web.banner_box_width', '45', 'number', 'website'],

  // --- shipping (shop): shop.delivery_fee and shop.free_delivery_over
  // already exist from 002-web-orders.js and keep their meaning.
  ['shop.delivery_mode', 'flat', 'string', 'shop'],
  ['shop.delivery_percent', '0', 'number', 'shop'],
  ['shop.delivery_min', '0', 'number', 'shop'],
  ['shop.delivery_max', '0', 'number', 'shop'],
];

export default {
  name: '006-banner-and-shipping',

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
