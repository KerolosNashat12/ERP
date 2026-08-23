/**
 * Round 7: every shop's database learns its own name.
 *
 * Backups made this necessary. A restore overwrites a live shop, and the one
 * thing that must be impossible is doing it to the WRONG shop. Three checks
 * stand between an operator and that mistake, and two of them are made of
 * things that can change:
 *
 *   - the backup row is scoped to a tenant id in the control plane — but a
 *     tenant row can be re-pointed at a different database;
 *   - the console makes the operator type the slug — but a slug can be freed
 *     and reused for a different shop;
 *   - and this one: an id that belongs to the DATABASE, written once, never
 *     changed, carried inside every snapshot taken from it. It survives both of
 *     the above, which is what makes the refusal a property of the data rather
 *     than of the procedure.
 *
 * `settings` is where it goes rather than a new table: it is one string, it is
 * already the shop's own key/value store, and it is already in every snapshot.
 *
 * Written here as well as lazily in `platform/snapshot.js` because the two
 * cover different databases. The lazy path gives one to a shop the first time
 * it is backed up; this gives one to every shop the fleet migration sweeps,
 * including the ones that were adopted with their data already in them — so an
 * id exists BEFORE the first backup rather than being minted by it, and two
 * backups taken from the same shop on different days can never disagree.
 *
 * `ON CONFLICT DO NOTHING`, so a shop that already has one keeps it. Re-running
 * this migration on a restored database must never mint a second identity for a
 * database that already had one.
 */
import crypto from 'node:crypto';

export default {
  name: '013-shop-install-id',

  async up({ getDb }) {
    const db = getDb();
    const existing = await db.prepare("SELECT value FROM settings WHERE key = 'shop.install_id'").get();
    if (existing?.value) return;

    await db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name, updated_at)
      VALUES ('shop.install_id', ?, 'string', 'system', ?)
      ON CONFLICT(key) DO NOTHING
    `).run(crypto.randomUUID(), new Date().toISOString());
  },
};
