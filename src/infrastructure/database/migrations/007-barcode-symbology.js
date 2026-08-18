/**
 * Round 3: 1D barcode labels — the shop's actual scanner (a Zebex Z-3151HS)
 * is a laser wedge that can only read Code 128 / EAN-13, never a QR code, so
 * `labels.symbology` now controls what `LabelService` renders and defaults to
 * 'code128'. `scanner.model` records which hardware preset the owner picked
 * in Settings → Devices so the UI can re-select it.
 *
 * Same shape as 006-banner-and-shipping.js and for the same reason — rows
 * inserted with `INSERT OR IGNORE` into the existing `settings` table, so a
 * fresh install and a database that has been running for years both end up
 * with every key present, and re-running this can never clobber a value a
 * shop owner already typed.
 *
 * See seed.js's `seedBaseline()` for the same defaults — the two must stay in
 * lockstep so a fresh install and a migrated one are identical.
 */

/** [key, value, value_type, group_name] */
const NEW_SETTINGS = [
  // --- labels: which symbology to print, and the two knobs that only mean
  // anything for a 1D code (a QR code has no "height" or "digits under it").
  ['labels.symbology', 'code128', 'string', 'labels'],
  ['labels.code_height_mm', '12', 'number', 'labels'],
  ['labels.show_code_text', '1', 'boolean', 'labels'],

  // --- scanner: free text, the device preset the owner picked in Settings ->
  // Devices; picking one there fills the other scanner.* fields but they stay
  // editable, so this itself is just a label, not a source of truth.
  ['scanner.model', '', 'string', 'scanner'],
];

export default {
  name: '007-barcode-symbology',

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
