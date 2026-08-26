/**
 * الاستبدال — the customer brings something back and takes something else.
 *
 * ── The one design decision, and why ────────────────────────────────────────
 * An exchange is NOT a third kind of document. It is a RETURN and a SALE, both
 * of which this system already knows how to do properly: they move stock
 * through the ledger, they handle a damaged piece differently from a resellable
 * one, they take back loyalty points, they respect the return window, they are
 * audited, and they have been used every day for months. Writing a third
 * document that did all of that again would be a second implementation of the
 * two most delicate paths in the shop, kept in step by good intentions.
 *
 * So this service orchestrates, and owns exactly one thing of its own: the
 * `exchanges` row that says those two documents and the original invoice are
 * one act. That row is what makes an exchange traceable six months later, from
 * any of the three.
 *
 * ── The money, in one sentence ──────────────────────────────────────────────
 * The returned goods are worth what the customer actually paid for them —
 * after every discount that was on that invoice — and that credit is spent on
 * the replacement. Whatever is left over crosses the counter: the customer pays
 * the difference, or the shop hands the difference back in cash.
 *
 * The credit is recorded as a PAYMENT on the new invoice, not as a discount on
 * it. That distinction is the whole reason the shop's revenue stays true: a
 * 1,200 replacement settled with 800 of credit and 400 in cash is 1,200 of
 * revenue that was paid for in two ways, not a 400 sale. `sale_payments.method`
 * carries `exchange_credit` — that column has no CHECK constraint, which is why
 * this needs no migration on a live database.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 * Everything the return path refuses (a void invoice, more than was bought,
 * a line already fully returned) plus its own: nothing to give back, nothing to
 * take, and a replacement the shop does not have. Every one of those is checked
 * INSIDE the transaction, so two cashiers exchanging the last bottle at the
 * same moment cannot both succeed.
 */
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import returnService from './ReturnService.js';
import salesService from './SalesService.js';
import auditService from './AuditService.js';

/** How the difference crosses the counter, either way. */
const SETTLEMENT_METHODS = ['cash', 'card', 'transfer', 'wallet'];

export class ExchangeService {
  constructor(deps = {}) {
    this.sales = deps.sales || repositories.sales;
    this.returns = deps.returns || repositories.salesReturns;
    this.sequences = deps.sequences || repositories.sequences;
    this.inventory = deps.inventory || repositories.inventory;
    this.returnService = deps.returnService || returnService;
    this.salesService = deps.salesService || salesService;
    this.audit = deps.audit || auditService;
  }

  get db() {
    return getDb();
  }

  /**
   * What the counter needs to start an exchange: the invoice, what is still
   * returnable on it, and what it was worth.
   *
   * Deliberately the SAME lookup the returns screen uses, so the two screens
   * can never disagree about how much of a line is left — there is one
   * definition of "returnable" in this system and it lives in `ReturnService`.
   */
  async lookup(reference) {
    return this.returnService.lookupInvoice(reference);
  }

