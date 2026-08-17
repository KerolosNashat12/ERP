/**
 * Reporting.
 *
 * Every report returns the same envelope — { key, title, columns, rows,
 * summary } — so the UI renders and exports any report with one component and
 * adding a report means adding one entry to REPORTS.
 */
import repositories from '../infrastructure/repositories/index.js';
import { getDb } from '../infrastructure/database/connection.js';
import { NotFoundError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';

const col = (key, labelEn, labelAr, type = 'text') => ({ key, labelEn, labelAr, type });

const dateRange = ({ dateFrom, dateTo }) => ({
  from: dateFrom || '1900-01-01',
  to: dateTo || '2999-12-31',
});

export const REPORTS = {
  // ------------------------------------------------------------- inventory
  inventory_valuation: {
    titleEn: 'Inventory Valuation',
    titleAr: 'تقييم المخزون',
    module: 'inventory',
    columns: [
      col('sku', 'SKU', 'الكود'),
      col('product_name_en', 'Product', 'المنتج'),
      col('variant_label', 'Variant', 'المتغير'),
      col('brand_name_en', 'Brand', 'العلامة'),
      col('quantity', 'On hand', 'الكمية', 'number'),
      col('average_cost', 'Avg cost', 'متوسط التكلفة', 'money'),
      col('selling_price', 'Sell price', 'سعر البيع', 'money'),
      col('stock_value', 'Stock value', 'قيمة المخزون', 'money'),
      col('retail_value', 'Retail value', 'قيمة البيع', 'money'),
    ],
    run: async (filters) => {
      const where = ['variant_active = 1'];
      const params = [];
      if (filters.warehouseId) { where.push('warehouse_id = ?'); params.push(filters.warehouseId); }
      if (filters.brandId) { where.push('brand_id = ?'); params.push(filters.brandId); }
      if (filters.categoryId) { where.push('category_id = ?'); params.push(filters.categoryId); }
      if (filters.hideZero !== 'false') where.push('quantity <> 0');
      const rows = await getDb().prepare(`
        SELECT *, ROUND(quantity * selling_price, 2) AS retail_value
        FROM v_stock_on_hand WHERE ${where.join(' AND ')}
        ORDER BY stock_value DESC
      `).all(...params);
      return {
        rows,
        summary: {
          items: rows.length,
          total_quantity: round2(rows.reduce((s, r) => s + r.quantity, 0)),
          total_cost_value: round2(rows.reduce((s, r) => s + r.stock_value, 0)),
          total_retail_value: round2(rows.reduce((s, r) => s + r.retail_value, 0)),
          potential_margin: round2(rows.reduce((s, r) => s + r.retail_value - r.stock_value, 0)),
        },
      };
    },
  },

  low_stock: {
    titleEn: 'Low Stock & Reorder',
    titleAr: 'نواقص المخزون',
    module: 'inventory',
    columns: [
      col('sku', 'SKU', 'الكود'),
      col('product_name_en', 'Product', 'المنتج'),
      col('variant_label', 'Variant', 'المتغير'),
      col('supplier_name_en', 'Supplier', 'المورد'),
      col('quantity', 'On hand', 'الكمية', 'number'),
      col('reorder_level', 'Reorder at', 'حد الطلب', 'number'),
      col('shortfall', 'Shortfall', 'النقص', 'number'),
      col('cost_price', 'Unit cost', 'التكلفة', 'money'),
      col('reorder_cost', 'Reorder cost', 'تكلفة التوريد', 'money'),
    ],
    run: async (filters) => {
      const where = ['variant_active = 1', 'reorder_level > 0', 'quantity <= reorder_level'];
      const params = [];
      if (filters.warehouseId) { where.push('warehouse_id = ?'); params.push(filters.warehouseId); }
      const rows = await getDb().prepare(`
        SELECT *, ROUND(reorder_level - quantity, 2) AS shortfall,
               ROUND((reorder_level - quantity) * cost_price, 2) AS reorder_cost
        FROM v_stock_on_hand WHERE ${where.join(' AND ')}
        ORDER BY (quantity - reorder_level) ASC
      `).all(...params);
      return {
        rows,
        summary: {
          items: rows.length,
          total_shortfall: round2(rows.reduce((s, r) => s + r.shortfall, 0)),
          estimated_reorder_cost: round2(rows.reduce((s, r) => s + r.reorder_cost, 0)),
        },
      };
    },
  },

  stock_movements: {
    titleEn: 'Stock Movement Ledger',
    titleAr: 'حركة المخزون',
    module: 'inventory',
    columns: [
      col('created_at', 'Date', 'التاريخ', 'datetime'),
      col('reference_no', 'Document', 'المستند'),
      col('movement_type', 'Type', 'النوع'),
      col('sku', 'SKU', 'الكود'),
      col('product_name_en', 'Product', 'المنتج'),
      col('quantity', 'Qty', 'الكمية', 'number'),
      col('balance_after', 'Balance', 'الرصيد', 'number'),
      col('unit_cost', 'Unit cost', 'التكلفة', 'money'),
      col('user_name', 'User', 'المستخدم'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const where = ['date(m.created_at) BETWEEN date(?) AND date(?)'];
      const params = [from, to];
      if (filters.warehouseId) { where.push('m.warehouse_id = ?'); params.push(filters.warehouseId); }
      if (filters.movementType) { where.push('m.movement_type = ?'); params.push(filters.movementType); }
      const rows = await getDb().prepare(`
        SELECT m.*, vd.sku, vd.product_name_en, vd.variant_label,
               w.name_en AS warehouse_name_en, u.full_name AS user_name
        FROM stock_movements m
        JOIN v_variant_details vd ON vd.variant_id = m.variant_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN users u ON u.id = m.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC LIMIT 5000
      `).all(...params);
      return {
        rows,
        summary: {
          movements: rows.length,
          total_in: round2(rows.filter((r) => r.quantity > 0).reduce((s, r) => s + r.quantity, 0)),
          total_out: round2(rows.filter((r) => r.quantity < 0).reduce((s, r) => s + r.quantity, 0)),
        },
      };
    },
  },

  dead_stock: {
    titleEn: 'Slow-Moving / Dead Stock',
    titleAr: 'المخزون الراكد',
    module: 'inventory',
    columns: [
      col('sku', 'SKU', 'الكود'),
      col('product_name_en', 'Product', 'المنتج'),
      col('variant_label', 'Variant', 'المتغير'),
      col('quantity', 'On hand', 'الكمية', 'number'),
      col('stock_value', 'Tied-up value', 'القيمة المجمدة', 'money'),
      col('last_sold', 'Last sold', 'آخر بيع', 'date'),
      col('days_idle', 'Days idle', 'أيام الركود', 'number'),
    ],
    run: async (filters) => {
      const days = Number(filters.days || 60);
      const rows = await getDb().prepare(`
        SELECT v.*, sub.last_sold,
               CAST(julianday('now') - julianday(COALESCE(sub.last_sold, v.created_at_fallback)) AS INTEGER) AS days_idle
        FROM (
          SELECT s.*, (SELECT created_at FROM product_variants pv WHERE pv.id = s.variant_id) AS created_at_fallback
          FROM v_stock_on_hand s WHERE s.quantity > 0
        ) v
        LEFT JOIN (
          SELECT l.variant_id, MAX(sa.sale_date) AS last_sold
          FROM sale_lines l JOIN sales sa ON sa.id = l.sale_id AND sa.status = 'completed'
          GROUP BY l.variant_id
        ) sub ON sub.variant_id = v.variant_id
        WHERE (sub.last_sold IS NULL OR julianday('now') - julianday(sub.last_sold) >= ?)
        ORDER BY v.stock_value DESC
      `).all(days);
      return {
        rows,
        summary: {
          items: rows.length,
          tied_up_value: round2(rows.reduce((s, r) => s + r.stock_value, 0)),
          threshold_days: days,
        },
      };
    },
  },

  // ----------------------------------------------------------------- sales
  sales_summary: {
    titleEn: 'Sales Summary by Day',
    titleAr: 'ملخص المبيعات اليومي',
    module: 'sales',
    columns: [
      col('day', 'Date', 'التاريخ', 'date'),
      col('invoices', 'Invoices', 'الفواتير', 'number'),
      col('units', 'Units', 'القطع', 'number'),
      col('revenue', 'Revenue', 'الإيرادات', 'money'),
      col('discounts', 'Discounts', 'الخصومات', 'money'),
      col('tax', 'Tax', 'الضريبة', 'money'),
      col('cost', 'COGS', 'التكلفة', 'money'),
      col('profit', 'Gross profit', 'الربح', 'money'),
      col('margin_percent', 'Margin %', 'نسبة الربح', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const where = ["s.status = 'completed'", 'date(s.sale_date) BETWEEN date(?) AND date(?)'];
      const params = [from, to];
      if (filters.warehouseId) { where.push('s.warehouse_id = ?'); params.push(filters.warehouseId); }
      if (filters.userId) { where.push('s.created_by = ?'); params.push(filters.userId); }
      const rows = await getDb().prepare(`
        SELECT date(s.sale_date) AS day,
               COUNT(*) AS invoices,
               (SELECT COALESCE(SUM(l.quantity),0) FROM sale_lines l WHERE l.sale_id IN
                 (SELECT id FROM sales x WHERE date(x.sale_date) = date(s.sale_date) AND x.status='completed')) AS units,
               ROUND(SUM(s.total_amount),2)   AS revenue,
               ROUND(SUM(s.discount_amount),2) AS discounts,
               ROUND(SUM(s.tax_amount),2)     AS tax,
               ROUND(SUM(s.total_cost),2)     AS cost,
               ROUND(SUM(s.total_amount - s.total_cost),2) AS profit,
               ROUND(CASE WHEN SUM(s.total_amount) > 0
                     THEN (SUM(s.total_amount - s.total_cost) * 100.0) / SUM(s.total_amount)
                     ELSE 0 END, 2) AS margin_percent
        FROM sales s WHERE ${where.join(' AND ')}
        GROUP BY day ORDER BY day DESC
      `).all(...params);
      return {
        rows,
        summary: {
          days: rows.length,
          invoices: rows.reduce((s, r) => s + r.invoices, 0),
          revenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
          profit: round2(rows.reduce((s, r) => s + r.profit, 0)),
          discounts: round2(rows.reduce((s, r) => s + r.discounts, 0)),
        },
      };
    },
  },

  sales_by_product: {
    titleEn: 'Sales by Product',
    titleAr: 'المبيعات حسب المنتج',
    module: 'sales',
    columns: [
      col('sku', 'SKU', 'الكود'),
      col('description', 'Product', 'المنتج'),
      col('brand_name_en', 'Brand', 'العلامة'),
      col('category_name_en', 'Category', 'الفئة'),
      col('units', 'Units sold', 'الكمية', 'number'),
      col('revenue', 'Revenue', 'الإيرادات', 'money'),
      col('cost', 'Cost', 'التكلفة', 'money'),
      col('profit', 'Profit', 'الربح', 'money'),
      col('margin_percent', 'Margin %', 'نسبة الربح', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const where = ["s.status = 'completed'", 'date(s.sale_date) BETWEEN date(?) AND date(?)'];
      const params = [from, to];
      if (filters.brandId) { where.push('vd.brand_id = ?'); params.push(filters.brandId); }
      if (filters.categoryId) { where.push('vd.category_id = ?'); params.push(filters.categoryId); }
      const rows = await getDb().prepare(`
        SELECT l.sku, l.description, vd.brand_name_en, vd.category_name_en,
               ROUND(SUM(l.quantity),2) AS units,
               ROUND(SUM(l.line_total),2) AS revenue,
               ROUND(SUM(l.quantity * l.unit_cost),2) AS cost,
               ROUND(SUM(l.line_total - l.quantity * l.unit_cost),2) AS profit,
               ROUND(CASE WHEN SUM(l.line_total) > 0
                     THEN (SUM(l.line_total - l.quantity * l.unit_cost) * 100.0) / SUM(l.line_total)
                     ELSE 0 END, 2) AS margin_percent
        FROM sale_lines l
        JOIN sales s ON s.id = l.sale_id
        LEFT JOIN v_variant_details vd ON vd.variant_id = l.variant_id
        WHERE ${where.join(' AND ')}
        GROUP BY l.variant_id ORDER BY revenue DESC
      `).all(...params);
      return {
        rows,
        summary: {
          products: rows.length,
          units: round2(rows.reduce((s, r) => s + r.units, 0)),
          revenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
          profit: round2(rows.reduce((s, r) => s + r.profit, 0)),
        },
      };
    },
  },

  sales_by_brand: {
    titleEn: 'Sales by Brand & Category',
    titleAr: 'المبيعات حسب العلامة والفئة',
    module: 'sales',
    columns: [
      col('brand_name_en', 'Brand', 'العلامة'),
      col('category_name_en', 'Category', 'الفئة'),
      col('units', 'Units', 'الكمية', 'number'),
      col('revenue', 'Revenue', 'الإيرادات', 'money'),
      col('profit', 'Profit', 'الربح', 'money'),
      col('share_percent', 'Share %', 'الحصة', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT COALESCE(vd.brand_name_en,'—') AS brand_name_en,
               COALESCE(vd.category_name_en,'—') AS category_name_en,
               ROUND(SUM(l.quantity),2) AS units,
               ROUND(SUM(l.line_total),2) AS revenue,
               ROUND(SUM(l.line_total - l.quantity * l.unit_cost),2) AS profit
        FROM sale_lines l
        JOIN sales s ON s.id = l.sale_id AND s.status = 'completed'
        LEFT JOIN v_variant_details vd ON vd.variant_id = l.variant_id
        WHERE date(s.sale_date) BETWEEN date(?) AND date(?)
        GROUP BY vd.brand_id, vd.category_id ORDER BY revenue DESC
      `).all(from, to);
      const total = rows.reduce((s, r) => s + r.revenue, 0) || 1;
      rows.forEach((r) => { r.share_percent = round2((r.revenue * 100) / total); });
      return { rows, summary: { groups: rows.length, revenue: round2(total) } };
    },
  },

  sales_by_user: {
    titleEn: 'Sales by Cashier',
    titleAr: 'المبيعات حسب الموظف',
    module: 'sales',
    columns: [
      col('user_name', 'User', 'المستخدم'),
      col('role_name', 'Role', 'الدور'),
      col('invoices', 'Invoices', 'الفواتير', 'number'),
      col('revenue', 'Revenue', 'الإيرادات', 'money'),
      col('discounts', 'Discounts given', 'الخصومات', 'money'),
      col('average_basket', 'Avg basket', 'متوسط الفاتورة', 'money'),
      col('voids', 'Voided', 'الملغاة', 'number'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT u.full_name AS user_name, r.name_en AS role_name,
               COUNT(CASE WHEN s.status='completed' THEN 1 END) AS invoices,
               ROUND(COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total_amount END),0),2) AS revenue,
               ROUND(COALESCE(SUM(CASE WHEN s.status='completed' THEN s.discount_amount END),0),2) AS discounts,
               ROUND(COALESCE(AVG(CASE WHEN s.status='completed' THEN s.total_amount END),0),2) AS average_basket,
               COUNT(CASE WHEN s.status='void' THEN 1 END) AS voids
        FROM sales s
        JOIN users u ON u.id = s.created_by
        JOIN roles r ON r.id = u.role_id
        WHERE date(s.sale_date) BETWEEN date(?) AND date(?)
        GROUP BY s.created_by ORDER BY revenue DESC
      `).all(from, to);
      return { rows, summary: { users: rows.length, revenue: round2(rows.reduce((s, r) => s + r.revenue, 0)) } };
    },
  },

  payment_methods: {
    titleEn: 'Collections by Payment Method',
    titleAr: 'التحصيل حسب طريقة الدفع',
    module: 'sales',
    columns: [
      col('method', 'Method', 'الطريقة'),
      col('invoices', 'Invoices', 'الفواتير', 'number'),
      col('amount', 'Amount', 'المبلغ', 'money'),
      col('share_percent', 'Share %', 'الحصة', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT s.payment_method AS method, COUNT(*) AS invoices,
               ROUND(SUM(s.paid_amount),2) AS amount
        FROM sales s
        WHERE s.status='completed' AND date(s.sale_date) BETWEEN date(?) AND date(?)
        GROUP BY s.payment_method ORDER BY amount DESC
      `).all(from, to);
      const total = rows.reduce((s, r) => s + r.amount, 0) || 1;
      rows.forEach((r) => { r.share_percent = round2((r.amount * 100) / total); });
      return { rows, summary: { collected: round2(total) } };
    },
  },

  returns_report: {
    titleEn: 'Sales Returns',
    titleAr: 'مرتجعات المبيعات',
    module: 'sales',
    columns: [
      col('return_no', 'Return #', 'رقم المرتجع'),
      col('return_date', 'Date', 'التاريخ', 'datetime'),
      col('invoice_no', 'Invoice', 'الفاتورة'),
      col('customer_name', 'Customer', 'العميل'),
      col('reason_code', 'Reason', 'السبب'),
      col('units', 'Units', 'القطع', 'number'),
      col('restocked', 'Restocked', 'أعيد للمخزون', 'number'),
      col('written_off', 'Written off', 'تالف', 'number'),
      col('total_amount', 'Refunded', 'المسترد', 'money'),
      col('refund_method', 'Refund via', 'طريقة الاسترداد'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT r.return_no, r.return_date, COALESCE(r.invoice_no, '—') AS invoice_no,
               COALESCE(c.name, 'Walk-in') AS customer_name, r.reason_code,
               (SELECT COALESCE(SUM(l.quantity),0) FROM sales_return_lines l WHERE l.return_id = r.id) AS units,
               r.items_restocked AS restocked, r.items_written_off AS written_off,
               r.total_amount, r.refund_method
        FROM sales_returns r
        LEFT JOIN customers c ON c.id = r.customer_id
        WHERE date(r.return_date) BETWEEN date(?) AND date(?)
        ORDER BY r.id DESC
      `).all(from, to);
      return {
        rows,
        summary: {
          returns: rows.length,
          units: round2(rows.reduce((s, r) => s + r.units, 0)),
          refunded: round2(rows.reduce((s, r) => s + r.total_amount, 0)),
          written_off_units: round2(rows.reduce((s, r) => s + r.written_off, 0)),
        },
      };
    },
  },

  return_reasons: {
    titleEn: 'Why Items Come Back',
    titleAr: 'أسباب المرتجعات',
    module: 'sales',
    columns: [
      col('reason_code', 'Reason', 'السبب'),
      col('returns', 'Returns', 'عدد المرتجعات', 'number'),
      col('units', 'Units', 'القطع', 'number'),
      col('refunded', 'Refunded', 'المسترد', 'money'),
      col('share_percent', 'Share %', 'الحصة', 'percent'),
    ],
    run: async (filters) => {
      const rows = await repositories.salesReturns.reasonBreakdown(filters);
      const total = rows.reduce((s, r) => s + r.refunded, 0) || 1;
      rows.forEach((r) => { r.share_percent = round2((r.refunded * 100) / total); });
      return {
        rows,
        summary: {
          reasons: rows.length,
          refunded: round2(total),
          returns: rows.reduce((s, r) => s + r.returns, 0),
        },
      };
    },
  },

  // ------------------------------------------------------------- purchases
  purchases_by_supplier: {
    titleEn: 'Purchases by Supplier',
    titleAr: 'المشتريات حسب المورد',
    module: 'purchases',
    columns: [
      col('supplier_name', 'Supplier', 'المورد'),
      col('orders', 'Orders', 'الأوامر', 'number'),
      col('total_amount', 'Total', 'الإجمالي', 'money'),
      col('paid_amount', 'Paid', 'المدفوع', 'money'),
      col('outstanding', 'Outstanding', 'المستحق', 'money'),
      col('last_order', 'Last order', 'آخر أمر', 'date'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT sp.name_en AS supplier_name, COUNT(*) AS orders,
               ROUND(SUM(po.total_amount),2) AS total_amount,
               ROUND(SUM(po.paid_amount),2)  AS paid_amount,
               ROUND(SUM(po.total_amount - po.paid_amount),2) AS outstanding,
               MAX(po.order_date) AS last_order
        FROM purchase_orders po JOIN suppliers sp ON sp.id = po.supplier_id
        WHERE po.status <> 'cancelled' AND date(po.order_date) BETWEEN date(?) AND date(?)
        GROUP BY po.supplier_id ORDER BY total_amount DESC
      `).all(from, to);
      return {
        rows,
        summary: {
          suppliers: rows.length,
          purchased: round2(rows.reduce((s, r) => s + r.total_amount, 0)),
          outstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
        },
      };
    },
  },

  purchase_orders: {
    titleEn: 'Purchase Order Status',
    titleAr: 'حالة أوامر الشراء',
    module: 'purchases',
    columns: [
      col('po_number', 'PO #', 'رقم الأمر'),
      col('order_date', 'Date', 'التاريخ', 'date'),
      col('supplier_name', 'Supplier', 'المورد'),
      col('status', 'Status', 'الحالة'),
      col('lines', 'Lines', 'البنود', 'number'),
      col('ordered_qty', 'Ordered', 'المطلوب', 'number'),
      col('received_qty', 'Received', 'المستلم', 'number'),
      col('total_amount', 'Total', 'الإجمالي', 'money'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const where = ['date(po.order_date) BETWEEN date(?) AND date(?)'];
      const params = [from, to];
      if (filters.status) { where.push('po.status = ?'); params.push(filters.status); }
      const rows = await getDb().prepare(`
        SELECT po.po_number, po.order_date, s.name_en AS supplier_name, po.status,
               (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS lines,
               (SELECT COALESCE(SUM(quantity_ordered),0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS ordered_qty,
               (SELECT COALESCE(SUM(quantity_received),0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS received_qty,
               po.total_amount
        FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
        WHERE ${where.join(' AND ')} ORDER BY po.id DESC
      `).all(...params);
      return {
        rows,
        summary: { orders: rows.length, value: round2(rows.reduce((s, r) => s + r.total_amount, 0)) },
      };
    },
  },

  // --------------------------------------------------------------- clients
  customer_ranking: {
    titleEn: 'Top Customers',
    titleAr: 'أفضل العملاء',
    module: 'customers',
    columns: [
      col('code', 'Code', 'الكود'),
      col('name', 'Customer', 'العميل'),
      col('customer_group', 'Group', 'الفئة'),
      col('phone', 'Phone', 'الهاتف'),
      col('invoices', 'Invoices', 'الفواتير', 'number'),
      col('revenue', 'Total spent', 'إجمالي المشتريات', 'money'),
      col('average_basket', 'Avg basket', 'متوسط الفاتورة', 'money'),
      col('balance', 'Balance due', 'الرصيد', 'money'),
      col('loyalty_points', 'Points', 'النقاط', 'number'),
      col('last_purchase', 'Last purchase', 'آخر شراء', 'date'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT c.code, c.name, c.customer_group, c.phone, c.balance, c.loyalty_points,
               COUNT(s.id) AS invoices,
               ROUND(COALESCE(SUM(s.total_amount),0),2) AS revenue,
               ROUND(COALESCE(AVG(s.total_amount),0),2) AS average_basket,
               MAX(s.sale_date) AS last_purchase
        FROM customers c
        LEFT JOIN sales s ON s.customer_id = c.id AND s.status='completed'
             AND date(s.sale_date) BETWEEN date(?) AND date(?)
        GROUP BY c.id ORDER BY revenue DESC
      `).all(from, to);
      return {
        rows,
        summary: {
          customers: rows.length,
          revenue: round2(rows.reduce((s, r) => s + r.revenue, 0)),
          receivables: round2(rows.reduce((s, r) => s + r.balance, 0)),
        },
      };
    },
  },

  receivables: {
    titleEn: 'Customer Receivables',
    titleAr: 'مديونيات العملاء',
    module: 'customers',
    columns: [
      col('invoice_no', 'Invoice', 'الفاتورة'),
      col('sale_date', 'Date', 'التاريخ', 'date'),
      col('customer_name', 'Customer', 'العميل'),
      col('phone', 'Phone', 'الهاتف'),
      col('total_amount', 'Total', 'الإجمالي', 'money'),
      col('paid_amount', 'Paid', 'المدفوع', 'money'),
      col('outstanding', 'Outstanding', 'المتبقي', 'money'),
      col('days_open', 'Days open', 'أيام', 'number'),
    ],
    run: async () => {
      const rows = await getDb().prepare(`
        SELECT s.invoice_no, s.sale_date, c.name AS customer_name, c.phone,
               s.total_amount, s.paid_amount,
               ROUND(s.total_amount - s.paid_amount, 2) AS outstanding,
               CAST(julianday('now') - julianday(s.sale_date) AS INTEGER) AS days_open
        FROM sales s JOIN customers c ON c.id = s.customer_id
        WHERE s.status='completed' AND s.total_amount - s.paid_amount > 0.01
        ORDER BY days_open DESC
      `).all();
      return {
        rows,
        summary: {
          invoices: rows.length,
          outstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
          overdue_30: round2(rows.filter((r) => r.days_open > 30).reduce((s, r) => s + r.outstanding, 0)),
        },
      };
    },
  },

  // ------------------------------------------------------------ promotions
  promotion_usage: {
    titleEn: 'Promotion & Voucher Usage',
    titleAr: 'استخدام العروض والقسائم',
    module: 'promotions',
    columns: [
      col('code', 'Code', 'الكود'),
      col('name_en', 'Name', 'الاسم'),
      col('kind', 'Type', 'النوع'),
      col('redemptions', 'Times used', 'مرات الاستخدام', 'number'),
      col('unique_customers', 'Customers', 'العملاء', 'number'),
      col('total_discount', 'Discount given', 'قيمة الخصم', 'money'),
    ],
    run: async (filters) => {
      const rows = await repositories.promotions.usageReport(filters);
      return {
        rows,
        summary: {
          promotions: rows.length,
          redemptions: rows.reduce((s, r) => s + r.redemptions, 0),
          discount_given: round2(rows.reduce((s, r) => s + r.total_discount, 0)),
        },
      };
    },
  },

  // ----------------------------------------------------------------- audit
  audit_trail: {
    titleEn: 'Audit Trail',
    titleAr: 'سجل التدقيق',
    module: 'audit',
    columns: [
      col('created_at', 'Timestamp', 'الوقت', 'datetime'),
      col('username', 'User', 'المستخدم'),
      col('module', 'Module', 'الوحدة'),
      col('action', 'Action', 'الإجراء'),
      col('entity_type', 'Entity', 'الكيان'),
      col('entity_label', 'Record', 'السجل'),
      col('status', 'Status', 'الحالة'),
      col('ip_address', 'IP', 'العنوان'),
    ],
    run: async (filters) => {
      const { rows } = await repositories.audit.list({ ...filters, pageSize: 500 });
      return { rows, summary: { events: rows.length } };
    },
  },
};

export class ReportService {
  catalogue(permissions = []) {
    return Object.entries(REPORTS)
      .filter(([, def]) => permissions.includes('reports.view'))
      .map(([key, def]) => ({
        key, titleEn: def.titleEn, titleAr: def.titleAr, module: def.module,
        columns: def.columns,
      }));
  }

  async run(key, filters = {}) {
    const definition = REPORTS[key];
    if (!definition) throw new NotFoundError('Report', key);
    const { rows, summary } = await definition.run(filters);
    return {
      key,
      titleEn: definition.titleEn,
      titleAr: definition.titleAr,
      module: definition.module,
      columns: definition.columns,
      filters,
      generatedAt: new Date().toISOString(),
      rows,
      summary,
    };
  }

  /** CSV with a BOM so Excel opens Arabic text correctly. */
  toCsv(report, language = 'en') {
    const headers = report.columns.map((c) => (language === 'ar' ? c.labelAr : c.labelEn));
    const escape = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of report.rows) {
      lines.push(report.columns.map((c) => escape(row[c.key])).join(','));
    }
    return `﻿${lines.join('\n')}`;
  }
}

export const reportService = new ReportService();
export default reportService;
