/**
 * Online payment through Fawaterak — the first crack in "payment is cash on
 * delivery" since this ERP existed. `002-web-orders` and `004-order-lifecycle`
 * both said so in their own header comments, on purpose, because it was true:
 * no gateway, no card data, nothing here touched a payment credential. The
 * owner asked to add one, choosable at checkout alongside cash on delivery,
 * off until he turns it on — so it stays true for every shop that never
 * touches the new setting, and stops being true only where he explicitly asks.
 *
 * Two independent things land here:
 *
 * 1. Settings, group 'payments' — same `INSERT OR IGNORE` pattern as every
 *    other settings migration (005, 006, …): a fresh install and a shop that
 *    has been running for a year both end up with every key present, and this
 *    can never clobber a key an owner already filled in.
 *
 *      payments.fawaterak_enabled     '0'    boolean  — the dashboard switch
 *      payments.fawaterak_api_key     ''     string   — Bearer token for the
 *                                                        Fawaterak API
 *      payments.fawaterak_vendor_key  ''     string   — HMAC secret for
 *                                                        verifying their webhook
 *      payments.fawaterak_mode        'live' string   — 'live' or 'staging',
 *                                                        which base URL to call
 *
 *    Both keys are read only by `FawaterakService` and only sent to Fawaterak
 *    itself or hashed locally — never to the storefront's public config (see
 *    `StorefrontService#config`, which exposes the enabled flag and nothing
 *    else) and never logged.
 *
 * 2. `web_orders` grows a real payment side, next to the fulfilment `status`
 *    it already had:
 *
 *      payment_method now allows 'fawaterak' alongside 'cash_on_delivery'
 *      payment_status   'not_required' | 'pending' | 'paid' | 'failed'
 *      payment_invoice_id   Fawaterak's invoiceId for this order, once created
 *      payment_invoice_key  Fawaterak's invoiceKey — half of the webhook's
 *                            HMAC input, together with invoice_id
 *      payment_reference    their referenceNumber, once paid — for support
 *                            conversations, never shown to a stranger
 *
 *    A cash-on-delivery order is `payment_method = 'cash_on_delivery'`,
 *    `payment_status = 'not_required'`, exactly as if these columns did not
 *    exist — nothing about the existing lifecycle (reserve → accept →
 *    dispatch → deliver, cash raised as a paid invoice at the end) changes for
 *    it. An online order reserves stock the same way at `place()`, but its
 *    invoice is raised — and the reservation released — only once Fawaterak's
 *    webhook says the money actually arrived; see WebOrderService for both
 *    halves.
 *
 * SQLite cannot widen a CHECK constraint in place, so `web_orders` is rebuilt
 * exactly the way `004-order-lifecycle` rebuilt it last time this table's
 * CHECK changed — including the same trap: `web_order_lines.order_id
 * REFERENCES web_orders(id) ON DELETE CASCADE`, so the child is rebuilt first
 * and the old parent is dropped only once it is childless, or the drop would
 * take every order line with it.
 */

const ORDER_COLUMNS = `
  id, order_no, customer_id, customer_name, customer_phone, customer_email,
  address_line, address_area, address_city, address_notes,
  status, payment_method, subtotal, tax_amount, delivery_fee, total_amount,
  language, customer_note, staff_note, sale_id, confirmed_by, confirmed_at,
  dispatched_at, delivered_at, cancelled_reason, not_received_reason,
  placed_ip, created_at, updated_at
`;

const LINE_COLUMNS = `
  id, order_id, variant_id, sku, description, quantity, unit_price,
  tax_rate, tax_amount, line_total, reserved
`;

const SETTINGS = [
  ['payments.fawaterak_enabled', '0', 'boolean'],
  ['payments.fawaterak_api_key', '', 'string'],
  ['payments.fawaterak_vendor_key', '', 'string'],
  ['payments.fawaterak_mode', 'live', 'string'],
];

