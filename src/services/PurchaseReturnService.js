/**
 * Goods going back to the supplier — and, when he sends the same thing again,
 * the replacement that comes back in.
 *
 * ── Why this is a document and not an edit ──────────────────────────────────
 * The tempting implementation is to reduce `quantity_received` on the order and
 * knock the money off its total. It is wrong for the same reason a sales return
 * does not edit the invoice: the order records an agreement and what arrived
 * under it, and a shop reconciling a supplier's statement in December has to
 * find the September order reading the way it read in September. Editing it
 * also destroys the only evidence the goods were ever received — which is
 * precisely the evidence a dispute with a supplier turns on.
 *
 * ── What the shop owes, after ───────────────────────────────────────────────
 * Derived, never stored:
 *
 *     outstanding = total_amount − returned − paid
 *
 * When the shop has already paid in full and then sends goods back, that figure
 * goes NEGATIVE, and negative is the right answer: the supplier owes money now.
 * The screens say it in those words rather than showing a minus sign and hoping.
 *
 * ── What may not be sent back ───────────────────────────────────────────────
 * Three refusals, and each is a different sentence because they are different
 * problems and lead to different actions:
 *
 *   · more than the order ever received (`pr_too_many`) — names how many are
 *     actually left after earlier returns;
 *   · more than is on the shelf (`pr_not_in_stock`) — this is the "I already
 *     sold them" and "they went out as wastage" case. The pieces are gone; the
 *     shop cannot hand them to anybody. It names what IS there;
 *   · anything at all against an order that never received stock, or was
 *     cancelled (`pr_nothing_received`, `pr_order_cancelled`).
 *
 * The second one deserves its own note, because the stock ledger would have
 * caught it anyway with "insufficient stock". That message is true and useless:
 * it tells a person holding a faulty bottle that a number is too small. The
 * refusal here says how many of that item are actually on the shelf, which is
 * the fact they need to go and count.
 *
 * ── The money on a line ─────────────────────────────────────────────────────
 * What the shop actually PAID for that piece: the unit cost, less the line's
 * own discount, plus its tax, less its share of any discount the supplier gave
 * on the order as a whole. Shipping is not refunded — the lorry came.
 */
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2, round3 } from '../shared/money.js';
import inventoryService from './InventoryService.js';
import auditService from './AuditService.js';

export class PurchaseReturnService {
  constructor(deps = {}) {
    this.orders = deps.orders || repositories.purchaseOrders;
    this.suppliers = deps.suppliers || repositories.suppliers;
    this.variants = deps.variants || repositories.variants;
    this.sequences = deps.sequences || repositories.sequences;
    this.inventory = deps.inventory || inventoryService;
    this.audit = deps.audit || auditService;
  }

  get db() { return getDb(); }

  /**
   * How much of each received line is still returnable, and what one piece of
   * it cost — the numbers the return screen is built from.
   */
  async returnable(orderId) {
    const order = await this.orders.findAggregate(orderId);
    if (!order) throw new NotFoundError('Purchase order', orderId);

    const done = await this.db.prepare(`
      SELECT l.po_line_id, COALESCE(SUM(l.quantity), 0) AS returned
        FROM purchase_return_lines l
        JOIN purchase_returns r ON r.id = l.return_id AND r.status = 'completed'
       WHERE r.purchase_order_id = ?
       GROUP BY l.po_line_id
    `).all(orderId);
    const returnedBy = new Map(done.map((row) => [row.po_line_id, Number(row.returned || 0)]));

    const lines = [];
    for (const line of order.lines) {
      const returned = returnedBy.get(line.id) || 0;
      const level = await repositories.inventory.getLevel(line.variant_id, order.warehouse_id);
      lines.push({
        ...line,
        returned_quantity: round3(returned),
        returnable_quantity: round3(Math.max(0, Number(line.quantity_received || 0) - returned)),
        // What is actually on the shelf right now. A line can be returnable on
        // paper and impossible in fact, because it was sold.
        on_hand: round3(Number(level?.quantity || 0)),
        unit_credit: this.#unitCredit(order, line),
      });
    }
    return { order, lines };
  }

