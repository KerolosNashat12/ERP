/**
 * Round 13: سلة المهملات — the recycle bin.
 *
 * ── The problem it solves ────────────────────────────────────────────────────
 * Deleting anything in this system used to mean one of two things, and neither
 * of them was "delete". Master data was DEACTIVATED — the owner pressed delete
 * on a product, saw "تم الحفظ بنجاح", and the product was still there — or, if
 * nothing referenced it, it was hard-deleted and gone forever with no way back.
 * Documents could not be deleted at all: a test invoice raised on the first day
 * of trading sat in the accounts permanently, and the shop's owner had to read
 * around it every time he looked at his own figures.
 *
 * ── The ledger ───────────────────────────────────────────────────────────────
 * `trash_items` is not where deleted things are STORED. Products and invoices
 * stay in their own tables, exactly where they were, with their own references
 * intact — moving a sale into a bin table would break every foreign key
 * pointing at it and every report that has ever added it up. This is the
 * REGISTER: what was deleted, by whom, when it may be purged, what had to be
 * reversed to make the deletion safe, and enough of a snapshot to say what the
 * thing was after it is gone.
 *
 * Anything with an `in_bin` row here is hidden from the screens it used to
 * appear on. Restoring is deleting the register entry's claim on it; purging is
 * the only step that destroys anything, and it happens once, after thirty days,
 * and only if the record is still safe to destroy on that day.
 *
 * ── `effect` and why it is written down ──────────────────────────────────────
 * Deleting a document that moved money or stock reverses it first, through the
 * document's own service — a sale is voided, a return is reversed, a purchase
 * order is cancelled. That reversal is real and it is not undone by restoring.
 * `effect` records exactly what was reversed so that the register can say so on
 * the day somebody asks why the stock moved: "this invoice was deleted on the
 * 3rd, and 4 pieces went back on the shelf for it."
 */
export default {
  name: '019-recycle-bin',

  async up({ ddl }) {
    await ddl(`
      CREATE TABLE IF NOT EXISTS trash_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        module       TEXT    NOT NULL,
        entity_type  TEXT    NOT NULL,
        entity_id    INTEGER NOT NULL,
        label        TEXT    NOT NULL,
        detail       TEXT,
        snapshot     TEXT,
        effect       TEXT,
        reason       TEXT,
        status       TEXT    NOT NULL DEFAULT 'in_bin'
                     CHECK (status IN ('in_bin', 'restored', 'purged')),
        deleted_at   TEXT    NOT NULL,
        deleted_by   INTEGER REFERENCES users(id),
        purge_after  TEXT    NOT NULL,
        restored_at  TEXT,
        restored_by  INTEGER REFERENCES users(id),
        purged_at    TEXT,
        purged_by    INTEGER REFERENCES users(id)
      )
    `);

    /*
     * The index the hiding depends on. Every list that can hide a deleted row
     * asks "is this one in the bin?" once per query, so this is on the hot path
     * of the products screen and must be an index seek rather than a scan.
     */
    await ddl(`
      CREATE INDEX IF NOT EXISTS idx_trash_entity
        ON trash_items(entity_type, entity_id, status)
    `);
    await ddl('CREATE INDEX IF NOT EXISTS idx_trash_status ON trash_items(status, deleted_at DESC)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash_items(status, purge_after)');

    /*
     * One thing may be in the bin once. A partial unique index rather than a
     * table constraint, because a record CAN be deleted, restored and deleted
     * again — and each of those is its own row in the register.
     */
    await ddl(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trash_one_live
        ON trash_items(entity_type, entity_id) WHERE status = 'in_bin'
    `);
  },
};
