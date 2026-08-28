/**
 * The database schema, as a JavaScript module rather than a .sql file.
 *
 * This is deliberate: serverless bundlers trace `import` statements, not
 * `fs.readFileSync` calls, so a .sql file read at runtime is silently missing
 * from the deployed bundle. Keeping the schema as a real module means it is
 * always shipped, on every platform, with no build step and no bundler config.
 *
 * Everything is `IF NOT EXISTS`, so applying it repeatedly is safe.
 */

import { REQUEST_REPLAY_SQL } from '../../shared/requestReplay.js';
import { ATTACHMENTS_SQL } from '../../shared/attachments.js';
import { PURCHASE_PAYMENTS_SQL } from '../../shared/supplierPayments.js';
import { COSTS_SQL } from '../../shared/costs.js';
import { LEGACY_INVOICES_SQL } from '../../shared/legacyInvoices.js';

export const SCHEMA_SQL = `
-- =============================================================================
--  M&M Accessories ERP — Database Schema (SQLite)
--  All monetary values are stored as REAL and rounded to 2 decimals by the
--  application layer (money.js). All timestamps are UTC ISO-8601 strings.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- =============================================================================
--  1. IDENTITY, ACCESS CONTROL & SYSTEM
-- =============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  name_en       TEXT    NOT NULL,
  name_ar       TEXT    NOT NULL,
  description   TEXT,
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,          -- e.g. 'products.create'
  module        TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  description   TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id)       ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,
  full_name            TEXT    NOT NULL,
  email                TEXT,
  phone                TEXT,
  password_hash        TEXT    NOT NULL,
  role_id              INTEGER NOT NULL REFERENCES roles(id),
  default_warehouse_id INTEGER REFERENCES warehouses(id),
  language             TEXT    NOT NULL DEFAULT 'en' CHECK (language IN ('en','ar')),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);

-- Every mutating action in the system lands here. Append-only by convention.
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER REFERENCES users(id),
  username      TEXT,
  action        TEXT    NOT NULL,                 -- CREATE | UPDATE | DELETE | LOGIN | ...
  module        TEXT    NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  entity_label  TEXT,
  before_data   TEXT,                             -- JSON snapshot before change
  after_data    TEXT,                             -- JSON snapshot after change
  status        TEXT    NOT NULL DEFAULT 'SUCCESS',
  message       TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_module  ON audit_logs(module);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  value_type  TEXT NOT NULL DEFAULT 'string',
  group_name  TEXT NOT NULL DEFAULT 'general',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Human-readable document numbers (PO-2026-00001, INV-2026-00042, ...)
CREATE TABLE IF NOT EXISTS sequences (
  name        TEXT PRIMARY KEY,
  prefix      TEXT NOT NULL,
  next_value  INTEGER NOT NULL DEFAULT 1,
  padding     INTEGER NOT NULL DEFAULT 5,
  reset_yearly INTEGER NOT NULL DEFAULT 1,
  year        INTEGER
);

-- =============================================================================
--  2. MASTER DATA — SUPPLIERS, BRANDS, CATEGORIES, WAREHOUSES
-- =============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT    NOT NULL UNIQUE,
  name_en            TEXT    NOT NULL,
  name_ar            TEXT,
  contact_person     TEXT,
  phone              TEXT,
  email              TEXT,
  address            TEXT,
  city               TEXT,
  country            TEXT,
  tax_number         TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  credit_limit       REAL    NOT NULL DEFAULT 0,
  opening_balance    REAL    NOT NULL DEFAULT 0,
  lead_time_days     INTEGER NOT NULL DEFAULT 7,
  notes              TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name_en);

CREATE TABLE IF NOT EXISTS brands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name_en     TEXT    NOT NULL,
  name_ar     TEXT,
  description TEXT,
  country     TEXT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  logo_url    TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_published INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name_en     TEXT    NOT NULL,
  name_ar     TEXT,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_published  INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The business trades from ONE location. The table (and the warehouse_id
-- columns on documents) is kept deliberately: it holds exactly one row today,
-- and keeping the foreign key means a second shop can be added later without
-- migrating every historic document. The UI never shows a location picker.
CREATE TABLE IF NOT EXISTS warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  name_en    TEXT    NOT NULL,
  name_ar    TEXT,
  address    TEXT,
  phone      TEXT,
  is_default INTEGER NOT NULL DEFAULT 1,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =============================================================================
--  3. PRODUCT CATALOG — ATTRIBUTES, PRODUCTS, VARIANTS
--
--  Modelling note: "size", "colour", "material" are all *attributes*. A product
--  declares which attributes it uses; every sellable combination becomes a
--  product_variant with its own SKU, barcode and price. This keeps the model
--  open for extension (add a new attribute without touching the schema).
-- =============================================================================

CREATE TABLE IF NOT EXISTS attributes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,          -- 'size', 'color', 'material'
  name_en       TEXT    NOT NULL,
  name_ar       TEXT,
  input_type    TEXT    NOT NULL DEFAULT 'select' CHECK (input_type IN ('select','color')),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attribute_values (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id  INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  code          TEXT    NOT NULL,                 -- 'L', 'RED'
  value_en      TEXT    NOT NULL,
  value_ar      TEXT,
  color_hex     TEXT,                             -- used when input_type = 'color'
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (attribute_id, code)
);
CREATE INDEX IF NOT EXISTS idx_attr_values_attr ON attribute_values(attribute_id);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_prefix      TEXT    NOT NULL UNIQUE,        -- base SKU, variants extend it
  name_en         TEXT    NOT NULL,
  name_ar         TEXT,
  description_en  TEXT,
  description_ar  TEXT,
  brand_id        INTEGER REFERENCES brands(id)     ON DELETE SET NULL,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id     INTEGER REFERENCES suppliers(id)  ON DELETE SET NULL,
  unit            TEXT    NOT NULL DEFAULT 'piece',
  tax_rate        REAL    NOT NULL DEFAULT 0,
  base_cost       REAL    NOT NULL DEFAULT 0,
  base_price      REAL    NOT NULL DEFAULT 0,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  image_url       TEXT,
  tags            TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  -- Who the piece is for. Perfume is bought by gender before it is bought by
  -- anything else, so this is a first-class column rather than a tag or an
  -- attribute: the website filters on it and the shopper expects to.
  -- 'unisex' is the default because it is the answer that is never WRONG on a
  -- product nobody has classified yet -- it merely shows the piece to
  -- everybody, where a wrong guess would hide it from half the shop.
  gender          TEXT    NOT NULL DEFAULT 'unisex'
                  CHECK (gender IN ('women','men','unisex')),
  -- An offer on this product. While one runs, its price IS the product's
  -- price -- on the website, in an online order and at the till -- and the
  -- arithmetic lives in exactly one place: shared/pricing.js. Per product and
  -- not per variant: a shop discounts a bottle, not the 50ml of it.
  discount_type      TEXT NOT NULL DEFAULT 'none'
                     CHECK (discount_type IN ('none','percent','amount')),
  discount_value     REAL NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  -- Plain YYYY-MM-DD, both INCLUSIVE. Null start means already running, null
  -- end means until somebody turns it off.
  discount_starts_on TEXT,
  discount_ends_on   TEXT,
  -- Website visibility. Defaults to hidden on purpose: a product reaches
  -- customers only when somebody deliberately publishes it.
  is_published       INTEGER NOT NULL DEFAULT 0,
  published_at       TEXT,
  web_description_en TEXT,
  web_description_ar TEXT,
  -- No foreign key: products and product_images point at each other, and a
  -- circular constraint cannot be created from empty. Reads join loosely, so a
  -- stale id shows no photo rather than breaking the page.
  primary_image_id   INTEGER,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The indexes for gender and discount_type are NOT here, for the same
-- reason the view below does not name those columns: this file runs before the
-- migrations, so on a database that predates them the index would be created
-- against a column that does not exist yet and the boot would fail. They are
-- created by migrations/022-gender-and-offers.js, with IF NOT EXISTS, which
-- covers a new database and an old one alike.
CREATE INDEX IF NOT EXISTS idx_products_brand    ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name_en);

CREATE TABLE IF NOT EXISTS product_attributes (
  product_id    INTEGER NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  attribute_id  INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  display_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, attribute_id)
);

CREATE TABLE IF NOT EXISTS product_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku             TEXT    NOT NULL UNIQUE,
  barcode         TEXT    UNIQUE,                 -- QR / EAN payload
  variant_label   TEXT,                           -- cached "Large / Red"
  cost_price      REAL    NOT NULL DEFAULT 0,
  selling_price   REAL    NOT NULL DEFAULT 0,
  wholesale_price REAL    NOT NULL DEFAULT 0,
  reorder_level   REAL    NOT NULL DEFAULT 0,
  reorder_quantity REAL   NOT NULL DEFAULT 0,
  weight_grams    REAL,
  image_url       TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_barcode ON product_variants(barcode);
-- sku is UNIQUE, so it already has a binary index — but every exact-code
-- lookup in the app compares it COLLATE NOCASE (a code typed in lower case is
-- the same code), and a binary index cannot serve a NOCASE comparison. This is
-- the index that makes "the term IS this SKU" a seek instead of a scan, which
-- is what keeps the exact-match-first ordering cheap.
CREATE INDEX IF NOT EXISTS idx_variants_sku_nocase ON product_variants(sku COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS variant_attribute_values (
  variant_id         INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  attribute_id       INTEGER NOT NULL REFERENCES attributes(id)       ON DELETE CASCADE,
  attribute_value_id INTEGER NOT NULL REFERENCES attribute_values(id) ON DELETE CASCADE,
  PRIMARY KEY (variant_id, attribute_id)
);
CREATE INDEX IF NOT EXISTS idx_vav_value ON variant_attribute_values(attribute_value_id);

-- =============================================================================
--  4. INVENTORY — BALANCES, LEDGER, TRANSFERS, ADJUSTMENTS
--
--  stock_levels is a materialised balance; stock_movements is the immutable
--  ledger. Every balance change writes a ledger row inside the same
--  transaction, so the two can always be reconciled.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_levels (
  variant_id        INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id      INTEGER NOT NULL REFERENCES warehouses(id)       ON DELETE CASCADE,
  quantity          REAL    NOT NULL DEFAULT 0,
  reserved_quantity REAL    NOT NULL DEFAULT 0,
  average_cost      REAL    NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (variant_id, warehouse_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock_levels(warehouse_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id     INTEGER NOT NULL REFERENCES product_variants(id),
  warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
  movement_type  TEXT    NOT NULL CHECK (movement_type IN (
                    'purchase_receipt','sale','sale_return','purchase_return',
                    'adjustment','opening_balance','write_off')),
  quantity       REAL    NOT NULL,                -- signed: + in, - out
  unit_cost      REAL    NOT NULL DEFAULT 0,
  balance_after  REAL    NOT NULL DEFAULT 0,
  reference_type TEXT,
  reference_id   INTEGER,
  reference_no   TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON stock_movements(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_ref     ON stock_movements(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_movements_date    ON stock_movements(created_at DESC);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_no  TEXT    NOT NULL UNIQUE,
  warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),
  reason         TEXT    NOT NULL CHECK (reason IN ('stock_take','damage','loss','theft','correction','expiry','other')),
  status         TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  posted_by      INTEGER REFERENCES users(id),
  posted_at      TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stock_adjustment_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_id INTEGER NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id),
  system_qty    REAL    NOT NULL DEFAULT 0,
  counted_qty   REAL    NOT NULL DEFAULT 0,
  difference    REAL    NOT NULL DEFAULT 0,
  unit_cost     REAL    NOT NULL DEFAULT 0,
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_adjustment_lines ON stock_adjustment_lines(adjustment_id);
-- "which counts contain this product?" — the document search reaches a line
-- table by variant_id, so every line table needs that direction indexed.
CREATE INDEX IF NOT EXISTS idx_adjustment_lines_variant ON stock_adjustment_lines(variant_id);

-- =============================================================================
--  5. PURCHASING
-- =============================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number       TEXT    NOT NULL UNIQUE,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id),
  status          TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ordered','partially_received','received','cancelled')),
  order_date      TEXT    NOT NULL,
  expected_date   TEXT,
  subtotal        REAL    NOT NULL DEFAULT 0,
  -- The rate the supplier gave, and the money it comes to. The percent is what
  -- somebody typed; the amount is what everything downstream reads.
  --
  -- discount_type says WHICH of the two the person actually entered. A supplier
  -- who takes 5% off and a supplier who knocks 500 off a 12,000 order are doing
  -- different things, and storing only the percent turned the second into
  -- 4.1666...%, which then rounded its way back to 499.99 on the next screen.
  -- Both are still written on every order so nothing downstream has to branch.
  discount_type   TEXT    NOT NULL DEFAULT 'percent'
                  CHECK (discount_type IN ('percent','amount')),
  discount_percent REAL   NOT NULL DEFAULT 0,
  discount_amount REAL    NOT NULL DEFAULT 0,
  tax_amount      REAL    NOT NULL DEFAULT 0,
  shipping_amount REAL    NOT NULL DEFAULT 0,
  total_amount    REAL    NOT NULL DEFAULT 0,
  paid_amount     REAL    NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status   ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_date     ON purchase_orders(order_date DESC);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id  INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id         INTEGER NOT NULL REFERENCES product_variants(id),
  quantity_ordered   REAL    NOT NULL CHECK (quantity_ordered > 0),
  quantity_received  REAL    NOT NULL DEFAULT 0,
  unit_cost          REAL    NOT NULL DEFAULT 0,
  discount_percent   REAL    NOT NULL DEFAULT 0,
  tax_rate           REAL    NOT NULL DEFAULT 0,
  line_total         REAL    NOT NULL DEFAULT 0,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_lines ON purchase_order_lines(purchase_order_id);
-- ------------------------------------------------ goods going back to the supplier
/*
 * A purchase return: stock the shop received, paid for perhaps, and is sending
 * back - faulty, wrong item, short-dated, over-delivered.
 *
 * It is NOT a cancelled purchase order and it is not an edit of one. The order
 * says what was agreed and what arrived, and it must go on saying that however
 * many boxes go back later; a shop that reconciles a supplier statement in
 * December needs the September order to still read the way it read in
 * September. So the return is its own document, and everything about what the
 * shop still owes is worked out from the two together.
 *
 * settlement says what the supplier is doing about it:
 *   credit  - it comes off what the shop owes (or the supplier now owes the shop)
 *   refund  - the supplier is sending the money back
 *   replace - the same goods again; a replacement receipt brings them back in
 *
 * status carries 'reversed' for a return recorded in error, because deleting it
 * would take the stock movement's explanation with it.
 */
CREATE TABLE IF NOT EXISTS purchase_returns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no         TEXT    NOT NULL UNIQUE,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  po_number         TEXT,
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id      INTEGER NOT NULL REFERENCES warehouses(id),
  return_date       TEXT    NOT NULL,
  settlement        TEXT    NOT NULL DEFAULT 'credit'
                    CHECK (settlement IN ('credit','refund','replace')),
  status            TEXT    NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','reversed')),
  reason            TEXT,
  subtotal          REAL    NOT NULL DEFAULT 0,
  tax_amount        REAL    NOT NULL DEFAULT 0,
  total_amount      REAL    NOT NULL DEFAULT 0,
  -- What came back IN under a replacement, valued the same way. Zero on a
  -- credit or a refund, and the reason a replacement can be worth nothing net
  -- while still moving stock twice.
  replacement_amount REAL   NOT NULL DEFAULT 0,
  notes             TEXT,
  reversed_at       TEXT,
  reversed_by       INTEGER REFERENCES users(id),
  reversal_reason   TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_order ON purchase_returns(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_date ON purchase_returns(return_date DESC);

CREATE TABLE IF NOT EXISTS purchase_return_lines (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id          INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  po_line_id         INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  variant_id         INTEGER NOT NULL REFERENCES product_variants(id),
  sku                TEXT,
  description        TEXT,
  quantity           REAL    NOT NULL CHECK (quantity > 0),
  -- What the shop paid for this piece on that order, not today's cost. A return
  -- credits what was actually charged.
  unit_cost          REAL    NOT NULL DEFAULT 0,
  line_total         REAL    NOT NULL DEFAULT 0,
  -- On a replacement: how many came back in, which can be fewer than went out
  -- if the supplier was short.
  replacement_quantity REAL  NOT NULL DEFAULT 0,
  /*
   * And WHAT came back, which is not always the same thing.
   *
   * A supplier who cannot replace a faulty bottle sends a different one - a
   * different size, the next batch, another product entirely against the same
   * credit. NULL means like for like, which is the common case and what every
   * replacement written before this column existed was.
   *
   * The cost it comes back at is its own, not the returned line's: swapping a
   * 300 bottle for a 450 one leaves 150 owing, and pretending both were 300
   * would quietly lose the shop money on every uneven swap.
   */
  replacement_variant_id INTEGER REFERENCES product_variants(id),
  replacement_unit_cost  REAL    NOT NULL DEFAULT 0,
  reason             TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_lines ON purchase_return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_purchase_return_lines_po_line ON purchase_return_lines(po_line_id);

CREATE INDEX IF NOT EXISTS idx_po_lines_variant ON purchase_order_lines(variant_id);

-- ------------------------------------------------------- money out, with proof
-- What the shop actually paid this supplier, and when. The paid_amount column
-- on purchase_orders is the running total of these rows and is recomputed from
-- them, never incremented. Defined once in shared/supplierPayments.js because a
-- migration has to carry existing databases to the same shape.
${PURCHASE_PAYMENTS_SQL};

-- =============================================================================
--  6. CLIENTS & SALES
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  city           TEXT,
  customer_group TEXT    NOT NULL DEFAULT 'retail' CHECK (customer_group IN ('retail','wholesale','vip')),
  tax_number     TEXT,
  credit_limit   REAL    NOT NULL DEFAULT 0,
  balance        REAL    NOT NULL DEFAULT 0,     -- positive = customer owes us
  loyalty_points REAL    NOT NULL DEFAULT 0,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

CREATE TABLE IF NOT EXISTS sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no       TEXT    NOT NULL UNIQUE,
  customer_id      INTEGER REFERENCES customers(id),
  warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id),
  status           TEXT    NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','void')),
  payment_status   TEXT    NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('unpaid','partial','paid')),
  sale_date        TEXT    NOT NULL,
  subtotal         REAL    NOT NULL DEFAULT 0,
  line_discount    REAL    NOT NULL DEFAULT 0,
  promotion_id     INTEGER REFERENCES promotions(id),
  promotion_code   TEXT,
  promotion_discount REAL  NOT NULL DEFAULT 0,
  discount_amount  REAL    NOT NULL DEFAULT 0,   -- total discount (line + promo + manual)
  manual_discount  REAL    NOT NULL DEFAULT 0,
  tax_amount       REAL    NOT NULL DEFAULT 0,
  total_amount     REAL    NOT NULL DEFAULT 0,
  total_cost       REAL    NOT NULL DEFAULT 0,   -- COGS snapshot for margin reports
  paid_amount      REAL    NOT NULL DEFAULT 0,
  change_amount    REAL    NOT NULL DEFAULT 0,
  payment_method   TEXT    NOT NULL DEFAULT 'cash'
                   CHECK (payment_method IN ('cash','card','transfer','wallet','credit','mixed')),
  loyalty_earned   REAL    NOT NULL DEFAULT 0,
  loyalty_redeemed REAL    NOT NULL DEFAULT 0,
  notes            TEXT,
  created_by       INTEGER REFERENCES users(id),
  voided_by        INTEGER REFERENCES users(id),
  voided_at        TEXT,
  void_reason      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_date     ON sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_user     ON sales(created_by);
CREATE INDEX IF NOT EXISTS idx_sales_status   ON sales(status);
-- The console's fleet summary reads every shop through
--   status = 'completed' AND date(sale_date) BETWEEN … AND …
-- and groups the trend by date(sale_date). An index on the bare column cannot
-- serve either, because date() wraps it; this is the expression itself,
-- restricted to the rows the question is about. See migration 014.
--
-- The three trailing columns make it COVERING for both readers, which is where
-- its speed comes from rather than from the seek: the fleet sweep wants
-- total_amount, the lifetime profit report wants total_cost and groups by
-- substr(sale_date, 1, 7), and without sale_date itself in the index that grouping
-- sends every matched row back to the table. Measured on a 20,000-sale shop,
-- the lifetime profit query is 19ms without them and 5ms with them, and the
-- fleet sweep's own read is 13.6ms without and 1.1ms with. See migration 016,
-- which widens it on databases that already have the narrower version.
CREATE INDEX IF NOT EXISTS idx_sales_completed_day
  ON sales(date(sale_date), sale_date, total_amount, total_cost) WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS sale_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_id       INTEGER NOT NULL REFERENCES product_variants(id),
  sku              TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  quantity         REAL    NOT NULL CHECK (quantity > 0),
  returned_quantity REAL   NOT NULL DEFAULT 0,
  unit_price       REAL    NOT NULL DEFAULT 0,
  -- What one piece cost before the offer, when it was on one. Zero means it
  -- was not. Deliberately NOT part of any total: unit_price is what was
  -- charged, and this exists so a receipt can print the old price with a line
  -- through it without any figure in the shop's books depending on it.
  list_price       REAL    NOT NULL DEFAULT 0,
  unit_cost        REAL    NOT NULL DEFAULT 0,
  discount_percent REAL    NOT NULL DEFAULT 0,
  discount_amount  REAL    NOT NULL DEFAULT 0,
  tax_rate         REAL    NOT NULL DEFAULT 0,
  tax_amount       REAL    NOT NULL DEFAULT 0,
  line_total       REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_lines_sale    ON sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_lines_variant ON sale_lines(variant_id);
-- "what did we sell without knowing what it cost?" — the honesty check the
-- lifetime profit report runs, and the one query in the system that wants the
-- lines nobody normally looks at. A partial index is tiny (a healthy shop has
-- almost no rows in it) and turns a 60,000-line join into a seek: 32ms to
-- 3.6ms on a 20,000-sale shop. See migration 016.
CREATE INDEX IF NOT EXISTS idx_sale_lines_no_cost
  ON sale_lines(sale_id, quantity, line_total) WHERE unit_cost <= 0;

CREATE TABLE IF NOT EXISTS sale_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount     REAL    NOT NULL,
  method     TEXT    NOT NULL DEFAULT 'cash',
  reference  TEXT,
  paid_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON sale_payments(sale_id);

-- Returns.
--   * 'sale_id' is NULL for a no-receipt return (allowed only when the setting
--     permits it, and only refunded as store credit).
--   * Each line records the CONDITION of the item coming back: a resellable item
--     goes on the shelf, a damaged one is received and immediately written off so
--     the loss is visible in the ledger rather than silently absorbed.
CREATE TABLE IF NOT EXISTS sales_returns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no         TEXT    NOT NULL UNIQUE,
  sale_id           INTEGER REFERENCES sales(id),
  invoice_no        TEXT,
  customer_id       INTEGER REFERENCES customers(id),
  warehouse_id      INTEGER NOT NULL REFERENCES warehouses(id),
  return_type       TEXT    NOT NULL DEFAULT 'with_receipt'
                    CHECK (return_type IN ('with_receipt','no_receipt')),
  return_date       TEXT    NOT NULL,
  reason_code       TEXT    NOT NULL DEFAULT 'other'
                    CHECK (reason_code IN ('defective','wrong_item','wrong_size','not_as_described',
                                           'changed_mind','damaged_in_transit','duplicate','other')),
  reason_note       TEXT,
  subtotal          REAL    NOT NULL DEFAULT 0,
  tax_amount        REAL    NOT NULL DEFAULT 0,
  total_amount      REAL    NOT NULL DEFAULT 0,
  restocking_fee    REAL    NOT NULL DEFAULT 0,
  refund_method     TEXT    NOT NULL DEFAULT 'cash'
                    CHECK (refund_method IN ('cash','card','transfer','wallet','store_credit','account')),
  store_credit_code TEXT,                            -- voucher issued for a store-credit refund
  loyalty_reversed  REAL    NOT NULL DEFAULT 0,
  items_restocked   REAL    NOT NULL DEFAULT 0,
  items_written_off REAL    NOT NULL DEFAULT 0,
  -- A return the recycle bin undid stays here, marked, rather than vanishing:
  -- its number is on a slip in somebody's hand. Reversed rows are skipped by
  -- every figure that speaks about money. See migrations/021-return-reversal.js.
  status            TEXT    NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','reversed')),
  reversed_at       TEXT,
  reversed_by       INTEGER REFERENCES users(id),
  reversal_reason   TEXT,
  created_by        INTEGER REFERENCES users(id),
  approved_by       INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_returns_sale ON sales_returns(sale_id);

/*
 * An EXCHANGE — the customer brought something back and took something else.
 *
 * Deliberately NOT a document of its own with its own lines. An exchange IS a
 * return plus a sale, and both of those already exist, already move stock,
 * already touch loyalty and the customer's balance, and are already audited.
 * Writing a third kind of document that did all of that again would be a second
 * implementation of the two hardest paths in the system, kept in step by hope.
 *
 * So this table is a JOIN, and the three ids are the whole point: the original
 * invoice, the return that credited it, and the sale that replaced it. From any
 * one of them a person can reach the other two, which is what "keep the
 * relationship with the original invoice" means in practice — six months later,
 * on a screen, with a customer asking.
 *
 * The money is stored as three figures rather than one: what the returned goods
 * were worth, what the new ones cost, and the difference that actually crossed
 * the counter. The first two can be recomputed from the documents; keeping them
 * here means a report about exchanges does not have to open two documents per
 * row to say anything at all.
 */
CREATE TABLE IF NOT EXISTS exchanges (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  exchange_no        TEXT    NOT NULL UNIQUE,
  sale_id            INTEGER NOT NULL REFERENCES sales(id),
  invoice_no         TEXT,
  return_id          INTEGER NOT NULL REFERENCES sales_returns(id),
  return_no          TEXT,
  new_sale_id        INTEGER NOT NULL REFERENCES sales(id),
  new_invoice_no     TEXT,
  customer_id        INTEGER REFERENCES customers(id),
  warehouse_id       INTEGER NOT NULL REFERENCES warehouses(id),
  -- What came back, what went out, and what crossed the counter. The
  -- difference is POSITIVE when the customer paid more and NEGATIVE when the
  -- shop handed money back, which is the same sign convention the screen uses.
  credit_amount      REAL    NOT NULL DEFAULT 0,
  replacement_amount REAL    NOT NULL DEFAULT 0,
  difference_amount  REAL    NOT NULL DEFAULT 0,
  settlement_method  TEXT    NOT NULL DEFAULT 'cash',
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exchanges_sale ON exchanges(sale_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_return ON exchanges(return_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_new_sale ON exchanges(new_sale_id);
CREATE INDEX IF NOT EXISTS idx_exchanges_date ON exchanges(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_returns_date ON sales_returns(return_date DESC);

CREATE TABLE IF NOT EXISTS sales_return_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  sale_line_id  INTEGER REFERENCES sale_lines(id),
  variant_id    INTEGER NOT NULL REFERENCES product_variants(id),
  sku           TEXT,
  description   TEXT,
  quantity      REAL    NOT NULL CHECK (quantity > 0),
  unit_price    REAL    NOT NULL DEFAULT 0,          -- net price actually paid per unit
  unit_cost     REAL    NOT NULL DEFAULT 0,
  tax_amount    REAL    NOT NULL DEFAULT 0,
  line_total    REAL    NOT NULL DEFAULT 0,
  condition     TEXT    NOT NULL DEFAULT 'resellable'
                CHECK (condition IN ('resellable','damaged')),
  notes         TEXT
);
CREATE INDEX IF NOT EXISTS idx_return_lines ON sales_return_lines(return_id);
CREATE INDEX IF NOT EXISTS idx_return_lines_variant ON sales_return_lines(variant_id);

-- =============================================================================
--  7. PROMOTIONS — DISCOUNT CODES & VOUCHERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS promotions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT    NOT NULL UNIQUE,
  name_en             TEXT    NOT NULL,
  name_ar             TEXT,
  kind                TEXT    NOT NULL DEFAULT 'discount' CHECK (kind IN ('discount','voucher')),
  discount_type       TEXT    NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage','fixed')),
  value               REAL    NOT NULL DEFAULT 0,
  scope               TEXT    NOT NULL DEFAULT 'order' CHECK (scope IN ('order','product','category','brand')),
  min_order_amount    REAL    NOT NULL DEFAULT 0,
  max_discount_amount REAL    NOT NULL DEFAULT 0,   -- 0 = uncapped
  voucher_balance     REAL    NOT NULL DEFAULT 0,   -- for kind = 'voucher'
  starts_at           TEXT,
  ends_at             TEXT,
  usage_limit         INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  usage_count         INTEGER NOT NULL DEFAULT 0,
  per_customer_limit  INTEGER NOT NULL DEFAULT 0,
  customer_group      TEXT,                          -- NULL = all groups
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_by          INTEGER REFERENCES users(id),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS promotion_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  target_type  TEXT    NOT NULL CHECK (target_type IN ('product','category','brand','variant')),
  target_id    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_targets ON promotion_targets(promotion_id);

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  promotion_id    INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  sale_id         INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  customer_id     INTEGER REFERENCES customers(id),
  discount_amount REAL    NOT NULL DEFAULT 0,
  redeemed_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_promo ON promotion_redemptions(promotion_id);

-- =============================================================================
--  8. REPORTING VIEWS
-- =============================================================================

-- ---------------------------------------------------------------- photographs
-- The bytes live here rather than on a disk. A serverless host has no durable
-- disk, and the shop PC has to work with the internet down; keeping images in
-- SQLite means a photo is in the backup, travels with the data, and behaves
-- identically in both places. The browser compresses and resizes before upload,
-- so these rows are ~120 KB, not whole phone photos.
CREATE TABLE IF NOT EXISTS product_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id)         ON DELETE CASCADE,
  variant_id    INTEGER          REFERENCES product_variants(id) ON DELETE CASCADE,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL DEFAULT 'image/jpeg',
  byte_size     INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  alt_en        TEXT,
  alt_ar        TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id, display_order);
CREATE INDEX IF NOT EXISTS idx_images_variant ON product_images(variant_id);

-- ---------------------------------------------------------------- attachments
-- One table for every photographed piece of paper in the system: the receipt
-- for a supplier payment today, a bill and a salary slip next. Polymorphic by
-- (owner_type, owner_id) so a new kind of owner is a new string, not a new
-- table. Defined once in shared/attachments.js; the contract for using it is at
-- the top of services/AttachmentService.js.
${ATTACHMENTS_SQL};

-- ---------------------------------------------------------------- website assets
-- One row per named image slot ('banner' today), so a second slot later is a
-- new row rather than a new table. Same reasoning as product_images: the bytes
-- live in the database, not on a disk that may not exist or may not survive.
-- ---------------------------------------------------------------- recycle bin
-- The REGISTER of what has been deleted, not where deleted things are stored:
-- a product or an invoice stays in its own table with its references intact,
-- and an in_bin row here is what hides it. See migration 019 for the whole
-- reasoning, including why the effect column is written down.
CREATE TABLE IF NOT EXISTS trash_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module       TEXT    NOT NULL,
  entity_type  TEXT    NOT NULL,
  entity_id    INTEGER NOT NULL,
  label        TEXT    NOT NULL,
  detail       TEXT,
  snapshot     TEXT,
  effect       TEXT,
  reason       TEXT,
  status       TEXT    NOT NULL DEFAULT 'in_bin'
               CHECK (status IN ('in_bin', 'restored', 'purged')),
  deleted_at   TEXT    NOT NULL,
  deleted_by   INTEGER REFERENCES users(id),
  purge_after  TEXT    NOT NULL,
  restored_at  TEXT,
  restored_by  INTEGER REFERENCES users(id),
  purged_at    TEXT,
  purged_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_trash_entity ON trash_items(entity_type, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_trash_status ON trash_items(status, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_trash_purge  ON trash_items(status, purge_after);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trash_one_live
  ON trash_items(entity_type, entity_id) WHERE status = 'in_bin';

CREATE TABLE IF NOT EXISTS web_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL UNIQUE,          -- 'banner' today
  data BLOB NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------- access recovery
-- There is no mail server here on purpose: the system has to work with the
-- internet down. So a locked-out user raises a request and an administrator
-- approves it in person, which is also the only identity check a shop can
-- actually perform. Requests are kept after they are handled so the audit
-- trail shows who let whom back in.
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username     TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','cancelled')),
  note         TEXT,
  requested_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  requested_ip TEXT,
  handled_by   INTEGER REFERENCES users(id),
  handled_at   TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reset_status ON password_reset_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_reset_user   ON password_reset_requests(user_id);

-- ---------------------------------------------------------------- what the shop spends
-- Costs (electricity, rent, taxes, equipment…), the templates that repeat, the
-- people on the payroll, and the categories all three are filed under. Defined
-- once in shared/costs.js because migration 012 has to create the identical
-- shape on a database that already exists. A salary payment is deliberately a
-- row in costs and not a table of its own — see that file for why.
${COSTS_SQL};

-- ---------------------------------------------------------------- فواتيرك
-- The invoices the shop already had ON PAPER before it had this system: a name,
-- a supplier, several photographs, and the payments recorded against them until
-- they are settled. Deliberately its OWN pair of tables and NOT part of
-- purchase_orders / purchase_payments / costs: nothing that sums the shop's
-- money may reach these rows, because the goods and the money on them predate
-- every total in this database and counting them again would double them.
-- Defined once in shared/legacyInvoices.js — read the head of that file before
-- changing anything here.
${LEGACY_INVOICES_SQL};

-- ---------------------------------------------------------------- one save, one document
-- Every unsafe request stakes a claim here before it runs, so a second copy of
-- the same click replays the first answer instead of writing a second row.
-- Defined once in shared/requestReplay.js because the control plane needs the
-- identical table. See api/middleware/idempotency.js for the protocol.
${REQUEST_REPLAY_SQL}

DROP VIEW IF EXISTS v_variant_details;
CREATE VIEW v_variant_details AS
SELECT
  v.id                AS variant_id,
  v.sku,
  v.barcode,
  v.variant_label,
  v.cost_price,
  v.selling_price,
  v.wholesale_price,
  v.reorder_level,
  v.is_active         AS variant_active,
  p.id                AS product_id,
  -- The product's own code, carried on the variant row so every screen that
  -- reads this view can answer "search by product code" with the one shared
  -- predicate instead of joining back to the products table for it.
  p.sku_prefix,
  p.name_en           AS product_name_en,
  p.name_ar           AS product_name_ar,
  p.unit,
  p.tax_rate,
  p.is_active         AS product_active,
  /*
   * Deliberately NOT here: gender and the four offer columns.
   *
   * This whole file is applied BEFORE the migrations on every start -- that is
   * what makes a new database and a five-month-old one end up identical -- and
   * a view can only name columns that exist at the moment it is created. A view
   * naming a column that a migration two steps later will add fails at
   * CREATE VIEW and takes the whole boot with it.
   *
   * So the rule for this view is: baseline columns only. Anything added by a
   * migration is joined for at the call site instead -- see
   * ProductRepository.details, which reads the offer columns straight from
   * the products table on the same single-row lookup.
   */
  b.id                AS brand_id,
  b.name_en           AS brand_name_en,
  b.name_ar           AS brand_name_ar,
  c.id                AS category_id,
  c.name_en           AS category_name_en,
  c.name_ar           AS category_name_ar,
  s.id                AS supplier_id,
  s.name_en           AS supplier_name_en
FROM product_variants v
JOIN products   p ON p.id = v.product_id
LEFT JOIN brands     b ON b.id = p.brand_id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN suppliers  s ON s.id = p.supplier_id;

DROP VIEW IF EXISTS v_stock_on_hand;
CREATE VIEW v_stock_on_hand AS
SELECT
  vd.*,
  w.id                AS warehouse_id,
  w.name_en           AS warehouse_name_en,
  w.name_ar           AS warehouse_name_ar,
  COALESCE(sl.quantity, 0)          AS quantity,
  COALESCE(sl.reserved_quantity, 0) AS reserved_quantity,
  COALESCE(sl.quantity, 0) - COALESCE(sl.reserved_quantity, 0) AS available_quantity,
  COALESCE(sl.average_cost, vd.cost_price) AS average_cost,
  ROUND(COALESCE(sl.quantity, 0) * COALESCE(sl.average_cost, vd.cost_price), 2) AS stock_value
FROM v_variant_details vd
CROSS JOIN warehouses w
LEFT JOIN stock_levels sl ON sl.variant_id = vd.variant_id AND sl.warehouse_id = w.id
WHERE w.is_active = 1;

`;

export default SCHEMA_SQL;
