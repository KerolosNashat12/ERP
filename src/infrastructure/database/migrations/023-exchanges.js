/**
 * Round 15: the exchange, and the right to make one.
 *
 * ── What the database actually needed, and what it did not ──────────────────
 * The owner's list for this round was long — bulk edits, exchanges, partial
 * returns, full-invoice returns, validation, inventory integrity — and most of
 * it needed NO schema change at all, which is worth writing down because the
 * instinct is always to add a column:
 *
 *   · Partial returns already work, line by line, and have since the returns
 *     screen was built: `sale_lines.returned_quantity` carries how much of each
 *     line has come back and `ReturnService` refuses to exceed it.
 *   · "Mark the invoice as fully returned" needs no `status` value and no
 *     column. It is a FACT ABOUT THE LINES — every line fully returned — and
 *     deriving it is the only way it cannot drift out of step with them. A
 *     stored flag would have to be maintained by the return path, the reversal
 *     path, the recycle bin and any future importer, and the first one to
 *     forget makes the invoice lie.
 *   · Bulk editing is the same UPDATE the product form already does, many
 *     times, in one transaction.
 *
 * What genuinely needed storing is the LINK. An exchange is a return plus a
 * sale, and nothing in the schema could say those two documents and the
 * original invoice were one act.
 *
 * ── The number ──────────────────────────────────────────────────────────────
 * `EXC-2026-00001`, from the same sequence machinery as invoices and returns,
 * so an exchange is a document a person can quote over the phone.
 *
 * ── The right ───────────────────────────────────────────────────────────────
 * `sales.exchange`, granted to whoever already holds `sales.return`. An
 * exchange takes goods back and hands other goods out; a person trusted to do
 * the first half is trusted with the second, and a shop that narrowed the
 * returns right meant to narrow this one too. The administrator gets it
 * outright, as always.
 */
export default {
  name: '023-exchanges',

  async up({ getDb }) {
    const db = getDb();

    // The table itself is in schema.js and is created by CREATE TABLE IF NOT
    // EXISTS on every start, including this one — nothing to do here for it.
    await db.prepare(`
      INSERT INTO sequences (name, prefix, next_value, padding, reset_yearly, year)
      VALUES ('exchange', 'EXC', 1, 5, 1, ?) ON CONFLICT(name) DO NOTHING
    `).run(new Date().getFullYear());

    await db.prepare(`
      INSERT INTO permissions (code, module, action, description)
      VALUES ('sales.exchange', 'sales', 'exchange', 'exchange in sales')
      ON CONFLICT(code) DO NOTHING
    `).run();

    // The administrator, always.
    await db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code = 'admin' AND p.code = 'sales.exchange'
    `).run();

    // And everybody who may already take a return — but only them, so a role
    // the shop's owner narrowed stays narrow.
    await db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT rp.role_id, p.id
        FROM role_permissions rp
        JOIN permissions source ON source.id = rp.permission_id AND source.code = 'sales.return'
        JOIN permissions p ON p.code = 'sales.exchange'
    `).run();
  },
};
