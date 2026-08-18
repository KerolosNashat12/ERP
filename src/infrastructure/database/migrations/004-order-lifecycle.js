/**
 * The order lifecycle, corrected.
 *
 * `002-web-orders` had four states and put the sale at `confirmed`. That was
 * wrong for cash on delivery: accepting an order is a promise to deliver, not a
 * sale. Nothing is sold until the courier hands the box over and takes the
 * money, so the lifecycle grows two steps and the sale moves to the end of it:
 *
 *   pending → accepted → out_for_delivery → delivered      (sold, cash taken)
 *                    ↘  not_received                       (came back unsold)
 *   pending/accepted/out_for_delivery → cancelled
 *
 * Stock stays RESERVED for the first three states — visible to the till as
 * present but not sellable — and only leaves the shelf at `delivered`.
 *
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. The
 * trap is `web_order_lines.order_id REFERENCES web_orders(id) ON DELETE
 * CASCADE`: with `PRAGMA foreign_keys = ON` (which this application sets), a
 * plain `DROP TABLE web_orders` performs an implicit delete first and takes
 * every order line with it. So BOTH tables are rebuilt, and in an order that
 * never leaves a live child pointing at a table that is about to be dropped:
 *
 *   1. build `web_orders_new` and copy the orders into it, mapping status
 *   2. build `web_order_lines_new` — pointing at `web_orders_new` — and copy
 *   3. drop `web_order_lines` (it now has no rows anybody needs) …
 *   4. … which makes `web_orders` childless, so dropping it cascades nothing
 *   5. rename both; renaming the parent rewrites the child's REFERENCES clause
 *   6. recreate the indexes, which went with their tables
 *
 * Status mapping: `confirmed` becomes `accepted`. Those orders may already have
 * a sale behind them — the old code raised the invoice at confirmation — so the
 * `sale_id` is carried across untouched and `WebOrderService.deliver()` reuses
 * an existing sale rather than raising a second one.
 *
 * `confirmed_by` / `confirmed_at` are kept under their old names and now mean
 * "who accepted it, and when": renaming them would break nothing but buy
 * nothing either, and history stays readable.
 */

/** Every column of `web_orders`, in table order, shared by the copy statements. */
const ORDER_COLUMNS = `
  id, order_no, customer_id, customer_name, customer_phone, customer_email,
  address_line, address_area, address_city, address_notes,
  status, payment_method, subtotal, tax_amount, delivery_fee, total_amount,
  language, customer_note, staff_note, sale_id, confirmed_by, confirmed_at,
  cancelled_reason, placed_ip, created_at, updated_at
`;

const LINE_COLUMNS = `
  id, order_id, variant_id, sku, description, quantity, unit_price,
  tax_rate, tax_amount, line_total, reserved
`;

export default {
  name: '004-order-lifecycle',

  async up({ ddl, getDb, hasTable }) {
    // A database built after this shipped already has the new shape from an
    // earlier run, and a restored backup can be in any state — so look at the
    // constraint itself rather than trusting the registry.
    if (!(await hasTable('web_orders'))) return;
    const current = await getDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'web_orders'").get();
    if (String(current?.sql || '').includes('out_for_delivery')) return;

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
        dispatched_at    TEXT,
        delivered_at     TEXT,
        cancelled_reason TEXT,
        not_received_reason TEXT,
        placed_ip        TEXT,
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);

    // Every order carried over, `confirmed` renamed to `accepted` on the way.
    await ddl(`
      INSERT INTO web_orders_new (${ORDER_COLUMNS})
      SELECT id, order_no, customer_id, customer_name, customer_phone, customer_email,
             address_line, address_area, address_city, address_notes,
             CASE status WHEN 'confirmed' THEN 'accepted' ELSE status END,
             payment_method, subtotal, tax_amount, delivery_fee, total_amount,
             language, customer_note, staff_note, sale_id, confirmed_by, confirmed_at,
             cancelled_reason, placed_ip, created_at, updated_at
      FROM web_orders
    `);
    // An order that was already delivered under the old rules was delivered
    // when it was confirmed, so that is the only honest timestamp for it.
    await ddl("UPDATE web_orders_new SET delivered_at = confirmed_at WHERE status = 'delivered'");

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

    // Order matters: the child goes first, so the parent has nothing to cascade
    // to when it goes. The new child points at `web_orders_new`, not at the
    // table being dropped, so it is untouched by either statement.
    await ddl('DROP TABLE web_order_lines');
    await ddl('DROP TABLE web_orders');
    await ddl('ALTER TABLE web_orders_new RENAME TO web_orders');
    await ddl('ALTER TABLE web_order_lines_new RENAME TO web_order_lines');

    // Indexes are dropped with their table; the names are free again only now,
    // which is why they are recreated here rather than on the `_new` tables.
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_status ON web_orders(status, created_at DESC)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_orders_phone  ON web_orders(customer_phone)');
    await ddl('CREATE INDEX IF NOT EXISTS idx_web_order_lines_order ON web_order_lines(order_id)');
  },
};
