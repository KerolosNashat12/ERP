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
import { costFilter } from '../infrastructure/repositories/CostRepository.js';

const col = (key, labelEn, labelAr, type = 'text') => ({ key, labelEn, labelAr, type });

const dateRange = ({ dateFrom, dateTo }) => ({
  from: dateFrom || '1900-01-01',
  to: dateTo || '2999-12-31',
});

/**
 * The three places money leaves this shop, named once and in both languages.
 *
 * They partition every row of the spend report: goods paid to suppliers, the
 * costs ledger, and the salary rows inside the costs ledger. A cost row is in
 * exactly one of the last two — its category's `kind` decides — so the rows can
 * be summed to the headline with nothing double-counted and nothing dropped.
 */
const GROUPS = {
  goods: { order: 1, en: 'Goods from suppliers', ar: 'بضاعة من الموردين' },
  costs: { order: 2, en: 'Shop costs', ar: 'تكاليف المحل' },
  wages: { order: 3, en: 'Wages', ar: 'مرتبات' },
};
const groupLabels = (bucket) => ({ group_en: GROUPS[bucket].en, group_ar: GROUPS[bucket].ar });

/**
 * One cell, in the reader's language.
 *
 * `col('detail_en', …)` names the English half of a pair; when the row also
 * carries `detail_ar` and the reader is reading Arabic, that is the value. A
 * column key that does not end in `_en`, or a row with no Arabic twin, is
 * returned exactly as it always was — so this changes nothing about any
 * existing report except the two that finally print the Arabic they were
 * already fetching.
 */
export const localised = (row, key, language) => {
  if (language !== 'ar' || !key.endsWith('_en')) return row[key];
  const arabic = row[`${key.slice(0, -3)}_ar`];
  return arabic === undefined || arabic === null || arabic === '' ? row[key] : arabic;
};

/**
 * Stock the shop already had on the shelf when it started using the system.
 *
 * It arrived as an `opening_balance` movement, which is a statement about what
 * was there rather than a purchase: the money for it left the shop before this
 * database existed, so no spend total can see it, and a report that silently
 * treats that as zero is telling the owner he spent less than he did. Worse
 * still when the opening cost was never typed in — then even the value of the
 * gap is unknown, and the report has to say THAT rather than print a smaller
 * number with a straight face.
 */
