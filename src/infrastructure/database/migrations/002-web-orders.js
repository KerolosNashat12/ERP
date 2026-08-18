/**
 * Orders placed on the website.
 *
 * A web order is NOT a sale. Nothing has left the shop when a customer taps
 * "order": the goods are still on the shelf and no money has changed hands.
 * Treating it as a sale would inflate takings, post stock movements for items
 * nobody has picked, and make the day's cash reconciliation wrong.
 *
 * So an order lives in its own table and holds stock through
 * `stock_levels.reserved_quantity` — visible to the till as physically present
 * but not sellable. Staff confirm it in the ERP, which is the moment it becomes
 * a real sale, posts the stock movement and releases the reservation.
 *
 * Payment is cash on delivery only. There is no gateway, no card data, and
 * nothing here ever touches a payment credential.
 */
export default {
  name: '002-web-orders',

  async up({ ddl }) {
    await ddl(`
      CREATE TABLE IF NOT EXISTS web_orders (
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
                           CHECK (status IN ('pending','confirmed','delivered','cancelled')),
        payment_method   TEXT    NOT NULL DEFAULT 'cash_on_delivery'
                           CHECK (payment_method IN ('cash_on_delivery')),
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
        cancelled_reason TEXT,
        placed_ip        TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_status ON web_orders(status, created_at DESC)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_phone  ON web_orders(customer_phone)');

    // Prices are copied onto the line, not looked up later: a customer is owed
    // the price they were shown, even if the catalogue changes tonight.
    await ddl(`
      CREATE TABLE IF NOT EXISTS web_order_lines (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id      INTEGER NOT NULL REFERENCES web_orders(id) ON DELETE CASCADE,
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
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_order_lines_order ON web_order_lines(order_id)');

    // Shop-wide settings staff can edit without a deploy.
    await ddl(`
      INSERT INTO settings (key, value, value_type, group_name)
      VALUES ('shop.enabled', '1', 'boolean', 'shop')
      ON CONFLICT(key) DO NOTHING
    `);
    for (const [key, value, type] of [
      ['shop.delivery_fee', '50', 'number'],
      ['shop.free_delivery_over', '2000', 'number'],
      ['shop.whatsapp', '', 'string'],
      ['shop.announcement_en', '', 'string'],
      ['shop.announcement_ar', '', 'string'],
      ['shop.low_stock_threshold', '3', 'number'],
    ]) {
      await ddl(`
        INSERT INTO settings (key, value, value_type, group_name)
        VALUES ('${key}', '${value}', '${type}', 'shop')
        ON CONFLICT(key) DO NOTHING
      `);
    }
  },
};
