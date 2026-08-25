/**
 * Round 13, third piece: a return that can be un-done, and says so on its face.
 *
 * ── Why a return needs a state at all ────────────────────────────────────────
 * Until now a `sales_returns` row had exactly one meaning: this came back, the
 * money went out. That was enough while the only way to correct a mistaken
 * return was to not make it. سلة المهملات changes that — deleting a return has
 * to un-write-off the damaged pieces, take the restocked ones back off the
 * shelf, put the loyalty points back and cancel the voucher — and the row it
 * did all that to must not go on being counted as a refund afterwards.
 *
 * Deleting the row outright was never an option. Its number was printed on a
 * slip a customer is holding, and a shop's history is not something a delete
 * button gets to rewrite. So the row stays, and carries the truth about itself:
 *
 *   status           `completed` (everything that exists today) or `reversed`
 *   reversed_at      when it was undone
 *   reversed_by      who undid it — the same question the audit log answers,
 *                    kept on the row so a report never has to join to find it
 *   reversal_reason  why, in the words of the person who did it
 *
 * ── What this does to the money ──────────────────────────────────────────────
 * Nothing, today: every existing row gets `completed`, so every refund figure,
 * every profit line and every supplier statement reads exactly what it read
 * yesterday. From here on, the aggregations that speak about money — refunds,
 * cost back, the returns report, the fleet summary, the product's return
 * count — skip `reversed`, because a refund that was undone is not a refund.
 * The bin's own screens still show it, which is the point of keeping it.
 */
export default {
  name: '021-return-reversal',

  async up({ hasColumn, addColumn }) {
    if (!await hasColumn('sales_returns', 'status')) {
      // No CHECK constraint: SQLite cannot add one to a live table, and the
      // service is the thing that decides which words are legal here.
      await addColumn('sales_returns', 'status', "TEXT NOT NULL DEFAULT 'completed'");
    }
    if (!await hasColumn('sales_returns', 'reversed_at')) {
      await addColumn('sales_returns', 'reversed_at', 'TEXT');
    }
    if (!await hasColumn('sales_returns', 'reversed_by')) {
      await addColumn('sales_returns', 'reversed_by', 'INTEGER');
    }
    if (!await hasColumn('sales_returns', 'reversal_reason')) {
      await addColumn('sales_returns', 'reversal_reason', 'TEXT');
    }
  },
};