  async list(query = {}) {
    const { page = 1, pageSize = 25, saleId } = query;
    const where = [];
    const params = [];
    if (saleId) { where.push('e.sale_id = ?'); params.push(Number(saleId)); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
    const current = Math.max(Number(page) || 1, 1);

    const total = Number((await this.db
      .prepare(`SELECT COUNT(*) AS n FROM exchanges e ${whereSql}`).get(...params))?.n || 0);
    const rows = await this.db.prepare(`
      SELECT e.*, c.name AS customer_name, u.full_name AS created_by_name
      FROM exchanges e
      LEFT JOIN customers c ON c.id = e.customer_id
      LEFT JOIN users u ON u.id = e.created_by
      ${whereSql}
      ORDER BY e.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  /** One exchange, with both documents behind it. */
  async get(id) {
    const row = await this.db.prepare(`
      SELECT e.*, c.name AS customer_name, u.full_name AS created_by_name
      FROM exchanges e
      LEFT JOIN customers c ON c.id = e.customer_id
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.id = ?
    `).get(Number(id));
    if (!row) throw new NotFoundError('Exchange', id);
    return {
      ...row,
      original: await this.sales.findAggregate(row.sale_id),
      return: await this.returnService.get(row.return_id),
      replacement: await this.sales.findAggregate(row.new_sale_id),
    };
  }

  /**
   * Do the exchange.
   *
   * One transaction from end to end: if the replacement cannot be sold — no
   * stock, a variant that does not exist — the return is rolled back with it
   * and the customer is not left having handed a bottle over for nothing.
   */
  async create(payload = {}, context = {}) {
    const settlement = SETTLEMENT_METHODS.includes(payload.settlement_method)
      ? payload.settlement_method
      : 'cash';

    const back = (payload.lines || []).filter((line) => Number(line.quantity) > 0);
    const out = (payload.replacements || []).filter((line) => Number(line.quantity) > 0);
    if (!back.length) {
      throw new ValidationError('Choose what the customer is bringing back',
        { rule: 'exchange_nothing_back' });
    }
    if (!out.length) {
      throw new ValidationError('Choose what the customer is taking instead',
        { rule: 'exchange_nothing_out' });
    }

    return transaction(async () => {
      const header = payload.sale_id
        ? await this.sales.findById(payload.sale_id)
        : await this.sales.findByInvoiceNo(payload.invoice_no);
      if (!header) throw new NotFoundError('Invoice', payload.invoice_no || payload.sale_id);
      if (header.status === 'void') {
        throw new BusinessRuleError('That invoice was cancelled — there is nothing to exchange against',
          { rule: 'exchange_void' });
      }

      /*
       * The return leg. `settlement: 'exchange'` tells ReturnService to record
       * the credit without paying it out or issuing a voucher: it is about to
       * be spent, two dozen lines below, inside this same transaction.
       *
       * Every refusal a return has applies here unchanged — the window, the
       * quantities, a line already fully returned — which is exactly why this
       * goes through that service rather than around it.
       */
      const credited = await this.returnService.create({
        return_type: 'with_receipt',
        sale_id: header.id,
        reason_code: payload.reason_code || 'wrong_item',
        reason_note: payload.reason_note || null,
        settlement: 'exchange',
        lines: back.map((line) => ({
          sale_line_id: line.sale_line_id,
          quantity: line.quantity,
          condition: line.condition === 'damaged' ? 'damaged' : 'resellable',
          notes: line.notes || null,
        })),
      }, context);

      const credit = round2(credited.total_amount);

      /*
       * The replacement leg.
       *
       * Quoted first, then sold. The quote is what makes the arithmetic
       * possible in the right order: how much of the credit applies, and what
       * is left to settle, can only be known once the replacement has been
       * priced — and it must be priced by the same code that prices any other
       * sale, offers included, or an exchange becomes a second place where a
       * price is decided.
       */
      const quoteLines = out.map((line, index) => ({
        key: index + 1,
        variant_id: line.variant_id,
        quantity: line.quantity,
      }));
      const quote = await this.salesService.quote({
        lines: quoteLines,
        customer_id: header.customer_id || null,
      });
      const replacementTotal = round2(quote.totalAmount);

      const applied = round2(Math.min(credit, replacementTotal));
      // Positive: the customer pays. Negative: the shop hands money back.
      const difference = round2(replacementTotal - credit);

      /*
       * The credit is a PAYMENT on the new invoice, never a discount on it.
       *
       * A 1,200 replacement settled with 800 of credit and 400 in cash is 1,200
       * of revenue paid for in two ways. Recorded as a discount it would take
       * 800 off the month for money the shop had already been given, and the
       * profit report would quietly under-count every exchange in the shop.
       */
      const payments = [];
      if (applied > 0) {
        payments.push({ method: 'exchange_credit', amount: applied, reference: credited.return_no });
      }
      if (difference > 0) payments.push({ method: settlement, amount: difference });

      const replacement = await this.salesService.checkout({
        customer_id: header.customer_id || null,
        notes: `Exchange against ${header.invoice_no}`,
        lines: quoteLines,
        payments,
        payment_method: settlement,
      }, context);

      /*
       * A cheaper replacement leaves money over, and it goes back across the
       * counter in cash.
       *
       * Deliberately NOT written as a payment row against the new invoice. That
       * invoice is for 500 and was settled in full by 500 of credit; a −300 row
       * on it would make the payments behind it sum to 200 against a
       * `paid_amount` of 500, and the first person to reconcile the two would
       * be right to think something was broken.
       *
       * Where the 300 lives instead: `exchanges.difference_amount` is negative
       * and `settlement_method` says how it left, which is what the exchange
       * screen shows and what a person asking "why is the drawer 300 light"
       * finds. The return above still records the full 800 of credit, because
       * that is what the goods were worth — 500 of it became a replacement and
       * 300 of it became cash.
       */

      const record = await this.#record({
        header,
        credited,
        replacement,
        credit,
        replacementTotal,
        difference,
        settlement,
        notes: payload.notes || null,
        context,
      });

      await this.audit.record({
        action: 'EXCHANGE',
        module: 'sales',
        entityType: 'exchange',
        entityId: record.id,
        entityLabel: record.exchange_no,
        after: {
          invoice: header.invoice_no,
          return_no: credited.return_no,
          new_invoice: replacement.invoice_no,
          credit,
          replacement: replacementTotal,
          // Positive: the customer paid. Negative: the shop paid back.
          difference,
          settlement,
        },
        actor: context.actor,
        request: context.request,
      });

      return this.get(record.id);
    });
  }

  async #record({
    header, credited, replacement, credit, replacementTotal, difference, settlement, notes, context,
  }) {
    const exchangeNo = await this.sequences.next('exchange');
    const info = await this.db.prepare(`
      INSERT INTO exchanges
        (exchange_no, sale_id, invoice_no, return_id, return_no, new_sale_id, new_invoice_no,
         customer_id, warehouse_id, credit_amount, replacement_amount, difference_amount,
         settlement_method, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchangeNo, header.id, header.invoice_no, credited.id, credited.return_no,
      replacement.id, replacement.invoice_no, header.customer_id || null,
      credited.warehouse_id, credit, replacementTotal, difference, settlement,
      notes, context.actor?.id || null,
    );
    return { id: Number(info.lastInsertRowid), exchange_no: exchangeNo };
  }
}

export const exchangeService = new ExchangeService();
export default exchangeService;