export default {
  name: '033-fawaterak-payments',

  async up({ ddl, getDb, hasTable, hasColumn }) {
    const insertSetting = getDb().prepare(`
      INSERT OR IGNORE INTO settings (key, value, value_type, group_name)
      VALUES (?, ?, ?, 'payments')
    `);
    for (const [key, value, type] of SETTINGS) {
      await insertSetting.run(key, value, type);
    }

    // A database restored from an old backup, or one this already ran on, can
    // be in any state — look at the shape itself rather than trust the registry.
    if (!(await hasTable('web_orders'))) return;
    if (await hasColumn('web_orders', 'payment_status')) return;

    await ddl(`
      CREATE TABLE web_orders_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no         TEXT    NOT NULL UNIQUE,
        customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        customer_name    TEXT    NOT NULL,
        customer_phone   TEXT    NOT NULL,
        customer_email   TEXT,
        address_line     TEXT    NOT NULL,
        address_area     TEXT,
        address_city     TEXT    NOT NULL,
        address_notes    TEXT,
        status           TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','accepted','out_for_delivery',
                                             'delivered','not_received','cancelled')),
        payment_method   TEXT    NOT NULL DEFAULT 'cash_on_delivery'
                           CHECK (payment_method IN ('cash_on_delivery','fawaterak')),
        -- Independent of 'status' on purpose: a cash order is never anything
        -- but 'not_required', and an online order's money can arrive (or fail
        -- to) while the order itself is still sitting at 'pending'.
        payment_status   TEXT    NOT NULL DEFAULT 'not_required'
                           CHECK (payment_status IN ('not_required','pending','paid','failed')),
        payment_invoice_id  TEXT,
        payment_invoice_key TEXT,
        payment_reference   TEXT,
        subtotal         REAL    NOT NULL DEFAULT 0,
        tax_amount       REAL    NOT NULL DEFAULT 0,
        delivery_fee     REAL    NOT NULL DEFAULT 0,
        total_amount     REAL    NOT NULL DEFAULT 0,
        language         TEXT    NOT NULL DEFAULT 'ar' CHECK (language IN ('en','ar')),
        customer_note    TEXT,
        staff_note       TEXT,
        sale_id          INTEGER REFERENCES sales(id) ON DELETE SET NULL,
        confirmed_by     INTEGER REFERENCES users(id),
        confirmed_at     TEXT,
        dispatched_at    TEXT,
        delivered_at     TEXT,
        cancelled_reason TEXT,
        not_received_reason TEXT,
        placed_ip        TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    await ddl(`
      INSERT INTO web_orders_new (${ORDER_COLUMNS})
      SELECT ${ORDER_COLUMNS} FROM web_orders
    `);

    await ddl(`
      CREATE TABLE web_order_lines_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id      INTEGER NOT NULL REFERENCES web_orders_new(id) ON DELETE CASCADE,
        variant_id    INTEGER NOT NULL REFERENCES product_variants(id),
        sku           TEXT    NOT NULL,
        description   TEXT    NOT NULL,
        quantity      REAL    NOT NULL,
        unit_price    REAL    NOT NULL,
        tax_rate      REAL    NOT NULL DEFAULT 0,
        tax_amount    REAL    NOT NULL DEFAULT 0,
        line_total    REAL    NOT NULL DEFAULT 0,
        reserved      INTEGER NOT NULL DEFAULT 0
      )
    `);
    await ddl(`
      INSERT INTO web_order_lines_new (${LINE_COLUMNS})
      SELECT ${LINE_COLUMNS} FROM web_order_lines
    `);

    // Child first, same reasoning as 004: the new child already points at
    // `web_orders_new`, so dropping the old parent once it has no child left
    // cascades nothing.
    await ddl('DROP TABLE web_order_lines');
    await ddl('DROP TABLE web_orders');
    await ddl('ALTER TABLE web_orders_new RENAME TO web_orders');
    await ddl('ALTER TABLE web_order_lines_new RENAME TO web_order_lines');

    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_status ON web_orders(status, created_at DESC)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_phone  ON web_orders(customer_phone)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_order_lines_order ON web_order_lines(order_id)');
    // The webhook's only way to find the order it is telling us about.
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_invoice_key ON web_orders(payment_invoice_key)');
  },
};
