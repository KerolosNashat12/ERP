/**
 * Queries for فواتيرك — the archive of paper invoices and the payments filed
 * against them.
 *
 * Nothing in this file is read by any other repository, service or report, and
 * that is the point rather than an accident: see the head of
 * `shared/legacyInvoices.js`. The two table names appear here, in the service
 * that owns them, in the schema and in the migration — nowhere else in `src/`.
 *
 * The one shape worth reading is `recompute()`. It is a single statement that
 * asks the DATABASE for the sum of the payment rows and writes both the running
 * total and the derived status from it, so two payments recorded at the same
 * moment cannot lose each other and the status can never disagree with the
 * total it was computed from. `PurchaseRepository.recomputePaid` is the same
 * decision one layer up.
 */
import BaseRepository from './BaseRepository.js';
import { RECOMPUTE_SQL, LEGACY_INVOICE_STATUSES } from '../../shared/legacyInvoices.js';

/**
 * One filter builder, used by the list and by the totals, so the number on the
 * screen and the number in the header can never come from two spellings of the
 * same question.
 *
 * What a shop owner actually searches by, six months later, is the whole
 * reason this exists: the name he gave it, the number written on the paper,
 * the supplier, whether he still owes on it, and roughly when it was.
 */
export function legacyInvoiceFilter(filters = {}, alias = 'i') {
  const where = [];
  const params = [];
  const q = (column) => `${alias}.${column}`;

  if (filters.supplierId) { where.push(`${q('supplier_id')} = ?`); params.push(Number(filters.supplierId)); }
  if (filters.status && LEGACY_INVOICE_STATUSES.includes(String(filters.status))) {
    where.push(`${q('status')} = ?`);
    params.push(String(filters.status));
  }
  // "What do I still owe?" — the question that brings him here. One flag rather
  // than making him tick two of the four statuses.
  if (filters.outstandingOnly === true || filters.outstandingOnly === '1' || filters.outstandingOnly === 'true') {
    where.push(`${q('status')} IN ('unpaid','partial','unknown')`);
  }
  if (filters.dateFrom) { where.push(`date(${q('invoice_date')}) >= date(?)`); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push(`date(${q('invoice_date')}) <= date(?)`); params.push(filters.dateTo); }
  if (filters.search) {
    const like = `%${String(filters.search).trim()}%`;
    // The supplier's name is in here on purpose: typing "العتبة" has to find
    // the invoices from that supplier, and he does not think of the dropdown
    // as a different act from typing.
    where.push(`(${q('title')} LIKE ? OR ${q('invoice_no')} LIKE ? OR ${q('notes')} LIKE ?
                 OR s.name_en LIKE ? OR s.name_ar LIKE ?)`);
    params.push(like, like, like, like, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const DETAIL_COLUMNS = `
  i.*, s.name_en AS supplier_name_en, s.name_ar AS supplier_name_ar,
  s.phone AS supplier_phone, u.full_name AS created_by_name
`;

const DETAIL_JOINS = `
  FROM legacy_invoices i
  JOIN suppliers s ON s.id = i.supplier_id
  LEFT JOIN users u ON u.id = i.created_by
`;

export class LegacyInvoiceRepository extends BaseRepository {
  constructor() {
    super({
      table: 'legacy_invoices',
      // `paid_amount` and `status` are absent on purpose: both are derived by
      // `recompute()` and a caller must not be able to write either.
      columns: [
        'title', 'supplier_id', 'invoice_no', 'invoice_date', 'total_amount',
        'notes', 'created_by',
      ],
      searchable: ['title', 'invoice_no', 'notes'],
      defaultSort: 'invoice_date DESC, id DESC',
    });
  }

  /** Paginated, with the supplier named — sorted newest paper first. */
  async listDetailed(query = {}) {
    const { sql, params } = legacyInvoiceFilter(query);
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 200);

    const total = (await this.db.prepare(`
      SELECT COUNT(*) AS n FROM legacy_invoices i JOIN suppliers s ON s.id = i.supplier_id ${sql}
    `).get(...params)).n;

    const rows = await this.db.prepare(`
      SELECT ${DETAIL_COLUMNS} ${DETAIL_JOINS} ${sql}
      -- A row with no date on the paper still has to appear, and it belongs
      -- with the newest rather than lost at the bottom: COALESCE puts it on the
      -- day it was filed.
      ORDER BY date(COALESCE(i.invoice_date, i.created_at)) DESC, i.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);

    return { rows, total, page, pageSize, pages: Math.ceil(total / pageSize) || 1 };
  }

  async findDetailed(id) {
    return (await this.db.prepare(`
      SELECT ${DETAIL_COLUMNS} ${DETAIL_JOINS} WHERE i.id = ?
    `).get(Number(id))) || null;
  }

  /**
   * The header of the screen: how many photographed invoices are in the filter,
   * what they come to, what has been paid against them and what is still owed.
   *
   * `total_amount` is nullable, so the count of invoices with no amount yet is
   * part of the answer rather than a silent zero — "3,000 owed" means something
   * different when four of the invoices have no number on them at all.
   */
  async summary(filters = {}) {
    const { sql, params } = legacyInvoiceFilter(filters);
    return this.db.prepare(`
      SELECT
        COUNT(*)                                             AS invoices,
        COALESCE(SUM(i.total_amount), 0)                     AS total_amount,
        COALESCE(SUM(i.paid_amount), 0)                      AS paid_amount,
        COALESCE(SUM(CASE WHEN i.total_amount IS NULL THEN 0
                          ELSE MAX(i.total_amount - i.paid_amount, 0) END), 0) AS outstanding,
        SUM(CASE WHEN i.total_amount IS NULL THEN 1 ELSE 0 END)      AS without_amount,
        SUM(CASE WHEN i.status = 'paid' THEN 1 ELSE 0 END)           AS settled,
        SUM(CASE WHEN i.status = 'partial' THEN 1 ELSE 0 END)        AS partly_paid,
        SUM(CASE WHEN i.status = 'unpaid' THEN 1 ELSE 0 END)         AS unpaid
      FROM legacy_invoices i JOIN suppliers s ON s.id = i.supplier_id
      ${sql}
    `).get(...params);
  }

  // --------------------------------------------------------------- payments

  /** Every payment ever recorded against one invoice, newest first, reversals included. */
  async payments(invoiceId) {
    return this.db.prepare(`
      SELECT p.*, u.full_name AS created_by_name, r.full_name AS reversed_by_name
      FROM legacy_invoice_payments p
      LEFT JOIN users u ON u.id = p.created_by
      LEFT JOIN users r ON r.id = p.reversed_by
      WHERE p.invoice_id = ?
      ORDER BY p.paid_on DESC, p.id DESC
    `).all(Number(invoiceId));
  }

  async findPayment(invoiceId, paymentId) {
    return this.db.prepare(
      'SELECT * FROM legacy_invoice_payments WHERE id = ? AND invoice_id = ?',
    ).get(Number(paymentId), Number(invoiceId));
  }

  async insertPayment(invoiceId, payment) {
    const result = await this.db.prepare(`
      INSERT INTO legacy_invoice_payments
        (invoice_id, paid_on, amount, method, reference, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(invoiceId), payment.paid_on, payment.amount, payment.method,
      payment.reference || null, payment.note || null, payment.created_by || null,
    );
    return Number(result.lastInsertRowid);
  }

  async reversePayment(paymentId, { reason, actorId }) {
    await this.db.prepare(`
      UPDATE legacy_invoice_payments
         SET status = 'reversed', reversal_reason = ?, reversed_by = ?,
             reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'recorded'
    `).run(reason || null, actorId || null, Number(paymentId));
  }

  /** How many payments an invoice still counts — a record with money on it is not deleted. */
  async countRecordedPayments(invoiceId) {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS n FROM legacy_invoice_payments
      WHERE invoice_id = ? AND status = 'recorded'
    `).get(Number(invoiceId));
    return Number(row?.n || 0);
  }

  /** Ids of every payment on an invoice — the photographs hang off these. */
  async paymentIds(invoiceId) {
    const rows = await this.db.prepare(
      'SELECT id FROM legacy_invoice_payments WHERE invoice_id = ?',
    ).all(Number(invoiceId));
    return rows.map((row) => Number(row.id));
  }

  /**
   * Every payment row on one record, gone.
   *
   * The foreign key says `ON DELETE CASCADE` and the application does set
   * `PRAGMA foreign_keys = ON`, so this is belt and braces — but a pragma is a
   * property of a CONNECTION, and this feature is not going to be the place
   * where a driver that forgot to set it leaves orphaned payment rows pointing
   * at an invoice that no longer exists.
   */
  async deletePayments(invoiceId) {
    await this.db.prepare('DELETE FROM legacy_invoice_payments WHERE invoice_id = ?')
      .run(Number(invoiceId));
  }

  /**
   * Bring the running total AND the status back in step with the payment rows,
   * in one statement the database evaluates. See `RECOMPUTE_SQL`.
   * Returns what it wrote, so the caller needs no second read to report it.
   */
  async recompute(invoiceId) {
    const id = Number(invoiceId);
    await this.db.prepare(RECOMPUTE_SQL).run(id, id, id, id);
    const row = await this.db.prepare(
      'SELECT paid_amount, total_amount, status FROM legacy_invoices WHERE id = ?',
    ).get(id);
    return {
      paid_amount: Number(row?.paid_amount || 0),
      total_amount: row?.total_amount === null || row?.total_amount === undefined
        ? null : Number(row.total_amount),
      status: row?.status || 'unknown',
    };
  }
}

export default LegacyInvoiceRepository;
