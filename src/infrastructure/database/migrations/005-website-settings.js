/**
 * Website settings: the storefront banner, social links and contact details
 * an owner edits from the ERP without ever touching code.
 *
 * Two things land here. `web_assets` is a new table — one row per named image
 * slot, so a second slot (a logo, an about-page photo) is a new row rather
 * than a new table later. And the `web.*` settings themselves, seeded with
 * `INSERT OR IGNORE` into the existing `settings` table: a fresh install and a
 * database that has been running for a year both end up with every key
 * present, and re-running this (a restored backup, a repeated deploy) can
 * never clobber text a shop owner already typed.
 *
 * See src/infrastructure/database/schema.js for `web_assets` on a fresh
 * install, and seed.js's `seedBaseline()` for the same defaults — the two
 * must stay in lockstep so a fresh install and a migrated one are identical.
 */

/** [key, value, value_type] — group_name is always 'website', bound separately. */
const WEBSITE_SETTINGS = [
  // --- banner. Empty, not "Accessories that finish the look": these ship to
  // every shop on the platform, and a default that reads well is a default
  // that names one shop's product categories. `INSERT OR IGNORE` means a
  // database that already ran this migration keeps whatever it has — this
  // changes nothing for them, and stops the next shop inheriting it.
  ['web.banner_heading_en', '', 'string'],
  ['web.banner_heading_ar', '', 'string'],
  ['web.banner_text_en', '', 'string'],
  ['web.banner_text_ar', '', 'string'],
  ['web.banner_cta_label_en', '', 'string'],
  ['web.banner_cta_label_ar', '', 'string'],
  ['web.banner_cta_link', '', 'string'],
  ['web.banner_overlay', '35', 'number'],

  // --- social links, each with its own visibility toggle
  ['web.social_facebook', '', 'string'],
  ['web.social_facebook_enabled', '0', 'boolean'],
  ['web.social_instagram', '', 'string'],
  ['web.social_instagram_enabled', '0', 'boolean'],
  ['web.social_tiktok', '', 'string'],
  ['web.social_tiktok_enabled', '0', 'boolean'],
  ['web.social_youtube', '', 'string'],
  ['web.social_youtube_enabled', '0', 'boolean'],
  ['web.social_whatsapp', '', 'string'],
  ['web.social_whatsapp_enabled', '0', 'boolean'],
  ['web.social_x', '', 'string'],
  ['web.social_x_enabled', '0', 'boolean'],

  // --- contact
  ['web.contact_email', '', 'string'],
  ['web.contact_phone', '', 'string'],
  ['web.contact_address_en', '', 'string'],
  ['web.contact_address_ar', '', 'string'],
  ['web.contact_hours_en', '', 'string'],
  ['web.contact_hours_ar', '', 'string'],
  ['web.contact_map_url', '', 'string'],
];

export default {
  name: '005-website-settings',

  async up({ ddl, getDb }) {
    await ddl(`
      CREATE TABLE IF NOT EXISTS web_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot TEXT NOT NULL UNIQUE,          -- 'banner' today
        data BLOB NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        width INTEGER, height INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);

    // One statement per row, each its own prepare().run() — never exec() inside
    // a transaction, and OR IGNORE means an owner's existing text survives a
    // repeat run untouched.
    const insertSetting = getDb().prepare(`
      INSERT OR IGNORE INTO settings (key, value, value_type, group_name)
      VALUES (?, ?, ?, 'website')
    `);
    for (const [key, value, type] of WEBSITE_SETTINGS) {
      await insertSetting.run(key, value, type);
    }
  },
};