async function openingStockGap(db, { from, to, warehouseId }) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS movements,
           ROUND(COALESCE(SUM(m.quantity), 0), 3) AS units,
           ROUND(COALESCE(SUM(m.quantity * m.unit_cost), 0), 2) AS value,
           ROUND(COALESCE(SUM(CASE WHEN m.unit_cost <= 0 THEN m.quantity ELSE 0 END), 0), 3) AS units_without_cost
    FROM stock_movements m
    WHERE m.movement_type = 'opening_balance'
      AND date(m.created_at) BETWEEN date(?) AND date(?)
      ${warehouseId ? 'AND m.warehouse_id = ?' : ''}
  `).get(...[from, to, ...(warehouseId ? [warehouseId] : [])]);
  if (!row || !Number(row.movements)) return null;

  const priced = round2(row.value);
  const blind = Number(row.units_without_cost);
  return {
    code: 'opening_stock',
    en: `${Number(row.units)} unit(s) were entered as opening stock — goods the shop already had before it started using the system. They were paid for earlier, so that money is not in any total here.`
      + (priced > 0 ? ` The system values them at ${priced}.` : '')
      + (blind > 0 ? ` ${blind} of them carry no cost at all, so what they cost is unknown.` : ''),
    ar: `في ${Number(row.units)} قطعة اتسجلت كرصيد افتتاحي — بضاعة كانت موجودة قبل ما المحل يشتغل بالسيستيم. اتدفع تمنها قبل كده، فالفلوس دي مش موجودة في أي إجمالي هنا.`
      + (priced > 0 ? ` السيستيم مقيّمها بـ ${priced}.` : '')
      + (blind > 0 ? ` منها ${blind} قطعة من غير تكلفة خالص، يعني تمنها مش معروف.` : ''),
  };
}

/**
 * What a date window cannot contain.
 *
 * A shop that started in March has nothing before March, and a report opened
 * on an all-time range still only reaches back to the first thing anybody
 * typed. Saying the first date out loud is the difference between "the shop
 * spent nothing in 2024" and "the shop was not on this system in 2024".
 */
function coverageWarnings(firstRecord, from, to) {
  if (!firstRecord) {
    return [{
      code: 'no_records',
      en: 'There is nothing in this window at all — no purchase payment and no cost has been recorded inside it.',
      ar: 'مفيش أي حاجة في الفترة دي — لا دفعة لمورد ولا تكلفة اتسجلت جواها.',
    }];
  }
  const out = [{
    code: 'coverage',
    en: `The system's own records begin on ${firstRecord}. Anything the shop spent before that date happened outside it and cannot appear here.`,
    ar: `سجلات السيستيم بتبدأ من ${firstRecord}. أي حاجة المحل صرفها قبل التاريخ ده حصلت بره السيستيم ومش ممكن تظهر هنا.`,
  }];
  if (from > '1900-01-01' || to < '2999-12-31') {
    out.push({
      code: 'window',
      en: `This is the window ${from} to ${to}, not the shop's whole history. Clear both dates, or press "All time", for the lifetime figure.`,
      ar: `دي الفترة من ${from} لـ ${to}، مش تاريخ المحل كله. امسح التاريخين، أو اضغط «كل الفترة»، عشان تشوف الرقم من أول يوم.`,
    });
  }
  return out;
}

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
      // Renamed, not recomputed. This column has always been revenue minus the
      // cost of the goods and it still is — but it used to be called "Gross
      // profit" next to a shop owner who means something else by profit, and
      // now that the ERP knows what the shop SPENDS, leaving the old word there
      // would be the report quietly meaning two things. See `note` below.
      col('profit', 'Gross profit (before costs)', 'مجمل الربح (قبل التكاليف)', 'money'),
      col('margin_percent', 'Margin %', 'نسبة الربح', 'percent'),
    ],
    noteEn: 'Gross profit here is revenue minus the cost of the goods sold. It does not include rent, electricity, wages or any other cost — see "Profit after costs" for the figure those come off.',
    noteAr: 'مجمل الربح هنا هو الإيراد ناقص تكلفة البضاعة المباعة، ومش شامل الإيجار ولا الكهربا ولا المرتبات ولا أي تكاليف تانية — شوف تقرير «الأرباح بعد التكاليف» عشان الرقم اللي بتتخصم منه.',
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
          // Renamed from `profit` for the same reason the column above was: the
          // figure is unchanged, and a tile reading just "Profit" next to a net
          // profit on the screen behind it is the ambiguity this round exists to
          // remove. The row key stays `profit` — it is the column's identity and
          // renaming that would break a saved CSV import.
          gross_profit: round2(rows.reduce((s, r) => s + r.profit, 0)),
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

  // ------------------------------------------------- what the shop has spent
  /**
   * "انا صارف كام لحد دلوقتي علي المحل" — how much have I put into this shop.
   *
   * Three different numbers honestly answer that question, and picking one
   * without saying which is how a report stops being believed:
   *
   *   · **What left his hands.** Money actually paid: the payments recorded
   *     against purchase orders, plus every row on the costs page, wages
   *     included. A bank statement.
   *   · **What he is committed to.** That, plus goods that have ARRIVED and
   *     have not been paid for — a debt he will settle, so it is part of what
   *     the shop has cost him even while the cash is still in his pocket.
   *   · **What the stock he SOLD cost him.** That is cost of goods sold. It is
   *     a different question and `profit_and_costs` answers it. Stock bought
   *     and still on the shelf is money spent and not yet earned back, which
   *     is exactly why it belongs in this report and not in that one.
   *
   * The headline is the first: a shop owner asking "صرفت كام" means the money
   * that is gone. The second is shown BESIDE it rather than blended into it —
   * `owed_to_suppliers`, and `total_committed` for the two added up — because
   * both readings are useful and an average of them would be neither. The
   * third is deliberately absent, and the note says so in both languages.
   *
   * A purchase order that has been raised and not received is in none of the
   * three: nothing was paid, nothing arrived, and it can still be cancelled.
   * It is reported as a warning carrying its value — visible without being
   * counted.
   *
   * Every row is disjoint and the rows sum to the headline exactly. A cost
   * belongs to its category unless the category is the salary one, in which
   * case it belongs to the person it paid: `costs` and `wages` therefore
   * partition the costs ledger with nothing counted twice and nothing left
   * out, which is the same promise `salaries_paid` makes below.
   */
  shop_spend: {
    titleEn: 'Everything the shop has spent',
    titleAr: 'كل مصاريف المحل',
    module: 'costs',
    permission: 'costs.view',
    // All-time by default. The question is "how much have I put into this shop
    // since I started", not "this month" — see `defaultRange` in the catalogue.
    defaultRange: 'all',
    // "one number at the top, and under it the detail". The screen gives the
    // named summary key the accent treatment so the answer to the question is
    // not one of seven tiles that all look alike.
    headline: 'spent_cash',
    noteEn: 'Spent means money that has actually left the shop: what was paid to suppliers against purchase orders, plus everything on the costs page including wages. It is not the cost of what was sold, and it is not what the shop has been invoiced — goods that arrived and are still unpaid are shown separately as owed, and the two together are the committed figure. A purchase order raised but not yet received is neither and is not counted. Invoices kept as photographs in the paper archive are a record of what was owed before this system and are deliberately left out.',
    noteAr: 'المصروف هنا معناه الفلوس اللي خرجت من المحل فعلاً: اللي اتدفع للموردين على أوامر الشراء، وكل حاجة في صفحة التكاليف بما فيها المرتبات. مش تكلفة البضاعة اللي اتباعت، ومش اللي المحل اتحاسب عليه — البضاعة اللي وصلت ولسه متدفعتش بتتحسب لوحدها كمستحق للموردين، والاتنين مع بعض هما الإجمالي الملتزم بيه. أمر الشراء اللي اتعمل ولسه موصلش لا ده ولا ده ومش متحسب. وفواتير الورق القديمة المتصورة في أرشيفها سجل لحاجة كانت قبل السيستيم ومقصود إنها متدخلش هنا.',
    columns: [
      col('group_en', 'Where it went', 'راح فين'),
      col('detail_en', 'Detail', 'التفصيل'),
      // Payments to a supplier, entries in the costs ledger, salary payments
      // to a person — one word that is true of all three.
      col('entries', 'Entries', 'عدد العمليات', 'number'),
      col('amount', 'Amount', 'المبلغ', 'money'),
      col('share_percent', 'Share %', 'الحصة', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const db = getDb();
      const warehouseId = filters.warehouseId ? Number(filters.warehouseId) : null;

      // --- goods: what was really paid to each supplier, from the payment rows
      const paidWhere = ["p.status = 'recorded'", 'date(p.paid_on) BETWEEN date(?) AND date(?)'];
      const paidParams = [from, to];
      if (warehouseId) { paidWhere.push('po.warehouse_id = ?'); paidParams.push(warehouseId); }
      const goods = await db.prepare(`
        SELECT s.name_en, s.name_ar, COUNT(*) AS entries, ROUND(SUM(p.amount), 2) AS amount
        FROM purchase_payments p
        JOIN purchase_orders po ON po.id = p.purchase_order_id
        JOIN suppliers s ON s.id = po.supplier_id
        WHERE ${paidWhere.join(' AND ')}
        GROUP BY po.supplier_id
      `).all(...paidParams);

      // --- costs and wages, through the one filter builder every costs total
      // in this system uses. A second spelling of "costs between two dates" is
      // how the ledger and the report start disagreeing.
      const { sql, params } = costFilter({ dateFrom: from, dateTo: to, warehouseId });
      const spending = await db.prepare(`
        SELECT c.kind, c.name_en AS category_name_en, c.name_ar AS category_name_ar,
               e.name AS employee_name,
               COUNT(*) AS entries, ROUND(SUM(k.amount), 2) AS amount
        FROM costs k
        JOIN cost_categories c ON c.id = k.category_id
        LEFT JOIN employees e ON e.id = k.employee_id
        ${sql}
        GROUP BY c.id, CASE WHEN c.kind = 'salary' THEN COALESCE(k.employee_id, 0) ELSE 0 END
      `).all(...params);

      const rows = [];
      for (const row of goods) {
        rows.push({
          bucket: 'goods',
          ...groupLabels('goods'),
          detail_en: row.name_en,
          detail_ar: row.name_ar || row.name_en,
          entries: Number(row.entries),
          amount: round2(row.amount),
        });
      }
      for (const row of spending) {
        const wage = row.kind === 'salary';
        rows.push({
          bucket: wage ? 'wages' : 'costs',
          ...groupLabels(wage ? 'wages' : 'costs'),
          detail_en: wage ? (row.employee_name || 'Wages — no employee named') : row.category_name_en,
          detail_ar: wage
            ? (row.employee_name || 'مرتبات — من غير اسم موظف')
            : (row.category_name_ar || row.category_name_en),
          entries: Number(row.entries),
          amount: round2(row.amount),
        });
      }

      const totalOf = (bucket) => round2(rows
        .filter((row) => row.bucket === bucket)
        .reduce((sum, row) => sum + row.amount, 0));
      const goodsPaid = totalOf('goods');
      const costsPaid = totalOf('costs');
      const wagesPaid = totalOf('wages');
      const cash = round2(goodsPaid + costsPaid + wagesPaid);

      rows.sort((a, b) => (GROUPS[a.bucket].order - GROUPS[b.bucket].order) || (b.amount - a.amount));
      const divisor = cash || 1;
      rows.forEach((row) => { row.share_percent = round2((row.amount * 100) / divisor); });

      // --- what has arrived and is still unpaid, and what is only on order
      const arrived = await db.prepare(`
        SELECT ROUND(COALESCE(SUM(MAX(po.total_amount - po.paid_amount, 0)), 0), 2) AS owed
        FROM purchase_orders po
        WHERE po.status IN ('received', 'partially_received')
          AND date(po.order_date) BETWEEN date(?) AND date(?)
          ${warehouseId ? 'AND po.warehouse_id = ?' : ''}
      `).get(...[from, to, ...(warehouseId ? [warehouseId] : [])]);
      const onOrder = await db.prepare(`
        SELECT COUNT(*) AS orders,
               ROUND(COALESCE(SUM(MAX(po.total_amount - po.paid_amount, 0)), 0), 2) AS amount
        FROM purchase_orders po
        WHERE po.status = 'ordered'
          AND date(po.order_date) BETWEEN date(?) AND date(?)
          ${warehouseId ? 'AND po.warehouse_id = ?' : ''}
      `).get(...[from, to, ...(warehouseId ? [warehouseId] : [])]);

      const owed = round2(arrived?.owed || 0);
      const first = await db.prepare(`
        SELECT MIN(d) AS first_spend FROM (
          SELECT MIN(date(paid_on)) AS d FROM purchase_payments WHERE status = 'recorded'
          UNION ALL SELECT MIN(date(spent_on)) FROM costs
        )
      `).get();

      const warnings = [];
      const opening = await openingStockGap(db, { from, to, warehouseId });
      if (opening) warnings.push(opening);
      if (Number(onOrder?.orders || 0) > 0) {
        warnings.push({
          code: 'on_order_not_counted',
          en: `${onOrder.orders} purchase order(s) worth ${round2(onOrder.amount)} have been raised and not yet received. Nothing has been paid and nothing has arrived, so they are not in any figure above.`,
          ar: `في ${onOrder.orders} أمر شراء بقيمة ${round2(onOrder.amount)} اتعملوا ولسه موصلوش. لا اتدفع فيهم حاجة ولا وصلت بضاعة، فمش داخلين في أي رقم فوق.`,
        });
      }
      warnings.push(...coverageWarnings(first?.first_spend || null, from, to));

      return {
        rows,
        summary: {
          spent_cash: cash,
          goods_paid: goodsPaid,
          costs_paid: costsPaid,
          wages_paid: wagesPaid,
          owed_to_suppliers: owed,
          total_committed: round2(cash + owed),
          first_spend: first?.first_spend || null,
        },
        warnings,
      };
    },
  },

  // ----------------------------------------------------------------- costs
  /**
   * What the owner means by "profit".
   *
   * Everywhere else in this system profit is goods margin — revenue minus what
   * the stock cost. That is a real number and a useful one, and it is not the
   * one a shop owner is asking for when he asks whether the shop made money
   * this month, because the rent came out of it and the rent is not in it.
   *
   * This report is that question, answered: revenue, the cost of the goods, the
   * margin they left, everything else the shop spent — rent, electricity,
   * taxes, wages, the lot — and what is left. Wages appear here exactly once,
   * inside `costs`, because a salary payment is a row in the costs ledger and
   * not a copy of one.
   *
   * By month rather than by day on purpose: rent arrives once a month, and a
   * daily net profit would show the shop losing four thousand pounds on the
   * fifth of every month and making it back on the sixth.
   */
  profit_and_costs: {
    titleEn: 'Profit after costs',
    titleAr: 'الأرباح بعد التكاليف',
    module: 'costs',
    permission: 'costs.view',
    // The owner asked this one as a lifetime question too — "كل المكسب للمحل".
    // Same report, same arithmetic, opened on the shop's whole history instead
    // of the current month; every date filter still works exactly as it did.
    defaultRange: 'all',
    headline: 'net_profit',
    noteEn: 'Revenue is completed sales less anything refunded on a return. Cost of goods is what those sales cost, less the cost of items that came back resellable and went on the shelf again — items returned damaged stay a cost, because the money for them is gone. Costs is everything else the shop spent, wages included, and net profit is what is left. This is what the shop EARNED; what it has PAID OUT is a different question and "Everything the shop has spent" answers it.',
    noteAr: 'الإيراد هو المبيعات المكتملة ناقص أي حاجة اترجعت فلوسها. تكلفة البضاعة هي تكلفة المبيعات دي ناقص تكلفة الحاجات اللي رجعت سليمة ورجعت على الرف — اللي رجع تالف يفضل تكلفة لأن فلوسه راحت. والتكاليف هي كل اللي المحل صرفه غير البضاعة، والمرتبات منها، وصافي الربح هو الباقي. ده اللي المحل كسبه؛ اللي المحل دفعه سؤال تاني وبيجاوب عليه تقرير «كل مصاريف المحل».',
    columns: [
      col('month', 'Month', 'الشهر'),
      col('revenue', 'Revenue', 'الإيرادات', 'money'),
      col('refunds', 'Refunded', 'المرتجع', 'money'),
      col('cogs', 'Cost of goods', 'تكلفة البضاعة', 'money'),
      col('gross_profit', 'Gross profit', 'مجمل الربح', 'money'),
      col('costs', 'Costs', 'التكاليف', 'money'),
      col('wages', 'of which wages', 'منها المرتبات', 'money'),
      col('net_profit', 'Net profit', 'صافي الربح', 'money'),
      col('net_margin_percent', 'Net margin %', 'نسبة صافي الربح', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const db = getDb();
      const salesWhere = ["s.status = 'completed'", 'date(s.sale_date) BETWEEN date(?) AND date(?)'];
      const salesParams = [from, to];
      if (filters.warehouseId) { salesWhere.push('s.warehouse_id = ?'); salesParams.push(filters.warehouseId); }

      const sales = await db.prepare(`
        SELECT substr(s.sale_date, 1, 7) AS month,
               ROUND(SUM(s.total_amount), 2) AS revenue,
               ROUND(SUM(s.total_cost), 2)   AS cogs
        FROM sales s WHERE ${salesWhere.join(' AND ')}
        GROUP BY month
      `).all(...salesParams);

      /**
       * Refunds, and the goods that came back with them.
       *
       * A refund is money handed back over the counter: it is not revenue and
       * never was. The stock that came back is only a credit against the cost
       * of goods if it is SELLABLE — a damaged return is received and written
       * off, and the shop is out both the refund and the item, so its cost
       * stays where it is. That distinction is the whole reason the condition
       * is recorded on the line.
       */
      const returnsWhere = ['date(r.return_date) BETWEEN date(?) AND date(?)'];
      const returnsParams = [from, to];
      if (filters.warehouseId) { returnsWhere.push('r.warehouse_id = ?'); returnsParams.push(filters.warehouseId); }
      const returns = await db.prepare(`
        SELECT substr(r.return_date, 1, 7) AS month,
               ROUND(SUM(r.total_amount), 2) AS refunds
        FROM sales_returns r WHERE ${returnsWhere.join(' AND ')}
        GROUP BY month
      `).all(...returnsParams);
      const restocked = await db.prepare(`
        SELECT substr(r.return_date, 1, 7) AS month,
               ROUND(SUM(l.quantity * l.unit_cost), 2) AS cost_back
        FROM sales_return_lines l
        JOIN sales_returns r ON r.id = l.return_id
        WHERE l.condition = 'resellable' AND ${returnsWhere.join(' AND ')}
        GROUP BY month
      `).all(...returnsParams);

      const costs = await repositories.costs.byMonth({
        dateFrom: from, dateTo: to, warehouseId: filters.warehouseId || null,
      });
      // Wages are a SUBSET of the costs above, never a second helping of them:
      // a salary payment is one row in the costs ledger. The column reads "of
      // which wages" for exactly that reason.
      const { sql, params } = costFilter({
        dateFrom: from, dateTo: to, warehouseId: filters.warehouseId || null,
      });
      const wages = await db.prepare(`
        SELECT substr(k.spent_on, 1, 7) AS month, ROUND(SUM(k.amount), 2) AS amount
        FROM costs k JOIN cost_categories c ON c.id = k.category_id
        ${sql} ${sql ? 'AND' : 'WHERE'} c.kind = 'salary'
        GROUP BY month
      `).all(...params);

      const months = new Map();
      const slot = (month) => {
        if (!months.has(month)) {
          months.set(month, {
            month, revenue: 0, refunds: 0, cogs: 0, cost_back: 0,
            gross_profit: 0, costs: 0, wages: 0, net_profit: 0,
          });
        }
        return months.get(month);
      };
      for (const row of sales) {
        const entry = slot(row.month);
        entry.revenue = round2(row.revenue);
        entry.cogs = round2(row.cogs);
      }
      for (const row of returns) slot(row.month).refunds = round2(row.refunds);
      for (const row of restocked) slot(row.month).cost_back = round2(row.cost_back);
      for (const row of costs) slot(row.month).costs = round2(row.amount);
      for (const row of wages) slot(row.month).wages = round2(row.amount);

      const rows = [...months.values()]
        .map((entry) => {
          // Read across the row: revenue, less what was refunded, less what
          // the goods cost, is the gross profit. The cost of goods is already
          // net of anything that came back sellable, so the four numbers on
          // screen add up without the reader holding a fifth one in his head.
          const kept = round2(entry.revenue - entry.refunds);
          const cogs = round2(entry.cogs - entry.cost_back);
          const gross = round2(kept - cogs);
          const net = round2(gross - entry.costs);
          return {
            month: entry.month,
            revenue: entry.revenue,
            refunds: entry.refunds,
            cogs,
            gross_profit: gross,
            costs: entry.costs,
            wages: entry.wages,
            net_profit: net,
            net_margin_percent: kept > 0 ? round2((net * 100) / kept) : 0,
          };
        })
        .sort((a, b) => (a.month < b.month ? 1 : -1));

      const sum = (key) => round2(rows.reduce((total, row) => total + row[key], 0));
      const revenue = sum('revenue');
      const refunds = sum('refunds');
      const cogs = sum('cogs');
      const grossProfit = round2(revenue - refunds - cogs);
      const totalCosts = sum('costs');

      const warnings = [];
      const opening = await openingStockGap(db, {
        from, to, warehouseId: filters.warehouseId ? Number(filters.warehouseId) : null,
      });
      if (opening) {
        warnings.push({
          ...opening,
          en: `${opening.en} Anything of it that has been sold left this report no cost to subtract, so the profit above is flattered by however much it really cost.`,
          ar: `${opening.ar} أي حاجة منها اتباعت مسابتش للتقرير ده تكلفة يخصمها، فالربح فوق أكبر من الحقيقة بقيمة تكلفتها الفعلية.`,
        });
      }
      /**
       * Sold with no cost recorded. This is the gap that MATTERS in a profit
       * report: a sale line whose unit cost is zero contributes its whole
       * price to the margin, so the report is not slightly optimistic, it is
       * wrong by the true cost of that item — and it looks exactly like a very
       * profitable sale. Counting it and saying so is the only honest option;
       * guessing a cost would put a number nobody can trace into a total.
       */
      const blind = await db.prepare(`
        SELECT COUNT(*) AS lines,
               ROUND(COALESCE(SUM(l.quantity), 0), 3) AS units,
               ROUND(COALESCE(SUM(l.line_total), 0), 2) AS revenue
        FROM sale_lines l JOIN sales s ON s.id = l.sale_id
        WHERE l.unit_cost <= 0 AND ${salesWhere.join(' AND ')}
      `).get(...salesParams);
      if (Number(blind?.lines || 0) > 0) {
        warnings.push({
          code: 'sold_without_cost',
          en: `${Number(blind.units)} unit(s) across ${blind.lines} sale line(s), worth ${round2(blind.revenue)} of revenue, were sold with no cost recorded against them. Their whole price is counted as gross profit here, so the figures above are too high by whatever they actually cost.`,
          ar: `في ${Number(blind.units)} قطعة في ${blind.lines} سطر بيع، بإيراد ${round2(blind.revenue)}، اتباعت من غير ما يتسجل عليها تكلفة. تمنها كله محسوب مجمل ربح هنا، يعني الأرقام فوق أعلى من الحقيقة بقد تكلفتها الحقيقية.`,
        });
      }
      const first = await db.prepare(`
        SELECT MIN(d) AS first_record FROM (
          SELECT MIN(date(sale_date)) AS d FROM sales WHERE status = 'completed'
          UNION ALL SELECT MIN(date(spent_on)) FROM costs
        )
      `).get();
      warnings.push(...coverageWarnings(first?.first_record || null, from, to));

      return {
        rows,
        summary: {
          months: rows.length,
          revenue,
          refunds,
          cogs,
          gross_profit: grossProfit,
          costs: totalCosts,
          wages: sum('wages'),
          net_profit: round2(grossProfit - totalCosts),
        },
        warnings,
      };
    },
  },

  costs_by_category: {
    titleEn: 'Costs by Category',
    titleAr: 'التكاليف حسب البند',
    module: 'costs',
    permission: 'costs.view',
    columns: [
      col('category_name_en', 'Category', 'البند'),
      col('entries', 'Entries', 'عدد المصاريف', 'number'),
      col('amount', 'Amount', 'المبلغ', 'money'),
      col('share_percent', 'Share %', 'الحصة', 'percent'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await repositories.costs.byCategory({
        dateFrom: from, dateTo: to, warehouseId: filters.warehouseId || null,
      });
      const total = rows.reduce((sum, row) => sum + row.amount, 0) || 1;
      rows.forEach((row) => { row.share_percent = round2((row.amount * 100) / total); });
      return {
        rows,
        summary: {
          categories: rows.length,
          entries: rows.reduce((sum, row) => sum + row.entries, 0),
          costs: round2(rows.reduce((sum, row) => sum + row.amount, 0)),
        },
      };
    },
  },

  costs_ledger: {
    titleEn: 'Costs Ledger',
    titleAr: 'دفتر التكاليف',
    module: 'costs',
    permission: 'costs.view',
    columns: [
      col('spent_on', 'Date', 'التاريخ', 'date'),
      col('category_name_en', 'Category', 'البند'),
      col('branch_name_en', 'Branch', 'الفرع'),
      col('description', 'Description', 'البيان'),
      col('employee_name', 'Employee', 'الموظف'),
      col('payment_method', 'Paid by', 'طريقة الدفع'),
      col('reference', 'Reference', 'المرجع'),
      col('amount', 'Amount', 'المبلغ', 'money'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const scope = {
        dateFrom: from,
        dateTo: to,
        warehouseId: filters.warehouseId || null,
        categoryId: filters.categoryId || null,
      };
      const { sql, params } = costFilter(scope);
      const rows = await getDb().prepare(`
        SELECT k.spent_on, k.description, k.reference, k.payment_method, k.amount, k.source,
               c.name_en AS category_name_en, c.name_ar AS category_name_ar,
               w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
               e.name AS employee_name
        FROM costs k
        JOIN cost_categories c ON c.id = k.category_id
        JOIN warehouses w ON w.id = k.warehouse_id
        LEFT JOIN employees e ON e.id = k.employee_id
        ${sql}
        ORDER BY k.spent_on DESC, k.id DESC LIMIT 5000
      `).all(...params);
      return {
        rows,
        summary: {
          entries: rows.length,
          costs: round2(rows.reduce((sum, row) => sum + row.amount, 0)),
        },
      };
    },
  },

  salaries_paid: {
    titleEn: 'Salaries Paid',
    titleAr: 'المرتبات المدفوعة',
    module: 'employees',
    permission: 'employees.view',
    noteEn: 'Every line here is also a line in the costs ledger — a salary payment is a cost, stored once, so this report and the costs total never disagree.',
    noteAr: 'كل سطر هنا هو نفسه سطر في دفتر التكاليف — دفعة المرتب دي تكلفة متسجلة مرة واحدة، فالتقرير ده وإجمالي التكاليف عمرهم ما يختلفوا.',
    columns: [
      col('name', 'Employee', 'الموظف'),
      col('job_title', 'Job', 'الوظيفة'),
      col('salary_period', 'Paid every', 'الدورة'),
      col('salary_amount', 'Salary', 'المرتب', 'money'),
      col('payments', 'Payments', 'عدد الدفعات', 'number'),
      col('paid', 'Paid in period', 'المدفوع', 'money'),
      col('paid_up_to', 'Paid up to', 'مدفوع حتى', 'date'),
    ],
    run: async (filters) => {
      const { from, to } = dateRange(filters);
      const rows = await getDb().prepare(`
        SELECT e.name, e.job_title, e.salary_period, e.salary_amount,
               COUNT(k.id) AS payments,
               ROUND(COALESCE(SUM(k.amount), 0), 2) AS paid,
               MAX(k.period_end) AS paid_up_to
        FROM employees e
        LEFT JOIN costs k ON k.employee_id = e.id
             AND date(k.spent_on) BETWEEN date(?) AND date(?)
        GROUP BY e.id ORDER BY paid DESC, e.name ASC
      `).all(from, to);
      return {
        rows,
        summary: {
          employees: rows.length,
          payments: rows.reduce((sum, row) => sum + row.payments, 0),
          paid: round2(rows.reduce((sum, row) => sum + row.paid, 0)),
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
  /**
   * Which reports this person may run.
   *
   * `reports.view` is the door; a definition may name a second permission it
   * ALSO needs, and the costs and payroll reports do. That is not politeness:
   * `requirePermission` enforces the tenant's module entitlement against the
   * matched code, so a shop whose plan has no costs module must not be handed
   * its own wage bill through the report centre. The route re-checks the same
   * code before running one — this list only decides what is offered.
   */
  catalogue(permissions = []) {
    if (!permissions.includes('reports.view')) return [];
    return Object.entries(REPORTS)
      .filter(([, def]) => !def.permission || permissions.includes(def.permission))
      .map(([key, def]) => ({
        key, titleEn: def.titleEn, titleAr: def.titleAr, module: def.module,
        permission: def.permission || null,
        noteEn: def.noteEn || null, noteAr: def.noteAr || null,
        // 'all' means this report opens on the shop's whole history rather than
        // the screen's usual "this month so far". It is a property of the
        // QUESTION, not of the screen: "how much have I put into this shop"
        // has no month in it. The date filters are untouched and still work.
        defaultRange: def.defaultRange || 'month',
        headline: def.headline || null,
        columns: def.columns,
      }));
  }

  /** The extra permission a report needs beyond `reports.view`, or null. */
  permissionFor(key) {
    return REPORTS[key]?.permission || null;
  }

  async run(key, filters = {}) {
    const definition = REPORTS[key];
    if (!definition) throw new NotFoundError('Report', key);
    const { rows, summary, warnings = [] } = await definition.run(filters);
    return {
      key,
      titleEn: definition.titleEn,
      titleAr: definition.titleAr,
      module: definition.module,
      // What this report means, in the reader's language. It exists because a
      // number can change meaning without changing value: "profit" on the sales
      // summary is the same figure it always was and now sits in a system that
      // knows about rent, so the report says out loud what it does and does not
      // include rather than letting somebody assume.
      noteEn: definition.noteEn || null,
      noteAr: definition.noteAr || null,
      defaultRange: definition.defaultRange || 'month',
      /** The one summary key that IS the answer, when a report has one. */
      headline: definition.headline || null,
      /**
       * What this particular RUN could not see, in both languages.
       *
       * The note above is fixed and describes the report; these are computed
       * from the data and describe this answer — stock the shop had before it
       * had a system, items sold with no cost recorded, the date its records
       * actually begin. They exist because the alternative is a total that
       * quietly treats missing data as zero, which is a number the owner will
       * one day discover was never true, and after that he does not believe
       * any of the others either.
       */
      warnings,
      columns: definition.columns,
      filters,
      generatedAt: new Date().toISOString(),
      rows,
      summary,
    };
  }

  /**
   * CSV with a BOM so Excel opens Arabic text correctly.
   *
   * A column whose key ends in `_en` is a bilingual pair: the row carries the
   * `_ar` twin beside it, and an Arabic export takes that instead. Reports
   * have shipped both halves for a while — `costs_ledger` selects
   * `category_name_ar` and has never printed it — so this is the one place
   * that reads the half that was already there, and the report screen does
   * the same thing for the same keys.
   */
  toCsv(report, language = 'en') {
    const headers = report.columns.map((c) => (language === 'ar' ? c.labelAr : c.labelEn));
    const value = (row, column) => localised(row, column.key, language);
    const escape = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [headers.map(escape).join(',')];
    for (const row of report.rows) {
      lines.push(report.columns.map((c) => escape(value(row, c))).join(','));
    }
    return `﻿${lines.join('\n')}`;
  }
}

export const reportService = new ReportService();
export default reportService;
