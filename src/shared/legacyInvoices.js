/**
 * فواتيرك — the invoices the shop already had on paper, defined once.
 *
 * Lives in `shared/` for the reason `attachments.js`, `supplierPayments.js` and
 * `costs.js` do: `schema.js` is the shape a NEW database is created with, and a
 * migration has to carry an EXISTING one to it. Both import this string, so the
 * two can never drift apart by a column.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THIS IS A RECORD, NOT A TRANSACTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner's words: *"والصفحه دي كلها لكل الداتا القديمه … متدخلهاش في حسابات
 * السيستيم"* — everything on this page is the old data, keep it out of the
 * system's accounts.
 *
 * These are invoices from before the shop had an ERP. The goods on them were
 * received before the system existed, the money on them left the till before
 * the system existed, and both are already reflected in whatever stock and cash
 * the shop had on the day it started using it. Letting them into the totals
 * would count the same spending twice — and a shop owner who finds his profit
 * has silently moved because of a photograph he filed stops believing every
 * other number on the screen.
 *
 * The separation is STRUCTURAL, not a convention:
 *
 *   · Two tables of their own. Nothing that already sums the shop's money reads
 *     them, because nothing that already exists knows their names. `costs` is
 *     the only place non-stock money-out is stored and this is not it;
 *     `purchase_orders` / `purchase_payments` drive every supplier balance and
 *     this is not those either. `tests/legacy-invoices.test.js` proves it two
 *     ways: no other source file mentions these tables, and every existing
 *     total is byte-identical before and after a legacy invoice is filed and
 *     paid.
 *
 *   · No `warehouse_id`, no stock movement, no variant lines. There is nothing
 *     here for inventory to post: the goods arrived years ago.
 *
 *   · Its own module (`legacy_invoices`), so a shop on a small package does not
 *     silently gain the page, and its own permissions, so seeing the archive is
 *     not the same right as seeing purchasing.
 *
 * ── The three columns worth explaining ──────────────────────────────────────
 *
 *   total_amount   NULLABLE, deliberately. He photographs a bill in the shop
 *                  today and reads the amount off it next week; a page that
 *                  refuses the photograph until he types a number is a page he
 *                  stops using. Until it is filled in the invoice's status is
 *                  `unknown` — honest, rather than calling it unpaid on the
 *                  strength of a number nobody has entered.
 *
 *   paid_amount    DERIVED. `SUM(amount) WHERE status = 'recorded'`, written by
 *                  the database inside the same statement that recomputes the
 *                  status (see `RECOMPUTE_SQL`), never incremented in
 *                  JavaScript — which is what makes two payments recorded at
 *                  the same instant impossible to lose. Same reasoning, and the
 *                  same shape, as `purchase_orders.paid_amount`.
 *
 *   status         DERIVED TOO, never typed, from exactly those two numbers.
 *                  It is stored rather than computed per query so the list can
 *                  filter and index on "what do I still owe?", which is the
 *                  question that brings him to this page.
 */

