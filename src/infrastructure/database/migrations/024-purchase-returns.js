/**
 * Round 17: goods going back to the supplier, and a discount that says which
 * kind it is.
 *
 * ── Why a purchase return is its own document ───────────────────────────────
 * The obvious implementation is to edit the order: reduce the received
 * quantity, reduce the total, done. It is wrong for the same reason a sales
 * return does not edit the invoice. The order is a record of an agreement and
 * of what arrived under it; a shop reconciling a supplier's statement in
 * December has to find the September order reading the way it read in
 * September. Editing it also destroys the only evidence that the goods were
 * ever received, which is exactly the evidence a dispute turns on.
 *
 * So: `purchase_returns` and `purchase_return_lines`, both in schema.js and
 * created on every start. Nothing to create here.
 *
 * ── What the shop still owes ────────────────────────────────────────────────
 * Derived, never stored. Outstanding on an order is what it came to, less what
 * has gone back, less what has been paid. A stored balance would have to be
 * maintained by the payment path, the return path, the reversal path and
 * whatever gets written next year, and the first one to forget makes a supplier
 * statement disagree with the orders under it. The one consequence worth
 * naming: when a shop has already paid in full and then sends goods back, that
 * figure goes NEGATIVE, and negative is the correct answer - it is the supplier
 * who owes money now, and the screens say so in those words.
 *
 * ── The discount ────────────────────────────────────────────────────────────
 * `discount_type` on purchase_orders, defaulting to 'percent', which is what
 * every existing order is: percent is all the system could store, so an order
 * where the supplier knocked 500 off 12,000 was written down as 4.1666...% and
 * came back as 499.99 next time it was opened. Existing rows are untouched and
 * keep behaving exactly as they did.
 *
 * ── The right ───────────────────────────────────────────────────────────────
 * `purchases.return`, granted to whoever may already receive stock. Sending
 * goods back is the same trust as booking them in - both move stock and both
 * change what the shop owes - and a shop that narrowed the receiving right
 * meant to narrow this one too. The administrator gets it outright.
 */
export default {
  name: '024-purchase-returns',

  async up({ getDb, hasColumn, addColumn }) {
    const db = getDb();

    if (!(await hasColumn('purchase_orders', 'discount_type'))) {
      /*
       * No CHECK constraint on the added column, deliberately. Adding one to a
       * live table means rebuilding the table under a trading shop, and the
       * value is written by one validated code path. New databases get the
       * constraint from schema.js; existing ones get the column.
       */
      await addColumn('purchase_orders', 'discount_type', "TEXT NOT NULL DEFAULT 'percent'");
    }

    await db.prepare(`
      INSERT INTO sequences (name, prefix, next_value, padding, reset_yearly, year)
      VALUES ('purchase_return', 'PRT', 1, 5, 1, ?) ON CONFLICT(name) DO NOTHING
    `).run(new Date().getFullYear());

    await db.prepare(`
      INSERT INTO permissions (code, module, action, description)
      VALUES ('purchases.return', 'purchases', 'return', 'return to supplier in purchases')
      ON CONFLICT(code) DO NOTHING
    `).run();

    await db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code = 'admin' AND p.code = 'purchases.return'
    `).run();

    await db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT rp.role_id, p.id
        FROM role_permissions rp
        JOIN permissions source ON source.id = rp.permission_id AND source.code = 'purchases.receive'
        JOIN permissions p ON p.code = 'purchases.return'
    `).run();
  },
};
