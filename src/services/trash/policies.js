/**
 * WHAT MAY BE DELETED, AND WHAT DELETING IT COSTS.
 *
 * One file, because the answer to "can this be deleted" must be in one place.
 * Spread across fifteen services it becomes fifteen slightly different answers,
 * and the day two of them disagree the shop has a document that is gone from
 * one screen and present in another.
 *
 * ── The three kinds of thing in this shop ────────────────────────────────────
 *
 * 1. MASTER DATA — a product, a brand, a supplier, a customer. It describes the
 *    shop; it never moved money. Deleting one is safe to undo and safe to redo,
 *    so it goes to the bin whole: the row stays exactly where it is with every
 *    reference to it intact, and an `in_bin` register entry hides it. Restoring
 *    is removing that entry. Nothing about the shop's money moves in either
 *    direction.
 *
 *    The catch is REFERENCES. A product that has been sold cannot be destroyed —
 *    the invoice it sits on would lose its own history — so master data is
 *    deleted into the bin freely and PURGED only if nothing points at it on the
 *    day the thirty days are up. If something does, the entry stays in the bin
 *    and says so. That is not a failure; it is the register being honest that
 *    "delete" here means "hidden forever" rather than "destroyed".
 *
 * 2. DOCUMENTS THAT MOVED MONEY OR STOCK — a sale, a return, a purchase order,
 *    a stock adjustment, a cost. These cannot simply be hidden: an invoice that
 *    disappears from a list while its stock movement stays on the shelf is how a
 *    shop ends up with numbers nobody can trace.
 *
 *    So deleting one REVERSES it first, through the document's own service —
 *    a sale is voided, a return is reversed, a purchase order is cancelled —
 *    and the reversal is a real, audited, visible event. Only then is the
 *    document hidden.
 *
 *    ── And this is the part to be honest about ──
 *    RESTORING BRINGS THE RECORD BACK, NOT THE TRANSACTION. A deleted invoice
 *    comes back as a VOID invoice: its stock stays where the void put it and
 *    its money stays reversed. Restoring cannot un-refund a customer or
 *    un-issue stock that has been sold twice since. Anything else would be a
 *    button that quietly rewrites history, and there is no version of that
 *    which is safe.
 *
 * 3. THINGS THAT ARE NOT DELETABLE AT ALL — the shop's own location, the
 *    administrator account, a posted stock adjustment that other movements have
 *    been built on top of. They refuse, by name, with the reason.
 *
 * ── The shape of a policy ────────────────────────────────────────────────────
 *   entityType   the register's key for this kind of thing
 *   module       which permission and which screen it belongs to
 *   label(row)   what a person calls it
 *   detail(row)  the one line that identifies it in the bin — money, date, count
 *   load(id)     the row, or null
 *   check(row)   { ok, blockers[], warnings[] } — asked BEFORE anything happens
 *   remove(row)  performs the deletion, returns `effect` describing what moved
 *   restore(row) puts it back, or throws with the reason it cannot come back
 *   purge(row)   destroys it after thirty days, or explains why it cannot be
 */
import { getDb, transaction } from '../../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { round2 } from '../../shared/money.js';

const db = () => getDb();

/**
 * How many rows of a table point at this id — the dependency question, asked
 * once and asked correctly.
 *
 * `via: 'variants'` is the case that made this function grow a second half. A
 * product is never referenced directly by a sale line; the line points at a
 * VARIANT, and the variant points at the product. Counting
 * `sale_lines.variant_id = <product id>` compares two different kinds of number
 * and answers nonsense — usually zero, which is the dangerous direction: the
 * dialog says nothing depends on this, the purge goes ahead, and SQLite refuses
 * it with a bare FOREIGN KEY error that reaches the shop as "This record is
 * linked to other data". Which is exactly what the owner was shown.
 */
async function countRefs(table, column, id, via = null) {
  const sql = via === 'variants'
    ? `SELECT COUNT(*) AS n FROM ${table} t
         JOIN product_variants v ON v.id = t.${column}
        WHERE v.product_id = ?`
    : `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`;
  const row = await db().prepare(sql).get(id);
  return Number(row?.n || 0);
}

/**
 * A blocker is a sentence in both languages, because the person reading it is
 * standing at a till in Cairo and the person debugging it is not.
 */
const blocker = (code, en, ar) => ({ code, en, ar });

/* ------------------------------------------------------------- master data */

/**
 * The shared policy for everything that describes the shop rather than moves
 * its money. What differs per kind is only the table, the references to count
 * and what to call it.
 */