/** Both the schema and migration 015 apply exactly this. */
export const LEGACY_INVOICES_SQL = `
CREATE TABLE IF NOT EXISTS legacy_invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The name HE gives it — "فاتورة الشنط من مصنع العتبة". Not a generated
  -- number: this row is a photograph he has to recognise in six months.
  title         TEXT    NOT NULL,
  -- Required. "اربطها بمورد معين" is the reason the page exists, and an archive
  -- with unattached rows in it is the un-findable pile he is escaping.
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  -- What is written on the paper, if anything is. Searchable, because it is
  -- what the supplier says on the phone.
  invoice_no    TEXT,
  invoice_date  TEXT,
  -- NULL until he reads it off the paper. See the note above.
  total_amount  REAL    CHECK (total_amount IS NULL OR total_amount > 0),
  paid_amount   REAL    NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status        TEXT    NOT NULL DEFAULT 'unknown'
                CHECK (status IN ('unknown','unpaid','partial','paid')),
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_legacy_invoices_supplier
  ON legacy_invoices(supplier_id, invoice_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_invoices_status
  ON legacy_invoices(status, invoice_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS legacy_invoice_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES legacy_invoices(id) ON DELETE CASCADE,
  paid_on         TEXT    NOT NULL,                    -- the day the money moved
  amount          REAL    NOT NULL CHECK (amount > 0),
  method          TEXT    NOT NULL DEFAULT 'cash',     -- cash | card | transfer | wallet | cheque
  reference       TEXT,
  note            TEXT,
  -- Never deleted, only reversed — see LegacyInvoiceService.reversePayment.
  status          TEXT    NOT NULL DEFAULT 'recorded'
                  CHECK (status IN ('recorded','reversed')),
  reversal_reason TEXT,
  reversed_at     TEXT,
  reversed_by     INTEGER REFERENCES users(id),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_legacy_invoice_payments
  ON legacy_invoice_payments(invoice_id, paid_on DESC, id DESC)
`;

/**
 * The running total and the status, both computed by the DATABASE, in one
 * statement, from the payment rows as they stand at this instant.
 *
 * That is the whole point of it being one statement and of the numbers never
 * being read into JavaScript, added to and written back: two payments recorded
 * at the same moment cannot lose each other, because whichever commits second
 * sums both — and the status it writes is the status of that sum, so the two
 * can never disagree either. `PurchaseRepository.recomputePaid` is the same
 * decision one layer up; the only addition here is that the status rides along
 * inside the same statement instead of being a second write that could fail on
 * its own.
 *
 * The four outcomes, in the owner's terms:
 *   unknown  — no total recorded yet, so nothing can honestly be said
 *   unpaid   — لسه متدفعتش
 *   partial  — متبقي عليها
 *   paid     — اتدفعت كاملة
 *
 * A payment that overshoots the total settles the invoice (`paid`) rather than
 * being refused: this is an archive of paper, and the number he typed last week
 * is not more trustworthy than the receipt in his hand today. What is NOT done
 * is hiding it — the service reports the excess as `over_paid` and the screen
 * says so, so he can fix whichever of the two numbers is wrong.
 *
 * Takes the invoice id three times.
 */
export const RECOMPUTE_SQL = `
UPDATE legacy_invoices
   SET paid_amount = ROUND(COALESCE((
         SELECT SUM(amount) FROM legacy_invoice_payments
          WHERE invoice_id = ? AND status = 'recorded'), 0), 2),
       status = CASE
         WHEN total_amount IS NULL THEN 'unknown'
         WHEN ROUND(COALESCE((
                SELECT SUM(amount) FROM legacy_invoice_payments
                 WHERE invoice_id = ? AND status = 'recorded'), 0), 2) <= 0 THEN 'unpaid'
         WHEN ROUND(COALESCE((
                SELECT SUM(amount) FROM legacy_invoice_payments
                 WHERE invoice_id = ? AND status = 'recorded'), 0), 2)
              + 0.005 >= ROUND(total_amount, 2) THEN 'paid'
         ELSE 'partial'
       END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = ?
`;

/** The four statuses, in the order a person reads them. */
export const LEGACY_INVOICE_STATUSES = ['unknown', 'unpaid', 'partial', 'paid'];

/**
 * The same rule as `RECOMPUTE_SQL`, in JavaScript, for tests and for anything
 * that needs to predict a status without writing one. The SQL is the authority
 * — this exists so the authority can be checked against something readable.
 */
export function deriveStatus({ total_amount: total, paid_amount: paid = 0 } = {}) {
  if (total === null || total === undefined) return 'unknown';
  const settled = Math.round(Number(paid) * 100) / 100;
  if (settled <= 0) return 'unpaid';
  if (settled + 0.005 >= Math.round(Number(total) * 100) / 100) return 'paid';
  return 'partial';
}

export default LEGACY_INVOICES_SQL;