  /**
   * What one piece of this line is worth back, to the piastre.
   *
   * The line's own discount and tax, then its share of whatever the supplier
   * took off the order as a whole — a 500 discount on a 12,000 order is 4.17%
   * off every line, and crediting the full cost of a returned bottle would hand
   * the shop money it never paid.
   */
  #unitCredit(order, line) {
    const gross = Number(line.unit_cost || 0);
    const net = gross - gross * (Number(line.discount_percent || 0) / 100);
    const withTax = net + net * (Number(line.tax_rate || 0) / 100);
    const subtotal = Number(order.subtotal || 0);
    const headerDiscount = Number(order.discount_amount || 0);
    const share = subtotal > 0 ? headerDiscount / subtotal : 0;
    return round3(withTax - net * share);
  }

  async list(query = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (query.purchaseOrderId) { where.push('r.purchase_order_id = ?'); params.push(Number(query.purchaseOrderId)); }
    if (query.supplierId) { where.push('r.supplier_id = ?'); params.push(Number(query.supplierId)); }
    if (query.dateFrom) { where.push('date(r.return_date) >= date(?)'); params.push(query.dateFrom); }
    if (query.dateTo) { where.push('date(r.return_date) <= date(?)'); params.push(query.dateTo); }
    const rows = await this.db.prepare(`
      SELECT r.*, s.name_en AS supplier_name_en, s.name_ar AS supplier_name_ar,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM purchase_return_lines l WHERE l.return_id = r.id) AS line_count
        FROM purchase_returns r
        JOIN suppliers s ON s.id = r.supplier_id
        LEFT JOIN users u ON u.id = r.created_by
       WHERE ${where.join(' AND ')}
       ORDER BY r.id DESC
    `).all(...params);
    return { rows };
  }

  async get(id) {
    const row = await this.db.prepare(`
      SELECT r.*, s.name_en AS supplier_name_en, s.name_ar AS supplier_name_ar,
             u.full_name AS created_by_name
        FROM purchase_returns r
        JOIN suppliers s ON s.id = r.supplier_id
        LEFT JOIN users u ON u.id = r.created_by
       WHERE r.id = ?
    `).get(Number(id));
    if (!row) throw new NotFoundError('Purchase return', id);
    const lines = await this.db
      .prepare('SELECT * FROM purchase_return_lines WHERE return_id = ? ORDER BY id')
      .all(Number(id));
    return { ...row, lines };
  }

  /**
   * What this order still owes, after everything that has gone back.
   *
   * Negative means the supplier owes the shop. That happens the moment goods go
   * back on an order that was already paid in full, which is the single most
   * common shape of this whole feature and the one the owner asked for by name.
   */
  async balance(orderId) {
    const row = await this.db.prepare(`
      SELECT po.total_amount, po.paid_amount,
             COALESCE((SELECT SUM(total_amount) FROM purchase_returns
                        WHERE purchase_order_id = po.id AND status = 'completed'), 0) AS returned
        FROM purchase_orders po WHERE po.id = ?
    `).get(Number(orderId));
    if (!row) throw new NotFoundError('Purchase order', orderId);
    const net = round2(Number(row.total_amount) - Number(row.returned));
    const outstanding = round2(net - Number(row.paid_amount));
    return {
      total_amount: round2(Number(row.total_amount)),
      returned_amount: round2(Number(row.returned)),
      net_amount: net,
      paid_amount: round2(Number(row.paid_amount)),
      outstanding,
      // Said in words rather than left as a sign for a screen to interpret.
      owed_by_supplier: outstanding < -0.009 ? round2(-outstanding) : 0,
    };
  }

  async create(payload, context = {}) {
    return transaction(async () => {
      const order = await this.orders.findAggregate(Number(payload.purchase_order_id));
      if (!order) throw new NotFoundError('Purchase order', payload.purchase_order_id);

      if (order.status === 'cancelled') {
        throw new BusinessRuleError(
          'This purchase order was cancelled — there is nothing to send back',
          { rule: 'pr_order_cancelled', po: order.po_number },
        );
      }
      if (!order.lines.some((line) => Number(line.quantity_received) > 0)) {
        throw new BusinessRuleError(
          'Nothing has been received on this purchase order yet',
          { rule: 'pr_nothing_received', po: order.po_number },
        );
      }

      const asked = (payload.lines || []).filter((line) => Number(line.quantity) > 0);
      if (!asked.length) {
        throw new ValidationError('Select at least one item to send back', { rule: 'pr_nothing_picked' });
      }

      const settlement = payload.settlement || 'credit';
      const { lines: state } = await this.returnable(order.id);

      const prepared = [];
      let subtotal = 0;
      let taxTotal = 0;
      let replacementValue = 0;

      for (const wanted of asked) {
        const line = state.find((l) => l.id === Number(wanted.po_line_id));
        if (!line) throw new NotFoundError('Purchase order line', wanted.po_line_id);

        const quantity = round3(Number(wanted.quantity));
        if (quantity > line.returnable_quantity + 0.0001) {
          throw new BusinessRuleError(
            `Only ${line.returnable_quantity} of ${line.sku} can still go back`,
            {
              rule: 'pr_too_many',
              sku: line.sku,
              asked: quantity,
              left: line.returnable_quantity,
              received: line.quantity_received,
            },
          );
        }

        /*
         * The pieces have to actually be here. Sold, scrapped as wastage, moved
         * elsewhere — whatever happened to them, they cannot be handed to a
         * supplier's driver, and the stock ledger would refuse this a moment
         * later with a message about a number being too small.
         */
        if (quantity > line.on_hand + 0.0001) {
          throw new BusinessRuleError(
            `${line.sku}: only ${line.on_hand} on the shelf — the rest have been sold or written off`,
            {
              rule: 'pr_not_in_stock', sku: line.sku, asked: quantity, available: line.on_hand,
            },
          );
        }

        const replacement = round3(Number(wanted.replacement_quantity || 0));

        /*
         * WHAT is coming back. Empty means the same item, which is the common
         * case and every replacement recorded before this existed. A different
         * variant is the case the owner asked for: a supplier who cannot
         * replace a faulty bottle sends another product against the same
         * credit.
         */
        let swapVariant = null;
        if (wanted.replacement_variant_id
            && Number(wanted.replacement_variant_id) !== line.variant_id) {
          swapVariant = await this.variants.findById(Number(wanted.replacement_variant_id));
          if (!swapVariant) throw new NotFoundError('Variant', wanted.replacement_variant_id);
          if (!swapVariant.is_active) {
            throw new BusinessRuleError(
              `${swapVariant.sku} is switched off — a supplier cannot deliver against it`,
              { rule: 'pr_replacement_inactive', sku: swapVariant.sku },
            );
          }
          if (replacement <= 0) {
            throw new ValidationError(
              'A different item was chosen but no quantity of it',
              { rule: 'pr_replacement_no_quantity', sku: swapVariant.sku },
            );
          }
        }
        /*
         * Its own cost, not the returned line's. Swapping a 300 bottle for a
         * 450 one leaves 150 owing, and valuing both at 300 would quietly lose
         * the shop money on every uneven swap. What the caller states wins,
         * because the supplier's paperwork decides it; the variant's own cost
         * is the fallback.
         */
        const swapCost = swapVariant
          ? round2(wanted.replacement_unit_cost !== undefined && wanted.replacement_unit_cost !== null
            ? Number(wanted.replacement_unit_cost)
            : Number(swapVariant.cost_price || 0))
          : 0;
        if (replacement > 0 && settlement !== 'replace') {
          throw new ValidationError(
            'A replacement quantity only means something on a replacement',
            { rule: 'pr_replacement_not_asked', sku: line.sku },
          );
        }
        if (replacement > quantity + 0.0001) {
          throw new BusinessRuleError(
            `${line.sku}: ${replacement} coming back for ${quantity} sent — a replacement cannot exceed what went out`,
            {
              rule: 'pr_replacement_too_many', sku: line.sku, sent: quantity, back: replacement,
            },
          );
        }

        const unit = line.unit_credit;
        const lineTotal = round2(unit * quantity);
        subtotal += round2((unit / (1 + Number(line.tax_rate || 0) / 100)) * quantity);
        taxTotal += round2(lineTotal - (unit / (1 + Number(line.tax_rate || 0) / 100)) * quantity);
        replacementValue += round2((swapVariant ? swapCost : unit) * replacement);

        prepared.push({
          po_line_id: line.id,
          variant_id: line.variant_id,
          sku: line.sku,
          description: line.product_name_en || line.sku,
          quantity,
          unit_cost: unit,
          line_total: lineTotal,
          replacement_quantity: replacement,
          replacement_variant_id: swapVariant ? swapVariant.id : null,
          replacement_unit_cost: swapVariant ? swapCost : 0,
          replacement_sku: swapVariant ? swapVariant.sku : null,
          reason: wanted.reason || payload.reason || null,
        });
      }

      if (settlement === 'replace' && !prepared.some((line) => line.replacement_quantity > 0)) {
        throw new ValidationError(
          'A replacement needs at least one item coming back',
          { rule: 'pr_replacement_empty' },
        );
      }

      const total = round2(prepared.reduce((sum, line) => sum + line.line_total, 0));
      const returnNo = await this.sequences.next('purchase_return');

      const created = await this.db.prepare(`
        INSERT INTO purchase_returns
          (return_no, purchase_order_id, po_number, supplier_id, warehouse_id, return_date,
           settlement, status, reason, subtotal, tax_amount, total_amount, replacement_amount,
           notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `).get(
        returnNo, order.id, order.po_number, order.supplier_id, order.warehouse_id,
        payload.return_date || new Date().toISOString().slice(0, 10),
        settlement, payload.reason || null,
        round2(subtotal), round2(taxTotal), total, round2(replacementValue),
        payload.notes || null, context.actor?.id || null,
      );

      for (const line of prepared) {
        await this.db.prepare(`
          INSERT INTO purchase_return_lines
            (return_id, po_line_id, variant_id, sku, description, quantity, unit_cost,
             line_total, replacement_quantity, replacement_variant_id, replacement_unit_cost, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          created.id, line.po_line_id, line.variant_id, line.sku, line.description,
          line.quantity, line.unit_cost, line.line_total, line.replacement_quantity,
          line.replacement_variant_id, line.replacement_unit_cost,
          line.reason,
        );

        // Out. One at a time — postMovement reads the balance it just wrote.
        await this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: order.warehouse_id,
          movementType: 'purchase_return',
          quantity: -line.quantity,
          unitCost: line.unit_cost,
          referenceType: 'purchase_return',
          referenceId: created.id,
          referenceNo: returnNo,
          notes: line.reason,
          actorId: context.actor?.id || null,
        });

        /*
         * And back in, on a replacement, at the same cost the shop paid — the
         * supplier is making good, not selling it again. Same transaction: a
         * replacement whose inbound half fails must not leave the shop having
         * handed the goods over for nothing.
         */
        if (line.replacement_quantity > 0) {
          await this.inventory.postMovement({
            // The item the supplier actually sent, which is not always the one
            // that went back.
            variantId: line.replacement_variant_id || line.variant_id,
            warehouseId: order.warehouse_id,
            movementType: 'purchase_receipt',
            quantity: line.replacement_quantity,
            unitCost: line.replacement_variant_id ? line.replacement_unit_cost : line.unit_cost,
            referenceType: 'purchase_return',
            referenceId: created.id,
            referenceNo: returnNo,
            notes: line.replacement_variant_id ? `replacement — ${line.replacement_sku}` : 'replacement',
            actorId: context.actor?.id || null,
          });
        }
      }

      await this.audit.record({
        action: 'CREATE',
        module: 'purchases',
        entityType: 'purchase_return',
        entityId: created.id,
        entityLabel: returnNo,
        after: { ...created, lines: prepared.length },
        actor: context.actor,
        request: context.request,
      });

      return { ...created, lines: prepared, balance: await this.balance(order.id) };
    });
  }

  /**
   * A return recorded in error.
   *
   * Reversed, never deleted: the stock movements it wrote are facts about the
   * shelf, and a row that disappears takes their explanation with it. The
   * reversal puts the goods back exactly as they were, including undoing a
   * replacement's inbound half — otherwise reversing a replacement would leave
   * the shop holding both.
   */
  async reverse(id, reason, context = {}) {
    return transaction(async () => {
      const record = await this.get(id);
      if (record.status === 'reversed') {
        throw new BusinessRuleError(
          'This return has already been reversed',
          { rule: 'pr_already_reversed', returnNo: record.return_no },
        );
      }

      for (const line of record.lines) {
        if (Number(line.replacement_quantity) > 0) {
          await this.inventory.postMovement({
            // Whatever actually came in is what has to go back out again.
            variantId: line.replacement_variant_id || line.variant_id,
            warehouseId: record.warehouse_id,
            movementType: 'purchase_return',
            quantity: -Number(line.replacement_quantity),
            unitCost: line.replacement_variant_id ? line.replacement_unit_cost : line.unit_cost,
            referenceType: 'purchase_return_reversal',
            referenceId: record.id,
            referenceNo: record.return_no,
            notes: reason || 'reversal',
            actorId: context.actor?.id || null,
          });
        }
        await this.inventory.postMovement({
          variantId: line.variant_id,
          warehouseId: record.warehouse_id,
          movementType: 'purchase_receipt',
          quantity: Number(line.quantity),
          unitCost: line.unit_cost,
          referenceType: 'purchase_return_reversal',
          referenceId: record.id,
          referenceNo: record.return_no,
          notes: reason || 'reversal',
          actorId: context.actor?.id || null,
        });
      }

      await this.db.prepare(`
        UPDATE purchase_returns
           SET status = 'reversed', reversed_at = ?, reversed_by = ?, reversal_reason = ?
         WHERE id = ?
      `).run(new Date().toISOString(), context.actor?.id || null, reason || null, record.id);

      await this.audit.record({
        action: 'REVERSE',
        module: 'purchases',
        entityType: 'purchase_return',
        entityId: record.id,
        entityLabel: record.return_no,
        before: { status: 'completed' },
        after: { status: 'reversed', reason },
        actor: context.actor,
        request: context.request,
      });

      return this.get(record.id);
    });
  }
}

export default new PurchaseReturnService();
