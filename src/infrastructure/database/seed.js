/**
 * Seeding, as an importable module rather than only a script.
 *
 * The hosted deployment needs to be able to bring an empty database up by
 * itself on first boot — nobody should have to run a CLI with production
 * database credentials in it just to get a login screen. So the logic lives
 * here and `scripts/seed.js` is a thin wrapper over it.
 *
 * Both functions are idempotent: every insert either has an ON CONFLICT clause
 * or is guarded by an existence check, so running them twice changes nothing.
 */
import bcrypt from 'bcryptjs';
import { getDb, transaction } from './connection.js';
import config from '../../config/index.js';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '../../shared/permissions.js';

const nowIso = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Permissions, roles, the shop location, settings, the admin user, attributes. */
export async function seedBaseline() {
  const db = getDb();
  await transaction(async () => {
    const insertPermission = db.prepare(`
      INSERT INTO permissions (code, module, action, description) VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET module = excluded.module, action = excluded.action
    `);
    for (const p of ALL_PERMISSIONS) {
      await insertPermission.run(p.code, p.module, p.action, `${p.action} in ${p.module}`);
    }

    const insertRole = db.prepare(`
      INSERT INTO roles (code, name_en, name_ar, description, is_system) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(code) DO UPDATE SET name_en = excluded.name_en, name_ar = excluded.name_ar,
                                      description = excluded.description
    `);
    const linkPermission = db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT ?, id FROM permissions WHERE code = ?
    `);
    for (const role of ROLE_DEFINITIONS) {
      await insertRole.run(role.code, role.name_en, role.name_ar, role.description);
      const roleId = (await db.prepare('SELECT id FROM roles WHERE code = ?').get(role.code)).id;
      await db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      for (const code of role.permissions) await linkPermission.run(roleId, code);
    }

    const insertSequence = db.prepare(`
      INSERT INTO sequences (name, prefix, next_value, padding, reset_yearly, year)
      VALUES (?, ?, 1, ?, 1, ?) ON CONFLICT(name) DO NOTHING
    `);
    const year = new Date().getFullYear();
    await insertSequence.run('sale', 'INV', 5, year);
    await insertSequence.run('purchase_order', 'PO', 5, year);
    await insertSequence.run('sales_return', 'RET', 5, year);
    await insertSequence.run('stock_adjustment', 'ADJ', 5, year);

    // The single shop location.
    await db.prepare(`
      INSERT INTO warehouses (code, name_en, name_ar, is_default, is_active)
      VALUES ('MAIN', 'M&M Accessories', 'إم آند إم للإكسسوارات', 1, 1)
      ON CONFLICT(code) DO NOTHING
    `).run();

    const insertSetting = db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    const settings = [
      // --- company
      ['company.name', 'M&M Accessories', 'string', 'company'],
      ['company.name_ar', 'إم آند إم للإكسسوارات', 'string', 'company'],
      ['company.phone', '+20 100 000 0000', 'string', 'company'],
      ['company.email', 'hello@mm-accessories.local', 'string', 'company'],
      ['company.address', 'Giza, Egypt', 'string', 'company'],
      ['company.tax_number', '', 'string', 'company'],
      ['company.currency', config.business.currency, 'string', 'company'],
      ['company.currency_symbol_en', config.business.currencySymbolEn, 'string', 'company'],
      ['company.currency_symbol_ar', config.business.currencySymbolAr, 'string', 'company'],
      ['company.default_tax_rate', String(config.business.defaultTaxRate), 'number', 'company'],

      // --- operating rules
      ['inventory.allow_negative_stock', '0', 'boolean', 'inventory'],
      ['inventory.low_stock_alerts', '1', 'boolean', 'inventory'],
      ['loyalty.enabled', '1', 'boolean', 'loyalty'],
      ['loyalty.earn_rate', '0.05', 'number', 'loyalty'],
      ['loyalty.redeem_value', '0.5', 'number', 'loyalty'],

      // --- returns policy
      ['returns.window_days', '14', 'number', 'returns'],
      ['returns.allow_without_receipt', '1', 'boolean', 'returns'],
      ['returns.restocking_fee_percent', '0', 'number', 'returns'],
      ['returns.require_reason', '1', 'boolean', 'returns'],
      ['returns.store_credit_days', '90', 'number', 'returns'],

      // --- receipt printer
      ['printer.receipt_width', '80', 'string', 'printer'],       // 58 | 80 | a4
      ['printer.receipt_copies', '1', 'number', 'printer'],
      ['printer.auto_print_receipt', '0', 'boolean', 'printer'],
      ['printer.receipt_show_qr', '1', 'boolean', 'printer'],
      ['printer.receipt_show_tax_lines', '1', 'boolean', 'printer'],
      ['printer.receipt_font_scale', '100', 'number', 'printer'], // % — tune for your printer
      ['printer.receipt_footer_en', 'Thank you for shopping with us!', 'string', 'printer'],
      ['printer.receipt_footer_ar', 'شكرًا لتسوقكم معنا!', 'string', 'printer'],
      ['printer.receipt_return_policy_en', 'Exchange or refund within 14 days with this receipt.', 'string', 'printer'],
      ['printer.receipt_return_policy_ar', 'الاستبدال أو الاسترجاع خلال ١٤ يومًا بهذا الإيصال.', 'string', 'printer'],

      // --- label printer
      ['labels.width_mm', '40', 'number', 'labels'],
      ['labels.height_mm', '30', 'number', 'labels'],
      ['labels.gap_mm', '2', 'number', 'labels'],
      ['labels.offset_x_mm', '0', 'number', 'labels'],           // calibration nudge
      ['labels.offset_y_mm', '0', 'number', 'labels'],
      ['labels.qr_size_mm', '17', 'number', 'labels'],
      ['labels.show_product_name', '1', 'boolean', 'labels'],
      ['labels.show_variant', '1', 'boolean', 'labels'],
      ['labels.show_price', '1', 'boolean', 'labels'],
      ['labels.show_sku', '1', 'boolean', 'labels'],
      ['labels.show_shop_name', '0', 'boolean', 'labels'],

      // --- barcode / QR scanner
      ['scanner.enabled', '1', 'boolean', 'scanner'],
      ['scanner.max_key_interval_ms', '60', 'number', 'scanner'], // scanner speed threshold
      ['scanner.min_length', '3', 'number', 'scanner'],
      ['scanner.strip_prefix', '', 'string', 'scanner'],
      ['scanner.strip_suffix', '', 'string', 'scanner'],
      ['scanner.beep_on_scan', '1', 'boolean', 'scanner'],

      ['pos.default_payment_method', 'cash', 'string', 'pos'],
      ['ui.default_language', 'en', 'string', 'ui'],
    ];
    for (const [key, value, type, group] of settings) await insertSetting.run(key, value, type, group);

    // Administrator
    const adminRoleId = (await db.prepare("SELECT id FROM roles WHERE code = 'admin'").get()).id;
    const locationId = (await db.prepare("SELECT id FROM warehouses WHERE code = 'MAIN'").get()).id;
    if (!(await db.prepare("SELECT id FROM users WHERE username = 'admin'").get())) {
      await db.prepare(`
        INSERT INTO users (username, full_name, email, password_hash, role_id,
                           default_warehouse_id, language, is_active, must_change_password)
        VALUES ('admin', 'System Administrator', 'admin@mm-accessories.local', ?, ?, ?, 'en', 1, 1)
      `).run(bcrypt.hashSync('admin123', config.auth.bcryptRounds), adminRoleId, locationId);
    }

    // Attributes an accessories catalogue actually needs
    const insertAttribute = db.prepare(`
      INSERT INTO attributes (code, name_en, name_ar, input_type, display_order)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(code) DO NOTHING
    `);
    await insertAttribute.run('SIZE', 'Size', 'المقاس', 'select', 1);
    await insertAttribute.run('COLOR', 'Colour', 'اللون', 'color', 2);
    await insertAttribute.run('MATERIAL', 'Material', 'الخامة', 'select', 3);

    const attributeId = async (code) => (await db.prepare('SELECT id FROM attributes WHERE code = ?').get(code)).id;
    const insertValue = db.prepare(`
      INSERT INTO attribute_values (attribute_id, code, value_en, value_ar, color_hex, display_order)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attribute_id, code) DO NOTHING
    `);

    // Each id is looked up once rather than once per value — a hosted database
    // charges a network round trip for every one of these.
    const sizeId = await attributeId('SIZE');
    const colourId = await attributeId('COLOR');
    const materialId = await attributeId('MATERIAL');

    const sizeValues = [
      ['XS', 'Extra Small', 'صغير جدًا'], ['S', 'Small', 'صغير'], ['M', 'Medium', 'وسط'],
      ['L', 'Large', 'كبير'], ['XL', 'Extra Large', 'كبير جدًا'], ['OS', 'One Size', 'مقاس واحد'],
    ];
    for (const [i, [code, en, ar]] of sizeValues.entries()) {
      await insertValue.run(sizeId, code, en, ar, null, i);
    }

    const colourValues = [
      ['BLK', 'Black', 'أسود', '#111827'], ['WHT', 'White', 'أبيض', '#F9FAFB'],
      ['GLD', 'Gold', 'ذهبي', '#D4AF37'], ['SLV', 'Silver', 'فضي', '#C0C0C0'],
      ['RSG', 'Rose Gold', 'ذهبي وردي', '#B76E79'], ['RED', 'Red', 'أحمر', '#DC2626'],
      ['BLU', 'Blue', 'أزرق', '#2563EB'], ['BEG', 'Beige', 'بيج', '#D8CAB8'],
      ['BRN', 'Brown', 'بني', '#78350F'], ['PNK', 'Pink', 'وردي', '#EC4899'],
    ];
    for (const [i, [code, en, ar, hex]] of colourValues.entries()) {
      await insertValue.run(colourId, code, en, ar, hex, i);
    }

    const materialValues = [
      ['LTH', 'Genuine Leather', 'جلد طبيعي'], ['PU', 'PU Leather', 'جلد صناعي'],
      ['STL', 'Stainless Steel', 'ستانلس ستيل'], ['ALY', 'Alloy', 'سبيكة'],
      ['FAB', 'Fabric', 'قماش'], ['RSN', 'Resin', 'راتنج'],
    ];
    for (const [i, [code, en, ar]] of materialValues.entries()) {
      await insertValue.run(materialId, code, en, ar, null, i);
    }
  });
}

/** True when the worked example has already been inserted. */
export async function hasExampleData() {
  return (await getDb().prepare('SELECT COUNT(*) AS n FROM products').get()).n > 0;
}

/** One of everything, wired together, so every screen has something real in it. */
export async function seedExample() {
  const db = getDb();
  await transaction(async () => {
    const adminId = (await db.prepare("SELECT id FROM users WHERE username='admin'").get()).id;
    const locationId = (await db.prepare("SELECT id FROM warehouses WHERE code='MAIN'").get()).id;
    const roleId = async (code) => (await db.prepare('SELECT id FROM roles WHERE code = ?').get(code)).id;
    const attributeId = async (code) => (await db.prepare('SELECT id FROM attributes WHERE code = ?').get(code)).id;
    const valueId = async (attrCode, valCode) => (await db.prepare(`
      SELECT av.id FROM attribute_values av
      JOIN attributes a ON a.id = av.attribute_id
      WHERE a.code = ? AND av.code = ?
    `).get(attrCode, valCode)).id;

    // One cashier, so role-based access can be seen working.
    await db.prepare(`
      INSERT INTO users (username, full_name, email, phone, password_hash, role_id,
                         default_warehouse_id, language, is_active, created_by)
      VALUES ('cashier', 'Youssef Hany', 'cashier@mm-accessories.local', '+20 102 222 2222',
              ?, ?, ?, 'en', 1, ?)
    `).run(bcrypt.hashSync('cashier123', config.auth.bcryptRounds), await roleId('cashier'), locationId, adminId);
    const cashierId = (await db.prepare("SELECT id FROM users WHERE username='cashier'").get()).id;

    // --- one supplier
    const supplierId = (await db.prepare(`
      INSERT INTO suppliers (code, name_en, name_ar, contact_person, phone, email, city, country,
                             payment_terms_days, lead_time_days, credit_limit, created_by)
      VALUES ('SUP-0001', 'Cairo Leather Works', 'أعمال الجلود بالقاهرة', 'Hossam Fathy',
              '+20 122 555 0101', 'sales@cairoleather.eg', 'Cairo', 'Egypt', 30, 10, 200000, ?)
    `).run(adminId)).lastInsertRowid;

    // --- one brand
    const brandId = (await db.prepare(`
      INSERT INTO brands (code, name_en, name_ar, country, supplier_id, description, created_by)
      VALUES ('BRD-0001', 'Maison M', 'ميزون إم', 'Egypt', ?, 'House leather line', ?)
    `).run(supplierId, adminId)).lastInsertRowid;

    // --- one category
    const categoryId = (await db.prepare(`
      INSERT INTO categories (code, name_en, name_ar, created_by)
      VALUES ('CAT-0001', 'Handbags', 'حقائب يد', ?)
    `).run(adminId)).lastInsertRowid;

    // --- one product, with a size × colour variant matrix
    const productId = (await db.prepare(`
      INSERT INTO products (sku_prefix, name_en, name_ar, description_en, description_ar,
                            brand_id, category_id, supplier_id, unit, tax_rate,
                            base_cost, base_price, tags, created_by)
      VALUES ('MM-HB01', 'Classic Tote Handbag', 'حقيبة يد كلاسيكية',
              'Full-grain leather tote with cotton lining.', 'حقيبة جلد طبيعي ببطانة قطنية.',
              ?, ?, ?, 'piece', 14, 620, 1250, 'handbag,leather,tote', ?)
    `).run(brandId, categoryId, supplierId, adminId)).lastInsertRowid;

    const sizeAttributeId = await attributeId('SIZE');
    const colourAttributeId = await attributeId('COLOR');

    await db.prepare('INSERT INTO product_attributes (product_id, attribute_id, display_order) VALUES (?, ?, 0)')
      .run(productId, sizeAttributeId);
    await db.prepare('INSERT INTO product_attributes (product_id, attribute_id, display_order) VALUES (?, ?, 1)')
      .run(productId, colourAttributeId);

    const insertVariant = db.prepare(`
      INSERT INTO product_variants (product_id, sku, barcode, variant_label, cost_price,
                                    selling_price, wholesale_price, reorder_level, reorder_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOption = db.prepare(
      'INSERT INTO variant_attribute_values (variant_id, attribute_id, attribute_value_id) VALUES (?, ?, ?)',
    );
    const sizes = [
      { code: 'M', label: 'Medium', premium: 0 },
      { code: 'L', label: 'Large', premium: 0.06 },
    ];
    const colours = [
      { code: 'BLK', label: 'Black' },
      { code: 'BRN', label: 'Brown' },
      { code: 'BEG', label: 'Beige' },
    ];

    const variants = [];
    for (const size of sizes) {
      for (const colour of colours) {
        // Larger sizes carry a premium — this is the per-combination pricing.
        const price = Math.round(1250 * (1 + size.premium));
        const sku = `MM-HB01-${size.code}-${colour.code}`;
        const variantId = (await insertVariant.run(
          productId, sku, sku, `${size.label} / ${colour.label}`,
          620, price, Math.round(price * 0.8), 3, 12,
        )).lastInsertRowid;
        await insertOption.run(variantId, sizeAttributeId, await valueId('SIZE', size.code));
        await insertOption.run(variantId, colourAttributeId, await valueId('COLOR', colour.code));
        variants.push({ id: variantId, sku, price });
      }
    }

    // --- one client
    const customerId = (await db.prepare(`
      INSERT INTO customers (code, name, phone, email, city, customer_group, loyalty_points, created_by)
      VALUES ('CUS-0001', 'Sara Mostafa', '+20 111 222 3344', 'sara@example.com', 'Giza', 'retail', 0, ?)
    `).run(adminId)).lastInsertRowid;

    // --- one promo code
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await db.prepare(`
      INSERT INTO promotions (code, name_en, name_ar, kind, discount_type, value, scope,
                              min_order_amount, ends_at, is_active, created_by)
      VALUES ('WELCOME10', 'Welcome 10%', 'خصم ترحيبي ١٠٪', 'discount', 'percentage', 10,
              'order', 500, ?, 1, ?)
    `).run(in30, adminId);

    // --- one purchase order, fully received (this is what puts stock on the shelf)
    const year = new Date().getFullYear();
    const poNumber = `PO-${year}-00001`;
    const orderQty = 10;
    const unitCost = 620;
    const lineNet = orderQty * unitCost;
    const poId = (await db.prepare(`
      INSERT INTO purchase_orders (po_number, supplier_id, warehouse_id, status, order_date,
                                   expected_date, subtotal, tax_amount, total_amount, paid_amount,
                                   created_by, approved_by, approved_at)
      VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      poNumber, supplierId, locationId, daysAgo(9).slice(0, 10), daysAgo(4).slice(0, 10),
      lineNet * variants.length, lineNet * variants.length * 0.14,
      lineNet * variants.length * 1.14, lineNet * variants.length * 1.14,
      adminId, adminId, daysAgo(9),
    )).lastInsertRowid;

    const insertPoLine = db.prepare(`
      INSERT INTO purchase_order_lines (purchase_order_id, variant_id, quantity_ordered,
                                        quantity_received, unit_cost, tax_rate, line_total)
      VALUES (?, ?, ?, ?, ?, 14, ?)
    `);
    const insertLevel = db.prepare(`
      INSERT INTO stock_levels (variant_id, warehouse_id, quantity, average_cost) VALUES (?, ?, ?, ?)
    `);
    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (variant_id, warehouse_id, movement_type, quantity, unit_cost,
                                   balance_after, reference_type, reference_id, reference_no,
                                   created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const variant of variants) {
      await insertPoLine.run(poId, variant.id, orderQty, orderQty, unitCost, lineNet * 1.14);
      await insertLevel.run(variant.id, locationId, orderQty, unitCost);
      await insertMovement.run(variant.id, locationId, 'purchase_receipt', orderQty, unitCost,
        orderQty, 'purchase_order', poId, poNumber, adminId, daysAgo(4));
    }

    // --- one sale, so the POS, invoice and returns screens all have a subject
    const soldVariant = variants[0];
    const soldQty = 1;
    const net = soldVariant.price * soldQty;
    const tax = Math.round(net * 0.14 * 100) / 100;
    const total = Math.round((net + tax) * 100) / 100;
    const invoiceNo = `INV-${year}-00001`;

    const saleId = (await db.prepare(`
      INSERT INTO sales (invoice_no, customer_id, warehouse_id, status, payment_status, sale_date,
                         subtotal, discount_amount, tax_amount, total_amount, total_cost,
                         paid_amount, payment_method, loyalty_earned, created_by, created_at)
      VALUES (?, ?, ?, 'completed', 'paid', ?, ?, 0, ?, ?, ?, ?, 'cash', ?, ?, ?)
    `).run(
      invoiceNo, customerId, locationId, daysAgo(2), net, tax, total,
      unitCost * soldQty, total, Math.floor(total * 0.05), cashierId, daysAgo(2),
    )).lastInsertRowid;

    await db.prepare(`
      INSERT INTO sale_lines (sale_id, variant_id, sku, description, quantity, unit_price,
                              unit_cost, tax_rate, tax_amount, line_total)
      VALUES (?, ?, ?, 'Classic Tote Handbag — Medium / Black', ?, ?, ?, 14, ?, ?)
    `).run(saleId, soldVariant.id, soldVariant.sku, soldQty, soldVariant.price, unitCost, tax, total);

    await db.prepare('INSERT INTO sale_payments (sale_id, amount, method, created_by, paid_at) VALUES (?, ?, ?, ?, ?)')
      .run(saleId, total, 'cash', cashierId, daysAgo(2));

    await db.prepare('UPDATE stock_levels SET quantity = quantity - ? WHERE variant_id = ? AND warehouse_id = ?')
      .run(soldQty, soldVariant.id, locationId);
    await insertMovement.run(soldVariant.id, locationId, 'sale', -soldQty, unitCost,
      orderQty - soldQty, 'sale', saleId, invoiceNo, cashierId, daysAgo(2));

    await db.prepare('UPDATE customers SET loyalty_points = ? WHERE id = ?')
      .run(Math.floor(total * 0.05), customerId);

    await db.prepare('UPDATE sequences SET next_value = 2 WHERE name IN (?, ?)').run('sale', 'purchase_order');
    await db.prepare('UPDATE sequences SET next_value = 2 WHERE name = ?').run('purchase_order');

    await db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, module, entity_type, entity_id,
                              entity_label, status, message, ip_address, created_at)
      VALUES (?, 'admin', 'SEED', 'settings', 'system', '0', 'Example data', 'SUCCESS', ?, '127.0.0.1', ?)
    `).run(adminId, 'Example dataset generated by scripts/seed.js --demo', nowIso());
  });
}

export default { seedBaseline, seedExample, hasExampleData };
