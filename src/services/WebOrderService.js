/**
 * Web orders — the bridge between the storefront and the till.
 *
 * A web order is not a sale, and the gap between the two is the whole point of
 * this file. When a customer taps "order" nothing has left the shop and no
 * money has changed hands: the goods are still on the shelf and the shop has
 * only a promise. So placing an order RESERVES stock — `stock_levels.
 * reserved_quantity` goes up, `quantity` does not move and no ledger row is
 * written — and staff confirm it in the ERP, which is the moment it becomes a
 * real sale through SalesService, exactly as if it had been rung up at the
 * counter.
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
 * payment credential. The sale created at confirmation is therefore recorded
 * UNPAID — the shop is genuinely owed that money until the box is handed over,
 * and staff collect it against the invoice with the till's existing payment
 * screen. The delivery fee lives on the order, not on the invoice: it is a
 * service the shop charges for, not stock leaving the shelf.
 */
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { calculateLine, round2, round3 } from '../shared/money.js';
import inventoryService from './InventoryService.js';
import salesService from './SalesService.js';
import { customerService } from './masterDataServices.js';
import auditService from './AuditService.js';

/** Basket limits. A shop basket is small; anything past this is not shopping. */
const MAX_LINES = 50;
const MAX_QTY_PER_LINE = 99;

