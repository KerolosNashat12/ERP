/**
 * صفحة فواتيرك — the invoices the shop already had on paper.
 *
 * *"اضيف فيها كل صور فواتيري و اضيف منها الفاتوره دي تبع انهي مورد … واقول تحت
 * الصوره ان تم تدفع الفاتوره دي كامله ولا لسه متبقي عليها … واقدر اعمل اسم
 * لصور الفواتير دي وتكون اكتر من صوره"*
 *
 * A name he gives it, the supplier it belongs to, several photographs because a
 * paper invoice runs to several pages, what it came to, and the payments he
 * records against it over time until it is settled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE RULE THAT SHAPES EVERY LINE BELOW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * *"والصفحه دي كلها لكل الداتا القديمه … متدخلهاش في حسابات السيستيم"*
 *
 * These rows are a RECORD, not a transaction. Read the head of
 * `shared/legacyInvoices.js` for why, in full. What it means for this file:
 *
 *   · Nothing here calls `InventoryService`. No stock moves; the goods arrived
 *     before the system existed.
 *   · Nothing here writes a `costs` row, and nothing writes a
 *     `purchase_order` / `purchase_payment` row. Those two tables are what
 *     every existing total in the system is built from — the costs page, the
 *     profit report, the dashboard, `SupplierRepository.statistics` — and a
 *     legacy invoice that reached either of them would count spending the shop
 *     already accounted for a second time.
 *   · The only tables written are `legacy_invoices`,
 *     `legacy_invoice_payments`, `attachments` (the photographs) and
 *     `audit_log`. Nothing existing reads the first two.
 *
 * Three decisions that are not obvious:
 *
 *  1. **A total is optional.** He photographs a bill in the shop today and
 *     reads the amount off it next week. The status is `unknown` until then —
 *     saying "unpaid" on the strength of a number nobody has typed would be a
 *     claim the data does not support.
 *
 *  2. **A payment that overshoots is accepted, not refused.** `PurchaseService`
 *     refuses one, correctly: there the order total is a document the shop
 *     itself raised and a payment past it is a mistake. Here the total is a
 *     number somebody read off a photograph, and refusing the receipt in his
 *     hand because of it would be trusting the weaker of the two. So the
 *     invoice settles and the excess is reported as `over_paid`, on the row and
 *     on the screen, so he fixes whichever number is wrong.
 *
 *  3. **A payment is reversed, never deleted** — the same as
 *     `PurchaseService.reversePayment`, though for a different reason, which is
 *     worth being explicit about. There, the row must stay because a supplier
 *     balance the whole system reads was computed from it. Here nothing outside
 *     this page reads it, so that argument does not apply. Two others do, and
 *     they are enough. The row is what the shop REMEMBERS: "this said settled
 *     last March — why?" has to have an answer, and a deleted row answers
 *     nothing. And the row carries a photograph of a receipt, which is proof of
 *     what was recorded and does not become untrue because the amount was
 *     mistyped; deleting it would throw away the shop's only copy of a
 *     photographed receipt without saying so. The correction is a new payment
 *     for the right amount, which is what the paper trail looks like anyway.
 *
 *     The invoice RECORD itself can be deleted (a page photographed twice is
 *     just a duplicate in a filing cabinet) — but not while recorded money
 *     stands against it, and never without taking its photographs with it.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import auditService from './AuditService.js';
import attachmentService from './AttachmentService.js';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The invoice itself carries the photographs — that is what the record IS.
 * Several of them, because a paper invoice runs to several pages.
 *
 * Declared here rather than inside AttachmentService because this module owns
 * the rows; see the contract at the top of AttachmentService.js. Looking at the
 * photographs is opening the page (`legacy_invoices.view`); adding or removing
 * one is editing the record it belongs to.
 */
attachmentService.registerOwner('legacy_invoice', {
  module: 'legacy_invoices',
  view: 'legacy_invoices.view',
  attach: 'legacy_invoices.update',
  exists: async (id) => Boolean(await repositories.legacyInvoices.findById(Number(id))),
  label: async (id) => {
    const row = await repositories.legacyInvoices.findDetailed(id);
    return row ? `${row.title} — ${row.supplier_name_en}` : `legacy invoice ${id}`;
  },
});

/**
 * And a payment against one can carry its own photograph — the receipt for the
 * instalment, which is a different piece of paper from the invoice. Optional:
 * these payments are often years old and he may have nothing but his memory,
 * and a page that will not record a payment without a photograph is a page that
 * loses the payment.
 *
 * Recording one is `legacy_invoices.pay`, exactly as the payment it proves.
 */