function masterData({
  entityType, module, table, labelOf, detailOf = () => null, references = [],
  beforeDestroy = null,
}) {
  return {
    entityType,
    module,
    kind: 'master',
    async load(id) {
      return db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    },
    label: labelOf,
    detail: detailOf,

    async check(row) {
      /*
       * References do NOT block the delete — they block the PURGE. A product
       * that has been sold can be taken off every screen; it cannot be
       * destroyed, because the invoices it sits on are the shop's own history.
       * The difference is stated here so the bin can say it out loud rather
       * than discovering it in thirty days' time.
       */
      const held = [];
      for (const ref of references) {
        // eslint-disable-next-line no-await-in-loop
        const n = await countRefs(ref.table, ref.column, row.id, ref.via);
        if (n > 0) held.push({ ...ref, count: n });
      }
      return {
        ok: true,
        blockers: [],
        warnings: held.length
          ? [blocker(
            'referenced',
            `Used by ${held.map((h) => `${h.count} ${h.en}`).join(', ')} — it will be hidden, and kept rather than destroyed.`,
            `مستخدم في ${held.map((h) => `${h.count} ${h.ar}`).join('، ')} — هيتخفي، وهيتحفظ مش هيتمسح نهائي.`,
          )]
          : [],
        references: held,
      };
    },

    /** Hidden, not touched: the register entry is what does the hiding. */
    async remove() {
      return { hidden: true };
    },

    async restore() {
      return { restored: true };
    },

    /**
     * The only step that destroys anything — and it asks the dependency
     * question AGAIN, on the day it runs. Thirty days is long enough for a
     * product nobody could sell on the day it was deleted to have been sold.
     */
    async purge(row) {
      for (const ref of references) {
        // eslint-disable-next-line no-await-in-loop
        const n = await countRefs(ref.table, ref.column, row.id, ref.via);
        if (n > 0) {
          throw new BusinessRuleError(
            `"${labelOf(row)}" is used by ${n} ${ref.en} and cannot be destroyed. It stays hidden.`,
          );
        }
      }
      /*
       * Its own trail goes with it.
       *
       * Everything above is somebody ELSE'S document pointing at this record,
       * and none of those may be touched. What is left belongs to the record
       * itself — a product's stock ledger, its levels, its variants, its
       * photographs — and has no meaning once it is gone. The schema cascades
       * most of it; `beforeDestroy` clears what it does not, IN ORDER, because
       * `PRAGMA foreign_keys` is on and a DELETE that trips it would surface as
       * a bare constraint error rather than as a sentence anybody can read.
       */
      if (beforeDestroy) await beforeDestroy(row);
      await db().prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
      return { destroyed: true };
    },
  };
}

/* ----------------------------------------------------------------- the map */

