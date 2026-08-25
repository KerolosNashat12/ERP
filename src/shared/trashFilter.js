/**
 * "What is in the recycle bin is not on this screen."
 *
 * Master-data repositories get this for free from `BaseRepository` via their
 * `trashType` option. Documents — invoices, returns, purchase orders, stock
 * adjustments — build their own SELECT with joins and paging, so they append
 * this fragment by hand instead.
 *
 * It lives in `shared/` rather than in TrashService because the repositories
 * are what TrashService is built ON: importing it from there would close a
 * cycle. There is no state here and nothing to configure — just the one clause,
 * written once, so every screen means the same thing by "deleted".
 *
 * The entity type is interpolated, never bound: these are literals from the
 * policy registry a few lines below their only callers, never user input, and
 * inlining keeps the fragment usable in queries whose parameters are already
 * ordered around joins.
 */
export const notInBin = (entityType, idColumn) => (
  `NOT EXISTS (SELECT 1 FROM trash_items tb WHERE tb.entity_type = '${entityType}' `
  + `AND tb.entity_id = ${idColumn} AND tb.status = 'in_bin')`
);

export default notInBin;