const STATUSES = ['pending', 'confirmed', 'delivered', 'cancelled'];

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
             confirmed_at, created_at
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
      status: order.status,
      placed_at: order.created_at,
      confirmed_at: order.confirmed_at,
      cancelled_reason: order.cancelled_reason,
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

  async list({ status = '', page = 1, pageSize = 25 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (status && STATUSES.includes(status)) { where.push('o.status = ?'); params.push(status); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM web_orders o ${whereSql}`).get(...params)).n;
    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
    const current = Math.max(Number(page) || 1, 1);

    const rows = await this.db.prepare(`
      SELECT o.id, o.order_no, o.status, o.customer_name, o.customer_phone,
             o.address_city, o.total_amount, o.delivery_fee, o.language,
             o.sale_id, o.created_at, o.confirmed_at,
             s.invoice_no AS invoice_no,
             u.full_name  AS confirmed_by_name,
             (SELECT COUNT(*) FROM web_order_lines l WHERE l.order_id = o.id) AS line_count
      FROM web_orders o
      LEFT JOIN sales s ON s.id = o.sale_id
      LEFT JOIN users u ON u.id = o.confirmed_by
      ${whereSql}
      ORDER BY o.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

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
   * Confirm — the moment the promise becomes a sale.
   *
   * The reservation is released first and the goods are then ISSUED by
   * SalesService, so the stock movement, the moving-average cost, the customer
   * balance and the audit trail all behave exactly as they do for a counter
   * sale. Doing it any other way would mean a second, subtly different sales
   * path to keep correct forever.
   *
   * Prices come off the order, not the catalogue: the customer is owed the
   * price they were shown, even if it changed last night.
   */
  async confirm(id, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      if (order.status !== 'pending') {
        throw new BusinessRuleError(`This order is ${order.status} — only a pending order can be confirmed`);
      }
      if (!order.lines.length) throw new BusinessRuleError('This order has no items');

      const warehouseId = await this.inventory.locationId();

      // Release first: the sale is about to take the same units out of stock,
      // and a reservation still standing would make them look unavailable.
      await this.#releaseReservations(order, warehouseId);

      // Days may have passed. Check before selling so the message names the
      // item, rather than surfacing whichever line the ledger tripped on.
      for (const line of order.lines) {
        if (!(await this.#tracksInventory(line.variant_id))) continue;
        const level = await this.stock.ensureLevel(line.variant_id, warehouseId);
        const free = round3(Number(level.quantity) - Number(level.reserved_quantity));
        if (line.quantity > free) {
          throw new BusinessRuleError(
            `Not enough stock for ${line.sku} — ${line.description}: `
            + `${free} available, ${line.quantity} ordered. Cancel the order or restock first.`,
            { variant_id: line.variant_id, available: free, requested: line.quantity },
          );
        }
      }

      const sale = await this.sales.checkout({
        customer_id: order.customer_id,
        // Cash on delivery: the money is collected when the box is handed over,
        // so the invoice is raised unpaid and settled from the sales screen.
        payment_method: 'cash',
        paid_amount: 0,
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
           SET status = 'confirmed', sale_id = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ?
         WHERE id = ?
      `).run(sale.id, context.actor?.id || null, now, now, id);

      await this.audit.record({
        action: 'CONFIRM', module: 'weborders', entityType: 'web_order', entityId: id,
        entityLabel: order.order_no,
        before: { status: 'pending' },
        after: { status: 'confirmed', sale_id: sale.id, invoice_no: sale.invoice_no },
        actor: context.actor, request: context.request,
      });

      return {
        ...(await this.get(id)),
        message: `Invoice ${sale.invoice_no} created — unpaid until the delivery is collected.`,
      };
    });
  }

  /**
   * Cancel. Works from `pending` (nothing has happened yet) and from
   * `confirmed` (staff got as far as raising the invoice).
   *
   * A confirmed order has a real sale behind it, with stock issued and possibly
   * money taken. Voiding that automatically from here would reverse an invoice
   * on the strength of a courier's phone call, so it is NOT done: the message
   * says plainly what still has to happen at the till.
   */
  async cancel(id, reason, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      if (order.status === 'cancelled') throw new BusinessRuleError('This order is already cancelled');
      if (order.status === 'delivered') {
        throw new BusinessRuleError('This order was delivered — record a return instead of cancelling it');
      }

      const warehouseId = await this.inventory.locationId();
      const released = await this.#releaseReservations(order, warehouseId);

      const now = new Date().toISOString();
      await this.db.prepare(`
        UPDATE web_orders
           SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
         WHERE id = ?
      `).run(trim(reason, 300), now, id);

      await this.audit.record({
        action: 'CANCEL', module: 'weborders', entityType: 'web_order', entityId: id,
        entityLabel: order.order_no,
        before: { status: order.status },
        after: { status: 'cancelled', reason: trim(reason, 300), units_released: released },
        actor: context.actor, request: context.request,
      });

      const message = order.sale_id
        ? `Order cancelled. Invoice ${order.invoice_no} is still live — void it from the sales `
          + 'screen to put the stock back and reverse the money.'
        : 'Order cancelled and the reserved stock released.';
      return { ...(await this.get(id)), message };
    });
  }

  async markDelivered(id, context = {}) {
    return transaction(async () => {
      const order = await this.get(id);
      if (order.status !== 'confirmed') {
        throw new BusinessRuleError(
          `This order is ${order.status} — only a confirmed order can be marked delivered`,
        );
      }
      const now = new Date().toISOString();
      await this.db.prepare("UPDATE web_orders SET status = 'delivered', updated_at = ? WHERE id = ?")
        .run(now, id);

      await this.audit.record({
        action: 'DELIVER', module: 'weborders', entityType: 'web_order', entityId: id,
        entityLabel: order.order_no,
        before: { status: 'confirmed' }, after: { status: 'delivered' },
        actor: context.actor, request: context.request,
      });
      return this.get(id);
    });
  }

  // ----------------------------------------------------------------- helpers

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

  async #totals(lines) {
    const subtotal = round2(lines.reduce((s, l) => s + round2(l.quantity * l.unit_price), 0));
    const taxAmount = round2(lines.reduce((s, l) => s + l.tax_amount, 0));
    const goods = round2(subtotal + taxAmount);

    const fee = Number(await this.settings.get('shop.delivery_fee', 0)) || 0;
    const freeOver = Number(await this.settings.get('shop.free_delivery_over', 0)) || 0;
    // Measured against what the customer pays for the goods, tax included —
    // that is the number on the basket they were looking at when they decided
    // whether it was worth adding one more thing to earn free delivery.
    const deliveryFee = freeOver > 0 && goods >= freeOver ? 0 : round2(Math.max(fee, 0));

    return { subtotal, taxAmount, deliveryFee, totalAmount: round2(goods + deliveryFee) };
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