attachmentService.registerOwner('legacy_invoice_payment', {
  module: 'legacy_invoices',
  view: 'legacy_invoices.view',
  attach: 'legacy_invoices.pay',
  exists: async (id) => Boolean(
    await repositories.legacyInvoices.db
      .prepare('SELECT id FROM legacy_invoice_payments WHERE id = ?').get(Number(id)),
  ),
  label: async (id) => {
    const row = await repositories.legacyInvoices.db.prepare(`
      SELECT i.title, p.amount FROM legacy_invoice_payments p
      JOIN legacy_invoices i ON i.id = p.invoice_id
      WHERE p.id = ?
    `).get(Number(id));
    return row ? `${row.title} — payment ${id} (${row.amount})` : `legacy invoice payment ${id}`;
  },
});

export class LegacyInvoiceService {
  constructor(deps = {}) {
    this.invoices = deps.invoices || repositories.legacyInvoices;
    this.suppliers = deps.suppliers || repositories.suppliers;
    this.audit = deps.audit || auditService;
  }

  /**
   * What a row looks like to a screen: the stored numbers, rounded, plus the
   * two things that are questions rather than columns — how much is still
   * owed, and whether more has been paid than the invoice says it came to.
   */
  #decorate(row) {
    if (!row) return row;
    const total = row.total_amount === null || row.total_amount === undefined
      ? null : round2(row.total_amount);
    const paid = round2(row.paid_amount || 0);
    return {
      ...row,
      total_amount: total,
      paid_amount: paid,
      outstanding: total === null ? null : round2(Math.max(total - paid, 0)),
      over_paid: total !== null && paid - total > 0.005 ? round2(paid - total) : 0,
    };
  }

  /** The archive, filtered and paginated, each row with its photographs. */
  async list(query = {}) {
    const page = await this.invoices.listDetailed(query);
    // One query for every invoice's photographs rather than one per invoice: a
    // list of twenty-five must not be twenty-six round trips to a hosted
    // database. See AttachmentService.listMany.
    const byInvoice = await attachmentService.listMany(
      'legacy_invoice', page.rows.map((row) => row.id),
    );
    return {
      ...page,
      rows: page.rows.map((row) => ({
        ...this.#decorate(row),
        attachments: byInvoice[row.id] || [],
      })),
    };
  }

  /**
   * The header of the screen.
   *
   * Every figure here is scoped to `legacy_invoices` alone and is labelled on
   * screen as the old paper archive, in both languages. It is deliberately NOT
   * merged with anything the shop's own accounts show.
   */
  async summary(query = {}) {
    const row = await this.invoices.summary(query);
    return {
      invoices: Number(row.invoices || 0),
      total_amount: round2(row.total_amount),
      paid_amount: round2(row.paid_amount),
      outstanding: round2(row.outstanding),
      without_amount: Number(row.without_amount || 0),
      settled: Number(row.settled || 0),
      partly_paid: Number(row.partly_paid || 0),
      unpaid: Number(row.unpaid || 0),
    };
  }

  async get(id) {
    const row = await this.invoices.findDetailed(id);
    if (!row) throw new NotFoundError('Invoice record', id);
    return {
      ...this.#decorate(row),
      attachments: await attachmentService.list('legacy_invoice', row.id),
    };
  }

  /** Everything a record has to be true about, whether it is being filed or edited. */
  async #prepare(payload, { existing = null } = {}) {
    const title = String(payload.title ?? existing?.title ?? '').trim();
    if (!title) throw new ValidationError('Give this invoice a name so you can find it again');

    const supplierId = payload.supplier_id ?? existing?.supplier_id ?? null;
    if (!supplierId) throw new ValidationError('Say which supplier this invoice belongs to');
    await this.suppliers.requireById(supplierId, 'supplier');

    // The one number the browser may send, and it is rounded here rather than
    // taken as typed — nothing calculated in a browser is trusted as a total.
    // `null` is a real answer: the amount has not been read off the paper yet.
    const rawTotal = payload.total_amount === undefined
      ? existing?.total_amount ?? null : payload.total_amount;
    let total = null;
    if (rawTotal !== null && rawTotal !== undefined && rawTotal !== '') {
      total = round2(Number(rawTotal));
      if (!(total > 0)) throw new ValidationError('An invoice total must be greater than zero, or left empty');
    }

    // `undefined` means "the caller did not mention this field"; an explicit
    // `null` means "clear it". `??` cannot tell the two apart, and getting it
    // wrong would make an invoice number impossible to remove once typed.
    const given = (key) => (payload[key] === undefined ? (existing?.[key] ?? null) : payload[key]);

    return {
      title: title.slice(0, 200),
      supplier_id: Number(supplierId),
      invoice_no: given('invoice_no'),
      invoice_date: given('invoice_date'),
      total_amount: total,
      notes: given('notes'),
    };
  }

  /**
   * File one invoice, with its photographs, as one act.
   *
   * At least one photograph is required and that is deliberate: this page IS
   * the photographs. A row with a name, a supplier and no picture is not an
   * archived invoice, it is a note — and he would find it six months later with
   * nothing to read.
   *
   * `attach()` runs inside this transaction, so a picture that will not store
   * takes the record down with it rather than leaving a record nobody can read.
   * The same shape as `CostService.create` and
   * `PurchaseService.registerPayment`, deliberately: it is the same problem.
   */
  async create(payload = {}, context = {}) {
    const photos = (payload.photos || []).filter((photo) => photo?.dataUrl);
    if (!photos.length) {
      throw new ValidationError('Add at least one photograph of the invoice');
    }

    return transaction(async () => {
      const data = await this.#prepare(payload);
      const created = await this.invoices.create({
        ...data,
        created_by: context.actor?.id || null,
      });

      for (const photo of photos) {
        // Sequential on purpose: each decode is a megabyte of buffer and the
        // driver is a single connection. Ten pages at once would be ten
        // megabytes resident for no gain.
        // eslint-disable-next-line no-await-in-loop
        await attachmentService.attach('legacy_invoice', created.id, photo, context);
      }

      // Even with no payments yet: this is what writes `status`, so a record
      // filed with a total starts as `unpaid` and one without starts `unknown`,
      // by exactly the same rule that will apply to it forever after.
      await this.invoices.recompute(created.id);

      const row = await this.invoices.findDetailed(created.id);
      await this.audit.record({
        action: 'CREATE', module: 'legacy_invoices', entityType: 'legacy_invoice',
        entityId: created.id, entityLabel: this.#label(row),
        after: { ...row, photographs: photos.length },
        actor: context.actor, request: context.request,
      });
      return this.get(created.id);
    });
  }

  /**
   * Correcting the record — including typing the amount he could not read last
   * week, which is the common case and the reason a total was allowed to be
   * empty in the first place. The status follows immediately, because
   * `recompute()` derives it from the total and the payments together.
   */
  async update(id, payload = {}, context = {}) {
    return transaction(async () => {
      const before = await this.invoices.findDetailed(id);
      if (!before) throw new NotFoundError('Invoice record', id);
      const data = await this.#prepare(payload, { existing: before });
      await this.invoices.update(before.id, data);

      for (const photo of (payload.photos || []).filter((p) => p?.dataUrl)) {
        // eslint-disable-next-line no-await-in-loop
        await attachmentService.attach('legacy_invoice', before.id, photo, context);
      }

      await this.invoices.recompute(before.id);
      const after = await this.invoices.findDetailed(before.id);
      await this.audit.recordChange(context, {
        action: 'UPDATE', module: 'legacy_invoices', entityType: 'legacy_invoice',
        entityId: before.id, entityLabel: this.#label(after), before, after,
      });
      return this.get(before.id);
    });
  }

  /**
   * A record, gone — with every photograph on it and on its payments.
   *
   * Refused while money still stands against it. A record with recorded
   * payments is the shop's memory of what it paid and when; deleting it takes
   * that and the receipts with it in one silent step. Reverse the payments
   * first, deliberately, one at a time, each saying why — and then the record
   * can go.
   *
   * `owner_id` carries no foreign key (one attachments table cannot point at
   * four), so nothing cascades on its own and the bytes would sit in the shop's
   * backup forever. See the contract in AttachmentService.js.
   */
  async remove(id, context = {}) {
    return transaction(async () => {
      const before = await this.invoices.findDetailed(id);
      if (!before) throw new NotFoundError('Invoice record', id);
      if (await this.invoices.countRecordedPayments(before.id)) {
        throw new BusinessRuleError(
          'Money has been recorded against this invoice — reverse the payments first, then delete it',
        );
      }

      for (const paymentId of await this.invoices.paymentIds(before.id)) {
        // eslint-disable-next-line no-await-in-loop
        await attachmentService.detachAll('legacy_invoice_payment', paymentId, context);
      }
      await attachmentService.detachAll('legacy_invoice', before.id, context);
      // The photographs first, because `owner_id` has no foreign key to cascade
      // through; then the reversed payment rows, then the record itself.
      await this.invoices.deletePayments(before.id);
      await this.invoices.remove(before.id);

      await this.audit.record({
        action: 'DELETE', module: 'legacy_invoices', entityType: 'legacy_invoice',
        entityId: before.id, entityLabel: this.#label(before), before,
        actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  // --------------------------------------------------------------- payments

  /** Every payment on one record, with the receipt attached to each. */
  async payments(id) {
    const invoice = await this.get(id);
    const rows = await this.invoices.payments(invoice.id);
    const byPayment = await attachmentService.listMany(
      'legacy_invoice_payment', rows.map((row) => row.id),
    );
    return {
      rows: rows.map((row) => ({
        ...row,
        amount: round2(row.amount),
        attachments: byPayment[row.id] || [],
      })),
      invoice,
      paid_amount: invoice.paid_amount,
      total_amount: invoice.total_amount,
      outstanding: invoice.outstanding,
      over_paid: invoice.over_paid,
      status: invoice.status,
    };
  }

  /**
   * What he paid against this invoice, as a row.
   *
   * One atomic act with more than one thing in it: the payment, the record's
   * running total, its derived status, and — when he photographed the receipt —
   * the photograph. All inside one transaction, so a picture that will not
   * store takes the payment down with it rather than leaving a payment with no
   * proof.
   *
   * The total is NOT incremented here. `recompute()` asks the database to sum
   * the rows as they stand and write both the total and the status from that,
   * in one statement, so two payments recorded at the same moment cannot lose
   * each other: whichever commits second sums both, and the status it writes is
   * the status of the sum it just computed. Reading `paid_amount`, adding to it
   * and writing it back loses one of any two payments that overlap — see
   * `PurchaseService.registerPayment`, which learned that the hard way.
   *
   * There is no overpayment check, and that is the deliberate difference from
   * the purchase-order path. See the head of this file.
   */
  async registerPayment(id, payload = {}, context = {}) {
    const {
      amount, method = 'cash', reference = null, note = null, paidOn = null, photo = null,
    } = payload;

    return transaction(async () => {
      const invoice = await this.invoices.findDetailed(id);
      if (!invoice) throw new NotFoundError('Invoice record', id);

      const value = round2(Number(amount));
      if (!(value > 0)) throw new ValidationError('Payment amount must be greater than zero');

      const paymentId = await this.invoices.insertPayment(invoice.id, {
        paid_on: paidOn || today(),
        amount: value,
        method: String(method || 'cash'),
        reference,
        note,
        created_by: context.actor?.id || null,
      });

      if (photo?.dataUrl) {
        await attachmentService.attach('legacy_invoice_payment', paymentId, photo, context);
      }

      const state = await this.invoices.recompute(invoice.id);
      const payment = await this.invoices.findPayment(invoice.id, paymentId);

      await this.audit.record({
        action: 'PAYMENT', module: 'legacy_invoices', entityType: 'legacy_invoice_payment',
        entityId: paymentId, entityLabel: `${this.#label(invoice)} — ${value}`,
        before: { paid_amount: round2(invoice.paid_amount), status: invoice.status },
        after: { ...payment, ...state, has_photo: Boolean(photo?.dataUrl) },
        actor: context.actor, request: context.request,
      });

      return { ...(await this.get(invoice.id)), payment };
    });
  }

  /**
   * A payment that was wrong. Reversed, never deleted — see the head of this
   * file for why, and why the reasoning is not quite `PurchaseService`'s.
   *
   * The receipt stays attached to it: it is proof of what was recorded, and a
   * reversal does not make the photograph untrue. The running total and the
   * status both drop back on their own, because both are derived from the rows
   * that are still marked `recorded`.
   */
  async reversePayment(id, paymentId, reason, context = {}) {
    return transaction(async () => {
      const invoice = await this.invoices.findDetailed(id);
      if (!invoice) throw new NotFoundError('Invoice record', id);
      const payment = await this.invoices.findPayment(invoice.id, paymentId);
      if (!payment) throw new NotFoundError('Invoice payment', paymentId);
      if (payment.status === 'reversed') {
        throw new BusinessRuleError('This payment has already been reversed');
      }
      const text = String(reason || '').trim();
      if (!text) throw new ValidationError('Say why this payment is being reversed');

      await this.invoices.reversePayment(payment.id, { reason: text, actorId: context.actor?.id });
      const state = await this.invoices.recompute(invoice.id);

      await this.audit.record({
        action: 'REVERSE_PAYMENT', module: 'legacy_invoices',
        entityType: 'legacy_invoice_payment', entityId: payment.id,
        entityLabel: `${this.#label(invoice)} — ${payment.amount}`,
        before: { status: payment.status, paid_amount: round2(invoice.paid_amount), invoice_status: invoice.status },
        after: { status: 'reversed', reason: text, ...state },
        actor: context.actor, request: context.request,
      });
      return { ...(await this.get(invoice.id)), reversed: payment.id };
    });
  }

  #label(row) {
    if (!row) return 'invoice record';
    const number = row.invoice_no ? ` #${row.invoice_no}` : '';
    return `${row.title}${number} — ${row.supplier_name_en || row.supplier_id}`;
  }
}

export const legacyInvoiceService = new LegacyInvoiceService();
export default legacyInvoiceService;