export function buildPolicies({ sales, returns, purchases, inventory, costs }) {
  const policies = new Map();
  const add = (policy) => policies.set(policy.entityType, policy);

  // ------------------------------------------------------------ master data
  /*
   * A product is referenced THROUGH its variants — every one of these tables
   * holds a `variant_id`, never a `product_id` — so each is counted with
   * `via: 'variants'`. All four are DOCUMENTS: an invoice, a refund, an order
   * to a supplier, a stock count. They are the shop's own history and none of
   * them may lose the thing it points at, which is why they block destruction
   * rather than deletion: the product comes off every screen immediately and
   * simply stays hidden.
   */
  add(masterData({
    entityType: 'product',
    module: 'products',
    table: 'products',
    labelOf: (row) => row.name_en || row.name_ar || `#${row.id}`,
    detailOf: (row) => row.sku_prefix || null,
    references: [
      { table: 'sale_lines', column: 'variant_id', en: 'sale line(s)', ar: 'سطر بيع', via: 'variants' },
      {
        table: 'sales_return_lines', column: 'variant_id', en: 'return line(s)', ar: 'سطر مرتجع', via: 'variants',
      },
      {
        table: 'purchase_order_lines', column: 'variant_id', en: 'purchase line(s)', ar: 'سطر شراء', via: 'variants',
      },
      {
        table: 'stock_adjustment_lines', column: 'variant_id', en: 'stock count line(s)', ar: 'سطر جرد', via: 'variants',
      },
    ],
    /*
     * What is left once no document points at it is the product's own trail:
     * the movements that put stock on its shelf and took it off again. Those
     * are about this product and nothing else, and they are the one table on
     * the list that the schema does not cascade — `stock_movements` keeps a
     * plain reference so a movement can never lose its variant by accident.
     * Cleared here, deliberately and last, so the DELETE below can succeed.
     * Variants, stock levels, images, declared attributes and their values all
     * cascade from the product row itself.
     */
    async beforeDestroy(row) {
      await db().prepare(`
        DELETE FROM stock_movements
         WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)
      `).run(row.id);
    },
  }));

  add(masterData({
    entityType: 'brand',
    module: 'brands',
    table: 'brands',
    labelOf: (row) => row.name_ar || row.name_en,
    references: [{ table: 'products', column: 'brand_id', en: 'product(s)', ar: 'منتج' }],
  }));

  add(masterData({
    entityType: 'category',
    module: 'categories',
    table: 'categories',
    labelOf: (row) => row.name_ar || row.name_en,
    references: [
      { table: 'products', column: 'category_id', en: 'product(s)', ar: 'منتج' },
      { table: 'categories', column: 'parent_id', en: 'sub-category(ies)', ar: 'قسم فرعي' },
    ],
  }));

  add(masterData({
    entityType: 'supplier',
    module: 'suppliers',
    table: 'suppliers',
    labelOf: (row) => row.name_ar || row.name_en,
    references: [
      { table: 'purchase_orders', column: 'supplier_id', en: 'purchase order(s)', ar: 'أمر شراء' },
      { table: 'products', column: 'supplier_id', en: 'product(s)', ar: 'منتج' },
    ],
  }));

  add(masterData({
    entityType: 'customer',
    module: 'customers',
    table: 'customers',
    labelOf: (row) => row.name || row.phone || `#${row.id}`,
    detailOf: (row) => row.phone || null,
    references: [
      { table: 'sales', column: 'customer_id', en: 'invoice(s)', ar: 'فاتورة' },
      { table: 'web_orders', column: 'customer_id', en: 'online order(s)', ar: 'طلب أونلاين' },
    ],
  }));

  add(masterData({
    entityType: 'employee',
    module: 'employees',
    table: 'employees',
    // `name`, not `full_name` — that is `users`. An employee in the bin was
    // showing as "#12" because of it.
    labelOf: (row) => row.name || `#${row.id}`,
    detailOf: (row) => row.job_title || null,
    references: [{ table: 'costs', column: 'employee_id', en: 'salary payment(s)', ar: 'صرف مرتب' }],
  }));

  add(masterData({
    entityType: 'promotion',
    module: 'promotions',
    table: 'promotions',
    labelOf: (row) => row.name_ar || row.name_en || row.code,
    detailOf: (row) => row.code || null,
    references: [{ table: 'promotion_redemptions', column: 'promotion_id', en: 'redemption(s)', ar: 'استخدام' }],
  }));

  // --------------------------------------------------------------- documents

  /**
   * An invoice.
   *
   * Deleting one VOIDS it: the pieces go back on the shelf, a promotion
   * redemption is reversed, the customer's balance and points are put back.
   * All of that is `SalesService.void`, which the shop has always had and which
   * is audited; nothing about the money is invented here.
   *
   * It refuses while a return stands against it, because the return took some
   * of those pieces back already and voiding the invoice would count them
   * twice. Reverse the return first — which the bin can also do, and says so.
   */
  add({
    entityType: 'sale',
    module: 'sales',
    kind: 'document',
    async load(id) { return sales.sales.findAggregate(id); },
    label: (row) => row.invoice_no,
    detail: (row) => `${round2(row.total_amount)} · ${String(row.sale_date || '').slice(0, 10)}`,

    async check(row) {
      const blockers = [];
      if (row.status === 'void') {
        // Nothing left to reverse: it is already neutral, so deleting it is
        // only a matter of taking it off the screen.
        return { ok: true, blockers: [], warnings: [], alreadyNeutral: true };
      }
      /*
       * Only returns that still STAND block the invoice. One the bin already
       * undid put its pieces back where it found them and stopped being a
       * refund; holding the invoice hostage to it would mean a mistake made
       * once could never be cleared up.
       */
      const live = (row.returns || []).filter((r) => r.status !== 'reversed');
      if (live.length) {
        blockers.push(blocker(
          'has_returns',
          `This invoice has ${live.length} return(s) against it. Delete those first — the pieces they took back would otherwise be counted twice.`,
          `الفاتورة دي عليها ${live.length} مرتجع. امسحهم الأول — القطع اللي رجعت هتتحسب مرتين غير كده.`,
        ));
      }
      return {
        ok: !blockers.length,
        blockers,
        warnings: [blocker(
          'will_reverse',
          `Deleting this puts ${row.lines?.length || 0} line(s) of stock back and reverses the money against it. Restoring later brings the invoice back as VOID — it does not un-do the reversal.`,
          `المسح هيرجّع ${row.lines?.length || 0} سطر بضاعة للرف ويعكس فلوسها. لو رجّعتها بعدين هترجع «ملغاة» — مش هترجع الفلوس زي ما كانت.`,
        )],
      };
    },

    async remove(row, context) {
      if (row.status === 'void') return { alreadyVoid: true };
      await sales.void(row.id, context.reason || 'Deleted to the recycle bin', context);
      return {
        voided: true,
        stockReturned: (row.lines || []).reduce((n, line) => n + Number(line.quantity || 0), 0),
        moneyReversed: round2(row.total_amount),
      };
    },

    async restore() {
      // The register un-hides it. It comes back void, which is what it is.
      return { restored: true, state: 'void' };
    },

    async purge() {
      /*
       * Never destroyed. An invoice number is a promise to somebody outside
       * this shop — a customer holding a receipt, a tax inspector reading a
       * sequence — and a hole in that sequence is worse than a void row in it.
       */
      throw new BusinessRuleError(
        'An invoice is never destroyed. It stays void and hidden, and its number stays in the sequence.',
      );
    },
  });

  /**
   * A return.
   *
   * The one document in this shop that had no way back at all: money went out
   * of the till, pieces went on or off the shelf, and nothing could undo either.
   * `ReturnService.reverse` is what makes it deletable, and it is the exact
   * mirror of what the return did.
   */
  add({
    entityType: 'sales_return',
    module: 'sales',
    kind: 'document',
    async load(id) { return returns.get(id); },
    label: (row) => row.return_no,
    detail: (row) => `${round2(row.total_amount)} · ${String(row.return_date || '').slice(0, 10)}`,

    async check(row) {
      const blockers = [];

      /*
       * Half of an exchange is not a document anybody may delete on its own.
       *
       * Deleting this return would un-do the credit — but the replacement was
       * already handed over and its invoice would still stand, paid for by
       * credit that no longer exists. The refusal names the exchange so the
       * person can go and look at what they are actually trying to undo.
       */
      const exchange = await db().prepare(
        'SELECT exchange_no, new_invoice_no FROM exchanges WHERE return_id = ?',
      ).get(row.id);
      if (exchange) {
        blockers.push(blocker(
          'part_of_exchange',
          `This return is half of exchange ${exchange.exchange_no} — the customer already took ${exchange.new_invoice_no} away. Undo it by returning that invoice instead.`,
          `المرتجع ده نص عملية استبدال ${exchange.exchange_no} — العميل خد ${exchange.new_invoice_no} وراح. لو عايز تلغيها ارجّع الفاتورة الجديدة نفسها.`,
        ));
      }

      if (row.store_credit_code) {
        const voucher = await db().prepare(
          "SELECT id, is_active FROM promotions WHERE code = ? AND kind = 'voucher'",
        ).get(row.store_credit_code);
        const used = voucher
          ? await countRefs('promotion_redemptions', 'promotion_id', voucher.id) : 0;
        if (used > 0) {
          blockers.push(blocker(
            'credit_spent',
            `The store credit issued for this return (${row.store_credit_code}) has already been spent. Reversing it would take back money the customer no longer has.`,
            `رصيد المحل اللي اتعمل للمرتجع ده (${row.store_credit_code}) اتصرف خلاص. إلغاؤه معناه إنك بتسحب فلوس العميل مابقاش معاه.`,
          ));
        }
      }
      return {
        ok: !blockers.length,
        blockers,
        warnings: [blocker(
          'will_reverse',
          'Deleting this takes the refund back out, puts restocked pieces back off the shelf, and re-opens the invoice it was taken against.',
          'المسح هيسحب المبلغ المسترد تاني، ويشيل القطع اللي رجعت للرف، ويفتح الفاتورة اللي كانت مربوطة بيه.',
        )],
      };
    },

    async remove(row, context) {
      const effect = await returns.reverse(row.id, context.reason || 'Deleted to the recycle bin', context);
      return { reversed: true, ...effect };
    },

    async restore() {
      throw new BusinessRuleError(
        'A reversed return cannot be restored — the refund has already been taken back. '
        + 'Record the return again if the customer brought the piece back.',
      );
    },

    async purge() {
      throw new BusinessRuleError('A return document is never destroyed; its number stays in the sequence.');
    },
  });

  /**
   * A purchase order. Cancelable while nothing has been received; once goods
   * are in, the stock and the supplier's money are real and the order is part
   * of what explains them.
   */
  add({
    entityType: 'purchase_order',
    module: 'purchases',
    kind: 'document',
    async load(id) { return purchases.orders.findAggregate(id); },
    label: (row) => row.po_number,
    detail: (row) => `${round2(row.total_amount)} · ${String(row.order_date || '').slice(0, 10)}`,

    async check(row) {
      const blockers = [];
      const received = (row.lines || []).reduce((n, l) => n + Number(l.quantity_received || 0), 0);
      if (received > 0) {
        blockers.push(blocker(
          'goods_received',
          `${received} piece(s) have already been received against this order. Return them to the supplier instead — the stock is real.`,
          `فيه ${received} قطعة اتستلمت على الأمر ده. رجّعها للمورد بدل ما تمسحه — البضاعة دي موجودة فعلاً.`,
        ));
      }
      if (Number(row.paid_amount || 0) > 0) {
        blockers.push(blocker(
          'already_paid',
          `${round2(row.paid_amount)} has been paid against this order. Reverse the payment first.`,
          `اتدفع ${round2(row.paid_amount)} على الأمر ده. اعكس الدفعة الأول.`,
        ));
      }
      return { ok: !blockers.length, blockers, warnings: [] };
    },

    async remove(row, context) {
      if (row.status !== 'cancelled') {
        await purchases.cancel(row.id, context.reason || 'Deleted to the recycle bin', context);
      }
      return { cancelled: true };
    },

    async restore() { return { restored: true, state: 'cancelled' }; },

    async purge() {
      throw new BusinessRuleError('A purchase order is never destroyed; its number stays in the sequence.');
    },
  });

  /**
   * A stock adjustment — including a wastage document.
   *
   * A DRAFT is nothing but an intention and is destroyed freely. A POSTED one
   * moved stock, so deleting it posts the opposite movement: the pieces come
   * back, and the wastage figure it fed drops by exactly what it added.
   */
  add({
    entityType: 'stock_adjustment',
    module: 'inventory',
    kind: 'document',
    async load(id) { return inventory.getAdjustment(id); },
    label: (row) => row.adjustment_no,
    detail: (row) => `${row.reason} · ${(row.lines || []).length} line(s)`,

    async check(row) {
      if (row.status === 'draft') {
        return { ok: true, blockers: [], warnings: [], alreadyNeutral: true };
      }
      return {
        ok: true,
        blockers: [],
        warnings: [blocker(
          'will_reverse',
          'Deleting this posts the opposite movement: the stock goes back where it was, and any wastage it counted comes off the figure.',
          'المسح هيسجّل حركة عكسية: البضاعة هترجع مكانها، وأي هدر اتحسب منها هينزل من الرقم.',
        )],
      };
    },

    async remove(row, context) {
      if (row.status !== 'posted') return { wasDraft: true };
      const moved = await inventory.reverseAdjustment(row.id, context.reason || 'Deleted to the recycle bin', context);
      return { reversed: true, ...moved };
    },

    async restore() { return { restored: true, state: 'reversed' }; },

    async purge(row) {
      // A draft never moved anything; there is nothing to keep.
      if (row.status === 'draft') {
        await db().prepare('DELETE FROM stock_adjustment_lines WHERE adjustment_id = ?').run(row.id);
        await db().prepare('DELETE FROM stock_adjustments WHERE id = ?').run(row.id);
        return { destroyed: true };
      }
      throw new BusinessRuleError('A posted stock document is never destroyed; it explains a movement.');
    },
  });

  /**
   * A cost entry — rent, electricity, a salary payment. Money that left the
   * till. Deleting one is deleting the record of a payment, so it is destroyed
   * rather than neutralised: there is no stock and no counterparty inside this
   * system, and a cost that is hidden but present would still be in the ledger
   * it is supposed to have left.
   */
  add({
    entityType: 'cost',
    module: 'costs',
    kind: 'ledger',
    async load(id) { return db().prepare('SELECT * FROM costs WHERE id = ?').get(id); },
    label: (row) => row.description || `#${row.id}`,
    detail: (row) => `${round2(row.amount)} · ${String(row.spent_on || '').slice(0, 10)}`,

    async check(row) {
      return {
        ok: true,
        blockers: [],
        warnings: [blocker(
          'affects_profit',
          `${round2(row.amount)} comes back out of this month's costs, and the profit for that month goes up by the same amount.`,
          `${round2(row.amount)} هتخرج من تكاليف الشهر ده، وربح الشهر هيزيد بنفس المبلغ.`,
        )],
      };
    },

    async remove() { return { hidden: true, affectsProfit: true }; },
    async restore() { return { restored: true }; },
    async purge(row) {
      await db().prepare('DELETE FROM costs WHERE id = ?').run(row.id);
      return { destroyed: true };
    },
  });

  return policies;
}

export { blocker, countRefs, transaction, NotFoundError };
