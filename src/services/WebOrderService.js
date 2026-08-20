/**
 * Web orders — the bridge between the storefront and the till.
 *
 * A web order is not a sale, and the gap between the two is the whole point of
 * this file. When a customer taps "order" nothing has left the shop and no
 * money has changed hands: the goods are still on the shelf and the shop has
 * only a promise. So placing an order RESERVES stock — `stock_levels.
 * reserved_quantity` goes up, `quantity` does not move and no ledger row is
 * written.
 *
 * That reservation survives the whole journey, because with cash on delivery
 * nothing is sold until the courier hands the box over and takes the money:
 *
 *   pending → accepted → out_for_delivery → delivered
 *
 * `delivered` is the only step that touches the ledger. There the reservation
 * is released, the goods are ISSUED through SalesService exactly as if they had
 * been rung up at the counter, and the invoice is raised PAID because the cash
 * came back with the courier. Everything before it is a promise; `accepted` and
 * `out_for_delivery` move nothing at all.
 *
 * The two unhappy endings — `not_received` (the courier came back with the box)
 * and `cancelled` — release the reservation and stop. No sale was ever created,
 * so there is nothing to reverse.
 *
 * SECURITY: `place()` and `track()` answer UNAUTHENTICATED requests. Anyone on
 * the internet can call them, so:
 *
 *  - Every price is looked up here. The browser sends a variant id and a
 *    quantity and nothing else is believed — a cart is user input, and a client
 *    that could name its own price would be a free shop.
 *  - Every variant is checked against the same visibility rule the storefront
 *    uses. Ids are sequential, so without that check next season's range is one
 *    incrementing counter away from orderable the day it is entered.
 *  - Quantities are clamped, and lines are merged and capped, so one request
 *    cannot reserve the shop's entire stock.
 *  - Nothing thrown at the public ever quotes a stock figure. "Only 2 left"
 *    tells a competitor exactly what the shop is holding; naming the item does
 *    the customer's job without it.
 *
 * Payment is cash on delivery. There is no gateway and nothing here touches a
 * payment credential. The delivery fee lives on the order, not on the invoice:
 * it is a service the shop charges for, not stock leaving the shelf.
 */
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction } from '../infrastructure/database/connection.js';
import {
  likeParam, lineExact, lineMatch, matchReasonColumns, normaliseTerm, rankExpression,
  worthLineSearch,
} from '../infrastructure/database/productSearch.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { calculateLine, round2, round3 } from '../shared/money.js';
import { deliveryFor } from '../shared/delivery.js';
import inventoryService from './InventoryService.js';
import salesService from './SalesService.js';
import { customerService } from './masterDataServices.js';
import auditService from './AuditService.js';

/** Basket limits. A shop basket is small; anything past this is not shopping. */
const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 99;

const STATUSES = [
  'pending', 'accepted', 'out_for_delivery', 'delivered', 'not_received', 'cancelled',
];

/**
 * The only moves an order may make. Written once, here, so the service, the
 * screen and the error messages can never drift apart — and so that adding a
 * step is one line rather than an archaeology exercise across four methods.
 */
const TRANSITIONS = {
  pending: ['accepted', 'cancelled'],
  accepted: ['out_for_delivery', 'not_received', 'cancelled'],
  out_for_delivery: ['delivered', 'not_received', 'cancelled'],
  delivered: [],
  not_received: [],
  cancelled: [],
};

/** Plain English for a status, for messages staff read rather than parse. */
const SPOKEN = {
  pending: 'new',
  accepted: 'accepted',
  out_for_delivery: 'out for delivery',
  delivered: 'delivered',
  not_received: 'not received',
  cancelled: 'cancelled',
};

/**
 * What the public may order, written once so no query can forget half of it —
 * the product is live AND published, its brand and its category (where set) are
 * published too, and the variant itself is active. This is the storefront's
 * visibility rule; the two are deliberately identical, because anything the
 * shop will not show must also be something it will not sell.
 *
 * Written against the aliases `p` (products) and `v` (product_variants).
 */
