/**
 * A replacement that is a DIFFERENT item.
 *
 * ── Why this is not part of 024 ─────────────────────────────────────────────
 * 024 shipped that morning and ran on the shop's database that afternoon. A
 * migration that has already run NEVER RUNS AGAIN - its name is in
 * `schema_migrations` and the loop skips it - so adding two columns to 024
 * would have been adding them to nobody. Every database created after the edit
 * would have the columns (from schema.js) and every database that already
 * existed would not, and the difference would show up as "table
 * purchase_return_lines has no column named replacement_variant_id" on the
 * shop's own machine, hours after the tests passed on a fresh one.
 *
 * A migration is a record of what happened, not a description of what should
 * be. Once it is out, the only way to change the shape is another one.
 *
 * ── What it adds ────────────────────────────────────────────────────────────
 * A supplier who cannot replace a faulty bottle sends a different one - the
 * next size, the newer batch, another product entirely against the same credit.
 * NULL means like for like, which is what every replacement recorded before
 * this was, so nothing already written changes meaning.
 *
 * The cost comes with it, because it is not the returned line's: swapping a 300
 * bottle for a 450 one leaves 150 owing, and valuing both at 300 would quietly
 * lose the shop money on every uneven swap.
 */
export default {
  name: '025-purchase-replacement-item',

  async up({ hasTable, hasColumn, addColumn }) {
    if (!(await hasTable('purchase_return_lines'))) return;

    if (!(await hasColumn('purchase_return_lines', 'replacement_variant_id'))) {
      await addColumn('purchase_return_lines', 'replacement_variant_id', 'INTEGER');
    }
    if (!(await hasColumn('purchase_return_lines', 'replacement_unit_cost'))) {
      await addColumn('purchase_return_lines', 'replacement_unit_cost', 'REAL NOT NULL DEFAULT 0');
    }
  },
};
