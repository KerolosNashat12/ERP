/**
 * Supplier payments against a purchase order, defined once — see
 * `shared/attachments.js` for why this string lives here and not only in
 * `schema.js`.
 *
 * Before this table there was no payment: `POST /api/purchases/:id/payment`
 * added to `purchase_orders.paid_amount` and wrote an audit line, so the shop
 * could say how much it had paid a supplier in total and nothing at all about
 * when, how, or against which receipt.
 *
 * `paid_amount` on the order is kept — the list, the supplier balance and the
 * reports all read it — but it is now a running total DERIVED from these rows
 * (`SUM(amount) WHERE status = 'recorded'`), recomputed inside the same
 * transaction that writes one. It is never incremented in JavaScript, which is
 * what makes two payments recorded at the same moment impossible to lose.
 *
 * A payment is never deleted, only reversed: see `PurchaseService.reversePayment`.
 */
export const PURCHASE_PAYMENTS_SQL = `
CREATE TABLE IF NOT EXISTS purchase_payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  paid_on           TEXT    NOT NULL,                       -- the day the money moved
  amount            REAL    NOT NULL CHECK (amount > 0),
  method            TEXT    NOT NULL DEFAULT 'cash',        -- cash | card | transfer | wallet | cheque
  reference         TEXT,                                   -- transfer number, cheque number
  note              TEXT,
  status            TEXT    NOT NULL DEFAULT 'recorded'
                    CHECK (status IN ('recorded','reversed')),
  reversal_reason   TEXT,
  reversed_at       TEXT,
  reversed_by       INTEGER REFERENCES users(id),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_po_payments ON purchase_payments(purchase_order_id, paid_on DESC, id DESC);
-- "how much did the shop actually pay its suppliers between these dates" — the
-- spend report's first question, and the one read that comes at this table by
-- DATE rather than by order. The index above leads on the order id and cannot
-- answer it. Restricted to recorded rows because a reversed payment is money
-- that never left. Added to existing databases by migration 016.
CREATE INDEX IF NOT EXISTS idx_po_payments_day
  ON purchase_payments(date(paid_on), purchase_order_id, amount) WHERE status = 'recorded'
`;

export default PURCHASE_PAYMENTS_SQL;