const ORDERABLE_VARIANT = `
  v.is_active = 1
  AND p.is_active = 1
  AND p.is_published = 1
  AND (p.brand_id IS NULL OR EXISTS (
        SELECT 1 FROM brands bg WHERE bg.id = p.brand_id AND bg.is_published = 1))
  AND (p.category_id IS NULL OR EXISTS (
        SELECT 1 FROM categories cg WHERE cg.id = p.category_id AND cg.is_published = 1))
`;

const trim = (value, max) => String(value ?? '').trim().slice(0, max) || null;

export class WebOrderService {
  constructor(deps = {}) {
    this.customers = deps.customers || repositories.customers;
    this.sequences = deps.sequences || repositories.sequences;
    this.settings = deps.settings || repositories.settings;
    this.stock = deps.stock || repositories.inventory;
    this.inventory = deps.inventory || inventoryService;
    this.sales = deps.sales || salesService;
    this.audit = deps.audit || auditService;
  }

  get db() {
    return getDb();
  }

  // ------------------------------------------------------------------ public

  /**
   * Place an order. Reserves stock; sells nothing.
   * @param {object} payload validated by `webOrderSchema`
   * @param {object} request { ip, userAgent } — for the audit trail
   */
  async place(payload, request = {}) {
    if (!(await this.settings.get('shop.enabled', true))) {
      throw new BusinessRuleError('The online shop is closed at the moment. Please try again later.');
    }

    const basket = this.#normaliseBasket(payload.lines);
    if (!basket.length) throw new ValidationError('Your basket is empty');

    return transaction(async () => {
      const warehouseId = await this.inventory.locationId();

      // --- price every line from the database, then reserve it
      const lines = [];
      for (const item of basket) {
        const variant = await this.#orderableVariant(item.variant_id);
        // Not "this product is hidden": whether the id exists at all is not the
        // internet's business, so an unpublished product answers exactly as a
        // deleted one does.
        if (!variant) throw new NotFoundError('Item', item.variant_id);

        const description = [variant.product_name_en, variant.variant_label]
          .filter(Boolean).join(' — ');
        const computed = calculateLine({
          quantity: item.quantity,
          unitPrice: round2(variant.selling_price),
          taxRate: variant.tax_rate,
        });

        // A product that is not stock-tracked (a service, a made-to-order item)
        // has nothing to hold, so it reserves nothing and can never be short.
        let reserved = 0;
        if (variant.track_inventory) {
          const level = await this.stock.ensureLevel(variant.variant_id, warehouseId);
          const free = round3(Number(level.quantity) - Number(level.reserved_quantity));
          if (item.quantity > free) {
            throw new BusinessRuleError(
              `Sorry — "${description}" is no longer available in the quantity you asked for. `
              + 'Please change the amount and try again.',
              { variant_id: variant.variant_id },
            );
          }
          await this.stock.adjustReserved(variant.variant_id, warehouseId, item.quantity);
          reserved = item.quantity;
        }

        lines.push({
          variant_id: variant.variant_id,
          sku: variant.sku,
          description,
          quantity: item.quantity,
          unit_price: round2(variant.selling_price),
          tax_rate: Number(variant.tax_rate || 0),
          tax_amount: computed.taxAmount,
          line_total: computed.lineTotal,
          reserved,
        });
      }

      const totals = await this.#totals(lines);
      const customer = await this.#findOrCreateCustomer(payload.customer);
      const orderNo = await this.sequences.next('web_order');

      const info = await this.db.prepare(`
        INSERT INTO web_orders
          (order_no, customer_id, customer_name, customer_phone, customer_email,
           address_line, address_area, address_city, address_notes,
           status, payment_method, subtotal, tax_amount, delivery_fee, total_amount,
           language, customer_note, placed_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'cash_on_delivery', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNo, customer.id,
        trim(payload.customer.name, 120), trim(payload.customer.phone, 20),
        trim(payload.customer.email, 160),
        trim(payload.address.line, 300), trim(payload.address.area, 120),
        trim(payload.address.city, 120), trim(payload.address.notes, 300),
        totals.subtotal, totals.taxAmount, totals.deliveryFee, totals.totalAmount,
        payload.language === 'ar' ? 'ar' : 'en',
        trim(payload.note, 500), request.ip || null,
      );
      const orderId = Number(info.lastInsertRowid);

      const insertLine = this.db.prepare(`
        INSERT INTO web_order_lines
          (order_id, variant_id, sku, description, quantity, unit_price, tax_rate,
           tax_amount, line_total, reserved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of lines) {
        await insertLine.run(orderId, line.variant_id, line.sku, line.description,
          line.quantity, line.unit_price, line.tax_rate, line.tax_amount,
          line.line_total, line.reserved);
      }

      // Actor is null on purpose: nobody signed in placed this.
      await this.audit.record({
        action: 'CREATE', module: 'weborders', entityType: 'web_order', entityId: orderId,
        entityLabel: orderNo,
        after: {
          order_no: orderNo, items: lines.length, total: totals.totalAmount,
          customer: customer.id, phone: trim(payload.customer.phone, 20),
        },
        message: 'Web order placed — stock reserved, nothing sold',
        request,
      });

      return {
        order_no: orderNo,
        status: 'pending',
        subtotal: totals.subtotal,
        tax_amount: totals.taxAmount,
        delivery_fee: totals.deliveryFee,
        total_amount: totals.totalAmount,
      };
    });
  }

  /**
   * Track an order from the storefront.
   *
   * The order number alone is not enough: the phone number used to place it
   * must match, or a stranger walking `WEB-2026-00001`, `-00002`, … would read
   * the shop's customers, their addresses and what they bought. A mismatch is
   * the same 404 as a number that does not exist, so guessing reveals nothing —
   * not even whether the order is real.
   */
  async track(orderNo, phone) {
    const number = String(orderNo || '').trim().toUpperCase();
    const caller = String(phone || '').trim();
    if (!number || !caller) throw new NotFoundError('Order', orderNo || null);

    const order = await this.db.prepare(`
      SELECT id, order_no, status, customer_phone, customer_name,
             address_line, address_area, address_city,
             subtotal, tax_amount, delivery_fee, total_amount,
             payment_method, language, customer_note, cancelled_reason,
             not_received_reason, confirmed_at, dispatched_at, delivered_at, created_at
      FROM web_orders WHERE UPPER(order_no) = ?
    `).get(number);
    if (!order || String(order.customer_phone).trim() !== caller) {
      throw new NotFoundError('Order', orderNo);
    }

    const lines = await this.db.prepare(`
      SELECT sku, description, quantity, unit_price, tax_amount, line_total
      FROM web_order_lines WHERE order_id = ? ORDER BY id
    `).all(order.id);

    // Neither the internal id nor the linked invoice leaves this method.
    return {
      order_no: order.order_no,
      // The status, and the moment each step happened, so the storefront can
      // draw a progress line instead of printing a database word at a customer.
      status: order.status,
      placed_at: order.created_at,
      accepted_at: order.confirmed_at,
      dispatched_at: order.dispatched_at,
      delivered_at: order.delivered_at,
      // Why it ended badly, if it did. Staff wrote these for the customer.
      cancelled_reason: order.cancelled_reason,
      not_received_reason: order.not_received_reason,
      payment_method: order.payment_method,
      language: order.language,
      customer_name: order.customer_name,
      address: {
        line: order.address_line,
        area: order.address_area,
        city: order.address_city,
      },
      note: order.customer_note,
      lines,
      subtotal: order.subtotal,
      tax_amount: order.tax_amount,
      delivery_fee: order.delivery_fee,
      total_amount: order.total_amount,
    };
  }

  // ------------------------------------------------------------------- staff

  /**
   * The staff list.
   *
   * `search` follows the same rule as every other document screen: the order's
   * own identity (its number, the customer who placed it) OR the products it is
   * for. `web_orders` is one of the two tables that predate `BaseRepository`
   * here, so the predicate is assembled from the same shared parts by hand
   * rather than being re-invented — `search_match` on each row still says which
   * half answered.
   */
  async list({ search = '', status = '', page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    const term = normaliseTerm(search);
    const scope = { alias: 'o', table: 'web_order_lines', key: 'order_id' };
    const ownColumns = ['o.order_no', 'o.customer_name', 'o.customer_phone'];
    const documentSql = `(${ownColumns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    const documentParams = ownColumns.map(() => likeParam(term));

    let reason = null;
    let rank = null;
    if (term) {
      const lines = worthLineSearch(term) ? lineMatch(term, scope) : null;
      where.push(lines ? `(${documentSql} OR ${lines.sql})` : documentSql);
      params.push(...documentParams, ...(lines ? lines.params : []));
      reason = matchReasonColumns(term, {
        ...scope, documentSql, documentParams, scoped: Boolean(lines),
      });
      const exact = worthLineSearch(term) ? lineExact(term, scope) : null;
      rank = rankExpression({
        sql: `(o.order_no = ? COLLATE NOCASE${exact ? ` OR ${exact.sql}` : ''})`,
        params: [term, ...(exact ? exact.params : [])],
      });
    }
    if (status && STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM web_orders o ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
    const current = Math.max(Number(page) || 1, 1);

    const rows = await this.db.prepare(`
      SELECT o.id, o.order_no, o.status, o.customer_name, o.customer_phone,
             o.address_city, o.total_amount, o.delivery_fee, o.language,
             o.sale_id, o.created_at, o.confirmed_at, o.dispatched_at, o.delivered_at,
             s.invoice_no AS invoice_no,
             u.full_name  AS confirmed_by_name,
             (SELECT COUNT(*) FROM web_order_lines l WHERE l.order_id = o.id) AS line_count
             ${reason ? `, ${reason.sql}` : ''}
      FROM web_orders o
      LEFT JOIN sales s ON s.id = o.sale_id
      LEFT JOIN users u ON u.id = o.confirmed_by
      ${whereSql}
      ORDER BY ${rank ? `${rank.sql}, ` : ''}o.id DESC LIMIT ? OFFSET ?
    `).all(...(reason ? reason.params : []), ...params, ...(rank ? rank.params : []),
      size, (current - 1) * size);

    return {
      rows,
      total,
      page: current,
      pageSize: size,
      pages: Math.ceil(total / size) || 1,
      counts: await this.statusCounts(),
    };
  }

  async get(id) {
    const order = await this.db.prepare(`
      SELECT o.*, s.invoice_no AS invoice_no, s.status AS sale_status,
             u.full_name AS confirmed_by_name
      FROM web_orders o
      LEFT JOIN sales s ON s.id = o.sale_id
      LEFT JOIN users u ON u.id = o.confirmed_by
      WHERE o.id = ?
    `).get(id);
    if (!order) throw new NotFoundError('Web order', id);
    order.lines = await this.db.prepare(`
      SELECT l.*, vd.product_name_en, vd.product_name_ar, vd.variant_label
      FROM web_order_lines l
      LEFT JOIN v_variant_details vd ON vd.variant_id = l.variant_id
      WHERE l.order_id = ? ORDER BY l.id
    `).all(id);
    return order;
  }

  async statusCounts() {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS n FROM web_orders GROUP BY status').all();
    return Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n || 0]));
  }

  /** The nav badge: how many orders are waiting for somebody to look at them. */
  async pendingCount() {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM web_orders WHERE status = 'pending'").get();
    return row ? row.n : 0;
  }

  /**
   * Accept — staff have looked at the order and the shop will fulfil it.
   *
   * Nothing moves. The goods stay reserved, no invoice is raised and no money
   * is expected: accepting is a promise, and a promise is not a sale.
   */
  async accept(id, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      this.#requireTransition(order, 'accepted');
      if (!order.lines.length) throw new BusinessRuleError('This order has no items');

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders
           SET status = 'accepted', confirmed_by = ?, confirmed_at = ?, updated_at = ?
         WHERE id = ?
      `).run(context.actor?.id || null, now, now, id);

      await this.#log('ACCEPT', order, { status: 'accepted' }, context);
      return {
        ...(await this.get(id)),
        message: 'Order accepted. The stock stays held — nothing is sold until it is delivered.',
      };
    });
  }

  /** Hand it to the courier. Still nothing sold, still nothing collected. */
  async dispatch(id, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      this.#requireTransition(order, 'out_for_delivery');

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders SET status = 'out_for_delivery', dispatched_at = ?, updated_at = ?
         WHERE id = ?
      `).run(now, now, id);

      await this.#log('DISPATCH', order, { status: 'out_for_delivery' }, context);
      return { ...(await this.get(id)), message: 'Order is out for delivery.' };
    });
  }

  /**
   * Deliver — the one step that moves goods and money.
   *
   * The box is in the customer's hands and the cash is in the courier's, so
   * this is where the promise finally becomes a sale: the reservation is
   * released and the same units are ISSUED by SalesService, which means the
   * stock movement, the moving-average cost, the customer balance and the audit
   * trail behave exactly as they do for a sale at the counter. Doing it any
   * other way would mean a second, subtly different sales path to keep correct
   * forever.
   *
   * The invoice is raised PAID: cash on delivery means the money came back with
   * the courier, and an invoice the shop is not owed must not sit in the ledger
   * pretending otherwise.
   *
   * Prices come off the order, not the catalogue: the customer is owed the
   * price they were shown, even if it changed last night.
   */
  async deliver(id, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      this.#requireTransition(order, 'delivered');
      if (!order.lines.length) throw new BusinessRuleError('This order has no items');

      const warehouseId = await this.inventory.locationId();

      // Release first: the sale is about to take the same units out of stock,
      // and a reservation still standing would make them look unavailable.
      await this.#releaseReservations(order, warehouseId);

      // Days may have passed since it was reserved, and a stocktake or a
      // counter sale can have eaten into it. Check before selling so the
      // message names the item, rather than surfacing whichever line the
      // ledger happened to trip on.
      for (const line of order.lines) {
        if (!(await this.#tracksInventory(line.variant_id))) continue;
        const level = await this.stock.ensureLevel(line.variant_id, warehouseId);
        const free = round3(Number(level.quantity) - Number(level.reserved_quantity));
        if (line.quantity > free) {
          throw new BusinessRuleError(
            `Not enough stock for ${line.sku} — ${line.description}: `
            + `${free} available, ${line.quantity} delivered. Restock before recording `
            + 'this delivery, or record it as not received.',
            { variant_id: line.variant_id, available: free, requested: line.quantity },
          );
        }
      }

      // An order confirmed under the old lifecycle already has its invoice, and
      // billing that customer twice would be worse than any tidiness gained.
      const sale = order.sale_id
        ? { id: order.sale_id, invoice_no: order.invoice_no }
        : await this.sales.checkout({
          customer_id: order.customer_id,
          // Cash on delivery: the courier collected it, so the invoice is
          // settled in cash here and now. `paid_amount` is left out on purpose
          // — SalesService then pays the invoice in full, whatever it totals.
          payment_method: 'cash',
          notes: `Web order ${order.order_no}`,
          lines: order.lines.map((line) => ({
            variant_id: line.variant_id,
            quantity: line.quantity,
            unit_price: line.unit_price,
          })),
        }, context);

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders
           SET status = 'delivered', sale_id = ?, delivered_at = ?, updated_at = ?
         WHERE id = ?
      `).run(sale.id, now, now, id);

      await this.#log('DELIVER', order,
        { status: 'delivered', sale_id: sale.id, invoice_no: sale.invoice_no }, context);

      return {
        ...(await this.get(id)),
        message: `Delivered. Invoice ${sale.invoice_no} created and paid in cash.`,
      };
    });
  }

  /**
   * Not received — the courier went and came back with the box.
   *
   * Nothing was sold, so there is nothing to reverse: the reservation is given
   * back and the goods are on the shelf again, sellable by the till the moment
   * this returns.
   */
  async markNotReceived(id, reason, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      this.#requireTransition(order, 'not_received');

      const warehouseId = await this.inventory.locationId();
      const released = await this.#releaseReservations(order, warehouseId);

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders
           SET status = 'not_received', not_received_reason = ?, updated_at = ?
         WHERE id = ?
      `).run(trim(reason, 300), now, id);

      await this.#log('NOT_RECEIVED', order,
        { status: 'not_received', reason: trim(reason, 300), units_released: released }, context);

      return {
        ...(await this.get(id)),
        message: 'Recorded as not received. The held stock is back on the shelf and nothing was sold.',
      };
    });
  }

  /**
   * Cancel. Legal any time before the box is handed over.
   *
   * Under this lifecycle no sale exists until delivery, so cancelling releases
   * the reservation and stops — there is no invoice to void. The exception is
   * an order confirmed under the OLD rules, which raised its invoice early: its
   * `sale_id` survived the migration, and voiding a real invoice on the
   * strength of a courier's phone call is not something this method will do by
   * itself. It says plainly what still has to happen at the till.
   */
  async cancel(id, reason, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      this.#requireTransition(order, 'cancelled');

      const warehouseId = await this.inventory.locationId();
      const released = await this.#releaseReservations(order, warehouseId);

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders
           SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
         WHERE id = ?
      `).run(trim(reason, 300), now, id);

      await this.#log('CANCEL', order,
        { status: 'cancelled', reason: trim(reason, 300), units_released: released }, context);

      const message = order.sale_id
        ? `Order cancelled. Invoice ${order.invoice_no} is still live — void it from the sales `
          + 'screen to put the stock back and reverse the money.'
        : 'Order cancelled and the reserved stock released.';
      return { ...(await this.get(id)), message };
    });
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Refuse an illegal move, and say what would have been legal instead.
   *
   * "This order is delivered" on its own sends staff to look for a bug; naming
   * the steps that ARE open from here answers the question they were about to
   * ask. An end state says so, rather than listing nothing.
   */
  #requireTransition(order, next) {
    const allowed = TRANSITIONS[order.status] || [];
    if (allowed.includes(next)) return;
    const from = SPOKEN[order.status] || order.status;
    const to = SPOKEN[next] || next;
    throw new BusinessRuleError(
      allowed.length
        ? `This order is ${from} — it cannot be marked ${to}. `
          + `From here it can only be marked: ${allowed.map((s) => SPOKEN[s] || s).join(', ')}.`
        : `This order is ${from}, which is where it ends — it cannot be marked ${to}.`,
      { order_no: order.order_no, status: order.status, attempted: next, allowed },
    );
  }

  /** One audit row per lifecycle move, in the shape the trail already uses. */
  #log(action, order, after, context) {
    return this.audit.record({
      action,
      module: 'weborders',
      entityType: 'web_order',
      entityId: order.id,
      entityLabel: order.order_no,
      before: { status: order.status },
      after,
      actor: context.actor,
      request: context.request,
    });
  }

  /**
   * Turn whatever arrived into a basket the shop can price.
   *
   * Duplicate variants are merged rather than kept apart, because otherwise the
   * per-line cap is not a cap: fifty lines of the same item would reserve 4,950
   * units of it. Merging first means the clamp applies to what the customer
   * actually gets.
   */
  #normaliseBasket(lines) {
    const merged = new Map();
    for (const line of lines || []) {
      const variantId = Number(line?.variant_id);
      if (!Number.isInteger(variantId) || variantId <= 0) continue;
      const quantity = Math.floor(Number(line?.quantity));
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      merged.set(variantId, (merged.get(variantId) || 0) + quantity);
      if (merged.size > MAX_LINES) throw new ValidationError(`An order can hold at most ${MAX_LINES} items`);
    }
    return [...merged.entries()].map(([variant_id, quantity]) => ({
      variant_id,
      quantity: Math.min(Math.max(quantity, 1), MAX_QTY_PER_LINE),
    }));
  }

  /**
   * The one thing the public may look up. Named columns only — `cost_price` and
   * `wholesale_price` sit in the same row and must never be one `SELECT *` away
   * from a public response.
   */
  async #orderableVariant(variantId) {
    return (await this.db.prepare(`
      SELECT v.id            AS variant_id,
             v.sku           AS sku,
             v.variant_label AS variant_label,
             v.selling_price AS selling_price,
             p.id            AS product_id,
             p.name_en       AS product_name_en,
             p.tax_rate      AS tax_rate,
             p.track_inventory AS track_inventory
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.id = ? AND ${ORDERABLE_VARIANT}
    `).get(variantId)) || null;
  }

  async #tracksInventory(variantId) {
    const row = await this.db.prepare(`
      SELECT p.track_inventory AS track_inventory
      FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ?
    `).get(variantId);
    return Boolean(row?.track_inventory);
  }

  /**
   * The only place a web order is priced. Every line was already looked up
   * from the database in `place()`, so the client's own numbers never reach
   * here — a client that posts its own delivery figure is simply not asked.
   *
   * Delivery itself is `deliveryFor()`, the one rule shared with the ERP
   * preview and mirrored (line for line, see that file) in the storefront
   * basket — this is the server side of that contract, and the only side that
   * actually charges anything.
   */
  async #totals(lines) {
    const subtotal = round2(lines.reduce((s, l) => s + round2(l.quantity * l.unit_price), 0));
    const taxAmount = round2(lines.reduce((s, l) => s + l.tax_amount, 0));
    // Measured against what the customer pays for the goods, tax included —
    // that is the number on the basket they were looking at when they decided
    // whether it was worth adding one more thing to earn free delivery.
    const goods = round2(subtotal + taxAmount);

    const deliveryFee = deliveryFor(goods, await this.#deliverySettings());

    return { subtotal, taxAmount, deliveryFee, totalAmount: round2(goods + deliveryFee) };
  }

  /**
   * `deliveryFor()`'s settings shape, read from the `shop.*` rows. 0 means
   * "not set" for min/max/freeOver everywhere this system stores them, so it
   * is translated to null here rather than asking the pure function to know
   * that convention.
   */
  async #deliverySettings() {
    const mode = await this.settings.get('shop.delivery_mode', 'flat');
    const fee = Number(await this.settings.get('shop.delivery_fee', 0)) || 0;
    const percent = Number(await this.settings.get('shop.delivery_percent', 0)) || 0;
    const min = Number(await this.settings.get('shop.delivery_min', 0)) || 0;
    const max = Number(await this.settings.get('shop.delivery_max', 0)) || 0;
    const freeOver = Number(await this.settings.get('shop.free_delivery_over', 0)) || 0;
    return {
      mode,
      fee,
      percent,
      min: min > 0 ? min : null,
      max: max > 0 ? max : null,
      freeOver: freeOver > 0 ? freeOver : null,
    };
  }

  /**
   * Give back exactly what this order took, and record that it did.
   *
   * `reserved` is per line and zeroed in the same statement, so a reservation
   * cannot be released twice and cannot be forgotten — the row itself is the
   * record of what is still being held.
   */
  async #releaseReservations(order, warehouseId) {
    let released = 0;
    for (const line of order.lines) {
      const held = Number(line.reserved || 0);
      if (held <= 0) continue;
      await this.stock.adjustReserved(line.variant_id, warehouseId, -held);
      await this.db.prepare('UPDATE web_order_lines SET reserved = 0 WHERE id = ?').run(line.id);
      line.reserved = 0;
      released = round3(released + held);
    }
    return released;
  }

  /**
   * One customer record per phone number.
   *
   * The name on an existing record is never overwritten. Anyone can type
   * anything into a public form, and a stranger who happens to know a phone
   * number must not be able to rename a real customer in the shop's book — the
   * name they typed is kept on the order itself, where it belongs.
   */
  async #findOrCreateCustomer(input) {
    const phone = trim(input.phone, 20);
    const existing = phone ? await this.customers.findBy('phone', phone) : null;
    if (existing) {
      // Fill a blank only — never replace something a member of staff entered.
      const email = trim(input.email, 160);
      if (email && !existing.email) await this.customers.update(existing.id, { email });
      return existing;
    }
    return this.customers.create({
      code: await customerService.generateCode(),
      name: trim(input.name, 120) || phone,
      phone,
      email: trim(input.email, 160),
      customer_group: 'retail',
      notes: 'Created from a web order',
    });
  }
}

export const webOrderService = new WebOrderService();
export default webOrderService;
