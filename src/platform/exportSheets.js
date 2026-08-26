/**
 * The half of a backup that a person reads.
 *
 * A snapshot is complete and unreadable: forty-eight tables of ids, in the
 * shape the database wants. This turns the same pass over the same rows into
 * two workbooks — one Arabic, one English — with fifteen tabs, foreign keys
 * resolved into the names they stand for, and every column headed with the word
 * the ERP itself uses for it. That last part is what makes it usable: an owner
 * who reads "الإجمالي" on the sales screen must read "الإجمالي" in the
 * spreadsheet, not "total_amount".
 *
 * ── Fed, not queried ─────────────────────────────────────────────────────────
 * Nothing here opens a database. `feed()` is called with batches of rows read
 * out of a STORED SNAPSHOT, when somebody downloads it — never out of the live
 * shop. Two things follow from that, and both are the point:
 *
 *   - a spreadsheet is a picture of the shop at the moment its backup was
 *     taken, which is the only thing "download this backup" can honestly mean;
 *   - building one costs a shop's database nothing at all, so the owner asking
 *     for his data twice in an afternoon is not felt by anyone at a till.
 *
 * See `BackupService.buildDownload`, and the measurement there explaining why
 * these workbooks are built on the way out rather than kept.
 *
 * ── What is left out, on purpose ─────────────────────────────────────────────
 * Password hashes, password-reset tokens, the audit log's before/after
 * documents, and the photographs. The snapshot has all of them, because a
 * restore that cannot sign anybody in is not a restore. The workbook has none,
 * because it is the copy that gets emailed, opened on a phone and forwarded —
 * and a bcrypt hash in a spreadsheet is an offline password-cracking exercise
 * somebody has been handed for free.
 *
 * ── Bounded ──────────────────────────────────────────────────────────────────
 * Every sheet stops at `MAX_SHEET_ROWS` and says so in its own last row rather
 * than silently ending. The snapshot beside it is always complete, so nothing
 * is lost — only the readable copy is abridged, which is the correct trade for
 * a file that has to be built inside a function's memory limit.
 */
import { buildWorkbook, MAX_SHEET_ROWS } from '../shared/workbook.js';
import { offerRunning, offerPrice } from '../shared/pricing.js';

/** How many rows one lookup map may hold before it stops learning names. */
const MAX_LOOKUP = Number(process.env.MM_EXPORT_MAX_LOOKUP || 250_000);

/** `2026-08-23T05:04:00.000Z` reads better as `2026-08-23 05:04`. */
function stamp(value) {
  if (!value) return '';
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text);
  if (match) return `${match[1]} ${match[2]}`;
  return text.slice(0, 10);
}

const day = (value) => (value ? String(value).slice(0, 10) : '');

/**
 * The handful of values stored as English codes, in the words the ERP's own
 * screens use for them.
 *
 * This is what "the columns named the way the ERP names them" means once it
 * reaches the cells: a shop owner who reads "مكتمل" on the Sales screen must
 * read "مكتمل" in the spreadsheet, not "completed". The wording is copied from
 * `public/js/core/i18n.js` rather than invented here, so the two agree.
 *
 * A code with no entry is passed through unchanged — an unknown status is
 * better shown raw than blanked or guessed at.
 */
const WORDS = {
  // sales.status / purchase_orders.status / stock_adjustments.status
  completed: ['Completed', 'مكتمل'],
  void: ['Void', 'ملغاة'],
  draft: ['Draft', 'مسودة'],
  cancelled: ['Cancelled', 'ملغي'],
  posted: ['Posted', 'مُرحَّل'],
  approved: ['Approved', 'معتمد'],
  ordered: ['Ordered', 'تم الطلب'],
  received: ['Received', 'تم الاستلام'],
  partial: ['Partial', 'جزئي'],
  paid: ['Paid', 'مدفوع'],
  unpaid: ['Unpaid', 'غير مدفوع'],
  // products.gender
  women: ['Women', 'حريمي'],
  men: ['Men', 'رجالي'],
  unisex: ['Unisex', 'للجنسين'],
  // payment methods
  cash: ['Cash', 'نقدًا'],
  card: ['Card', 'بطاقة'],
  transfer: ['Bank transfer', 'تحويل بنكي'],
  store_credit: ['Store credit', 'رصيد بالمتجر'],
  // web_orders.status
  pending: ['New', 'جديد'],
  accepted: ['Accepted', 'تم القبول'],
  out_for_delivery: ['Out for delivery', 'قيد التوصيل'],
  delivered: ['Delivered', 'تم التسليم'],
  not_received: ['Not received', 'لم يتم الاستلام'],
  // stock_movements.movement_type
  purchase_receipt: ['Goods received', 'استلام بضاعة'],
  sale: ['Sale', 'بيع'],
  sale_return: ['Sales return', 'مرتجع بيع'],
  purchase_return: ['Returned to supplier', 'مرتجع للمورّد'],
  adjustment: ['Adjustment', 'تسوية'],
  opening_balance: ['Opening balance', 'رصيد افتتاحي'],
  write_off: ['Write-off', 'إهلاك'],
  // employees.salary_period
  day: ['Daily', 'يومي'],
  week: ['Weekly', 'أسبوعي'],
  month: ['Monthly', 'شهري'],
  // customers.customer_group
  retail: ['Retail', 'قطاعي'],
  wholesale: ['Wholesale', 'جملة'],
};

/**
 * An offer, in one cell: "20% off, to 30 Aug" or "100 off". Empty when there is
 * none, so the column is quiet on the vast majority of rows.
 *
 * A date is written as it is stored — a plain day — rather than formatted:
 * this cell is read beside a price, not parsed, and a shop comparing two
 * exports wants the same characters both times.
 */
function offerWord(product, lang) {
  const type = String(product?.discount_type || 'none');
  const value = Number(product?.discount_value || 0);
  if ((type !== 'percent' && type !== 'amount') || !(value > 0)) return '';
  const head = type === 'percent'
    ? (lang === 'ar' ? `خصم ${value}٪` : `${value}% off`)
    : (lang === 'ar' ? `خصم ${value}` : `${value} off`);
  const from = product.discount_starts_on || null;
  const to = product.discount_ends_on || null;
  if (from && to) return `${head} (${from} → ${to})`;
  if (to) return `${head} (→ ${to})`;
  if (from) return `${head} (${from} →)`;
  return head;
}

const word = (value, lang) => {
  if (value === null || value === undefined || value === '') return '';
  const entry = WORDS[String(value)];
  if (!entry) return value;
  return lang === 'ar' ? entry[1] : entry[0];
};
const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const yes = (value, lang) => (value ? (lang === 'ar' ? 'نعم' : 'Yes') : (lang === 'ar' ? 'لا' : 'No'));

/**
 * The sheets, and the words on them.
 *
 * `name` and every `label` carry both languages, so one definition produces
 * both workbooks and the two can never drift apart — an English column that
 * quietly gains a sibling with no Arabic is the failure this shape prevents.
 */
const SHEETS = [
  {
    key: 'products',
    name: { en: 'Products', ar: 'المنتجات' },
    labels: [
      ['SKU', 'الكود'], ['Barcode', 'الباركود'], ['Product', 'المنتج'],
      ['Variant', 'النوع'], ['Brand', 'العلامة التجارية'], ['Category', 'الفئة'],
      ['Supplier', 'المورد'], ['Unit', 'الوحدة'], ['Cost', 'التكلفة'],
      ['Selling price', 'سعر البيع'], ['Wholesale', 'سعر الجملة'],
      ['On hand', 'الرصيد'], ['Reorder level', 'حد إعادة الطلب'], ['Active', 'مفعّل'],
      // Round 14. Appended rather than inserted: a shop opens last month's
      // workbook beside this month's, and a column that moved is a column two
      // spreadsheets disagree about.
      ['For', 'لمين'], ['Offer', 'العرض'], ['Offer price', 'سعر العرض'],
    ],
  },
  {
    key: 'stock',
    name: { en: 'Stock', ar: 'المخزون' },
    labels: [
      ['SKU', 'الكود'], ['Product', 'المنتج'], ['Location', 'المخزن'],
      ['On hand', 'الرصيد'], ['Reserved', 'محجوز'], ['Average cost', 'متوسط التكلفة'],
    ],
  },
  {
    key: 'customers',
    name: { en: 'Clients', ar: 'العملاء' },
    labels: [
      ['Code', 'الكود'], ['Name', 'الاسم'], ['Phone', 'الهاتف'], ['Email', 'البريد'],
      ['City', 'المدينة'], ['Address', 'العنوان'], ['Group', 'المجموعة'],
      ['Balance', 'الرصيد'], ['Loyalty points', 'نقاط الولاء'], ['Active', 'مفعّل'],
      ['Created', 'تاريخ الإنشاء'],
    ],
  },
  {
    key: 'sales',
    name: { en: 'Sales', ar: 'المبيعات' },
    labels: [
      ['Invoice', 'رقم الفاتورة'], ['Date', 'التاريخ'], ['Status', 'الحالة'],
      ['Client', 'العميل'], ['Location', 'المخزن'], ['Subtotal', 'الإجمالي قبل الخصم'],
      ['Discount', 'الخصم'], ['Tax', 'الضريبة'], ['Total', 'الإجمالي'],
      ['Cost of goods', 'تكلفة البضاعة'], ['Profit', 'الربح'], ['Paid', 'المدفوع'],
      ['Payment method', 'طريقة الدفع'], ['Cashier', 'الكاشير'],
    ],
  },
  {
    key: 'saleLines',
    name: { en: 'Sale lines', ar: 'بنود المبيعات' },
    labels: [
      ['Invoice', 'رقم الفاتورة'], ['Date', 'التاريخ'], ['SKU', 'الكود'],
      ['Description', 'الصنف'], ['Quantity', 'الكمية'], ['Returned', 'المرتجع'],
      ['Unit price', 'سعر الوحدة'], ['Was', 'السعر قبل العرض'],
      ['Discount', 'الخصم'], ['Tax', 'الضريبة'],
      ['Line total', 'إجمالي البند'],
    ],
  },
  {
    key: 'returns',
    name: { en: 'Returns', ar: 'المرتجعات' },
    labels: [
      ['Return no.', 'رقم المرتجع'], ['Date', 'التاريخ'], ['Invoice', 'رقم الفاتورة'],
      ['Client', 'العميل'], ['Type', 'النوع'], ['Total', 'الإجمالي'],
      ['Restocking fee', 'رسوم الإرجاع'], ['Refund method', 'طريقة الاسترداد'],
      ['Reason', 'السبب'],
    ],
  },
  {
    key: 'purchases',
    name: { en: 'Purchase orders', ar: 'أوامر الشراء' },
    labels: [
      ['PO number', 'رقم الأمر'], ['Date', 'التاريخ'], ['Supplier', 'المورد'],
      ['Status', 'الحالة'], ['Subtotal', 'الإجمالي قبل الضريبة'], ['Tax', 'الضريبة'],
      ['Shipping', 'الشحن'], ['Total', 'الإجمالي'], ['Paid', 'المدفوع'],
    ],
  },
  {
    key: 'purchaseLines',
    name: { en: 'Purchase lines', ar: 'بنود الشراء' },
    labels: [
      ['PO number', 'رقم الأمر'], ['SKU', 'الكود'], ['Product', 'المنتج'],
      ['Ordered', 'المطلوب'], ['Received', 'المستلم'], ['Unit cost', 'تكلفة الوحدة'],
      ['Line total', 'إجمالي البند'],
    ],
  },
  {
    key: 'suppliers',
    name: { en: 'Suppliers', ar: 'الموردون' },
    labels: [
      ['Code', 'الكود'], ['Name', 'الاسم'], ['Contact', 'مسؤول التواصل'],
      ['Phone', 'الهاتف'], ['Email', 'البريد'], ['City', 'المدينة'],
      ['Payment terms (days)', 'مهلة السداد (يوم)'], ['Opening balance', 'الرصيد الافتتاحي'],
      ['Active', 'مفعّل'],
    ],
  },
  {
    key: 'costs',
    name: { en: 'Costs', ar: 'التكاليف' },
    labels: [
      ['Date', 'التاريخ'], ['Category', 'البند'], ['Description', 'الوصف'],
      ['Amount', 'المبلغ'], ['Payment method', 'طريقة الدفع'], ['Reference', 'المرجع'],
      ['Employee', 'الموظف'], ['Location', 'المخزن'],
    ],
  },
  {
    key: 'employees',
    name: { en: 'Employees', ar: 'الموظفون' },
    labels: [
      ['Code', 'الكود'], ['Name', 'الاسم'], ['Job title', 'الوظيفة'], ['Phone', 'الهاتف'],
      ['Salary', 'المرتب'], ['Period', 'الدورة'], ['Location', 'المخزن'],
      ['Hired', 'تاريخ التعيين'], ['Active', 'مفعّل'],
    ],
  },
  {
    key: 'webOrders',
    name: { en: 'Web orders', ar: 'طلبات الموقع' },
    labels: [
      ['Order no.', 'رقم الطلب'], ['Date', 'التاريخ'], ['Client', 'العميل'],
      ['Phone', 'الهاتف'], ['City', 'المدينة'], ['Status', 'الحالة'],
      ['Subtotal', 'الإجمالي قبل التوصيل'], ['Delivery', 'التوصيل'],
      ['Total', 'الإجمالي'], ['Invoice', 'رقم الفاتورة'],
    ],
  },
  {
    key: 'movements',
    name: { en: 'Stock movements', ar: 'حركة المخزون' },
    labels: [
      ['Date', 'التاريخ'], ['SKU', 'الكود'], ['Product', 'المنتج'], ['Location', 'المخزن'],
      ['Type', 'نوع الحركة'], ['Quantity', 'الكمية'], ['Balance after', 'الرصيد بعدها'],
      ['Reference', 'المرجع'],
    ],
  },
  {
    key: 'promotions',
    name: { en: 'Promotions', ar: 'العروض' },
    labels: [
      ['Code', 'الكود'], ['Name', 'الاسم'], ['Kind', 'النوع'], ['Discount', 'الخصم'],
      ['Starts', 'يبدأ'], ['Ends', 'ينتهي'], ['Used', 'مرات الاستخدام'], ['Active', 'مفعّل'],
    ],
  },
  {
    key: 'users',
    name: { en: 'Users', ar: 'المستخدمون' },
    labels: [
      ['Username', 'اسم المستخدم'], ['Full name', 'الاسم'], ['Role', 'الدور'],
      ['Email', 'البريد'], ['Active', 'مفعّل'], ['Last signed in', 'آخر دخول'],
    ],
  },
];

const TRUNCATED = {
  en: '… this sheet stops here. The full data is in the snapshot beside it.',
  ar: '… الجدول يتوقف هنا. البيانات كاملة موجودة في النسخة القابلة للاستعادة بجواره.',
};

/**
 * Collects what the workbooks need while the snapshot streams past.
 *
 * Two kinds of state, and the difference matters for memory: LOOKUPS (a brand's
 * name by its id) which are small and kept for the whole run, and ROWS (a sheet's
 * finished lines) which are capped. Neither ever holds a photograph or a hash.
 */
export class SheetCollector {
  #rows = new Map();

  #over = new Set();

  #lookup = {
    brands: new Map(),
    categories: new Map(),
    suppliers: new Map(),
    warehouses: new Map(),
    users: new Map(),
    roles: new Map(),
    customers: new Map(),
    employees: new Map(),
    costCategories: new Map(),
    products: new Map(),
    variants: new Map(),
    sales: new Map(),
    purchaseOrders: new Map(),
    stockByVariant: new Map(),
  };

  constructor(lang) {
    this.lang = lang === 'ar' ? 'ar' : 'en';
    for (const sheet of SHEETS) this.#rows.set(sheet.key, []);
  }

  /** Bilingual pick, used everywhere a row carries `name_en` and `name_ar`. */
  #pick(row, base = 'name') {
    const ar = row[`${base}_ar`];
    const en = row[`${base}_en`];
    return (this.lang === 'ar' ? (ar || en) : (en || ar)) || '';
  }

  #remember(map, key, value) {
    if (map.size >= MAX_LOOKUP) return;
    map.set(key, value);
  }

  #push(key, row) {
    const rows = this.#rows.get(key);
    if (!rows) return;
    if (rows.length >= MAX_SHEET_ROWS) { this.#over.add(key); return; }
    rows.push(row);
  }

  /** True when this table appears in a sheet or feeds one — see `handles`. */
  static handles(table) {
    return typeof SheetCollector.prototype[`_${table}`] === 'function';
  }

  /** One batch of one table, exactly as the snapshot read it. */
  feed(table, columns, batch) {
    const handler = this[`_${table}`];
    if (typeof handler !== 'function') return;
    for (const row of batch) handler.call(this, row);
  }

  // ------------------------------------------------------------- dimensions

  _brands(row) { this.#remember(this.#lookup.brands, row.id, this.#pick(row)); }

  _categories(row) { this.#remember(this.#lookup.categories, row.id, this.#pick(row)); }

  _warehouses(row) { this.#remember(this.#lookup.warehouses, row.id, this.#pick(row)); }

  _roles(row) { this.#remember(this.#lookup.roles, row.id, this.#pick(row)); }

  _cost_categories(row) { this.#remember(this.#lookup.costCategories, row.id, this.#pick(row)); }

  _suppliers(row) {
    this.#remember(this.#lookup.suppliers, row.id, this.#pick(row));
    this.#push('suppliers', [
      row.code, this.#pick(row), row.contact_person, row.phone, row.email, row.city,
      num(row.payment_terms_days), num(row.opening_balance), yes(row.is_active, this.lang),
    ]);
  }

  _users(row) {
    this.#remember(this.#lookup.users, row.id, row.full_name || row.username);
    // Never `password_hash`, and never the lock-out counters. See the file head.
    this.#push('users', [
      row.username, row.full_name, this.#lookup.roles.get(row.role_id) || '',
      row.email, yes(row.is_active, this.lang), stamp(row.last_login_at),
    ]);
  }

  _customers(row) {
    this.#remember(this.#lookup.customers, row.id, row.name);
    this.#push('customers', [
      row.code, row.name, row.phone, row.email, row.city, row.address,
      word(row.customer_group, this.lang),
      num(row.balance), num(row.loyalty_points), yes(row.is_active, this.lang), day(row.created_at),
    ]);
  }

  _employees(row) {
    this.#remember(this.#lookup.employees, row.id, row.name);
    this.#push('employees', [
      row.code, row.name, row.job_title, row.phone, num(row.salary_amount),
      word(row.salary_period, this.lang),
      this.#lookup.warehouses.get(row.warehouse_id) || '', day(row.hired_on),
      yes(row.is_active, this.lang),
    ]);
  }

  _products(row) {
    this.#remember(this.#lookup.products, row.id, {
      name: this.#pick(row),
      brand: this.#lookup.brands.get(row.brand_id) || '',
      category: this.#lookup.categories.get(row.category_id) || '',
      supplier: this.#lookup.suppliers.get(row.supplier_id) || '',
      unit: row.unit,
      gender: row.gender || 'unisex',
      discount_type: row.discount_type || 'none',
      discount_value: Number(row.discount_value || 0),
      discount_starts_on: row.discount_starts_on || null,
      discount_ends_on: row.discount_ends_on || null,
    });
  }

  _product_variants(row) {
    const product = this.#lookup.products.get(row.product_id) || {};
    this.#remember(this.#lookup.variants, row.id, { sku: row.sku, product: product.name || '' });
    this.#push('products', [
      row.sku, row.barcode, product.name || '', row.variant_label, product.brand || '',
      product.category || '', product.supplier || '', product.unit || '',
      num(row.cost_price), num(row.selling_price), num(row.wholesale_price),
      // Filled in by `finish()`: stock_levels is read long after this row.
      { stockFor: row.id },
      num(row.reorder_level), yes(row.is_active, this.lang),
      word(product.gender || 'unisex', this.lang),
      offerWord(product, this.lang),
      // What it actually sells for today, so the sheet answers the question
      // rather than making the reader apply a percentage by hand.
      offerRunning(product) ? num(offerPrice(row.selling_price, product).price) : '',
    ]);
  }

  // -------------------------------------------------------------- documents

  _promotions(row) {
    this.#push('promotions', [
      row.code, this.#pick(row), row.kind,
      row.discount_type === 'percentage' ? `${num(row.value)}%` : num(row.value),
      day(row.starts_at), day(row.ends_at), num(row.usage_count),
      yes(row.is_active, this.lang),
    ]);
  }

  _sales(row) {
    this.#remember(this.#lookup.sales, row.id, { invoice: row.invoice_no, date: row.sale_date });
    const total = Number(row.total_amount || 0);
    const cost = Number(row.total_cost || 0);
    this.#push('sales', [
      row.invoice_no, day(row.sale_date), word(row.status, this.lang),
      this.#lookup.customers.get(row.customer_id) || '',
      this.#lookup.warehouses.get(row.warehouse_id) || '',
      num(row.subtotal), num(row.discount_amount), num(row.tax_amount), total, cost,
      Math.round((total - Number(row.tax_amount || 0) - cost) * 100) / 100,
      num(row.paid_amount), word(row.payment_method, this.lang),
      this.#lookup.users.get(row.created_by) || '',
    ]);
  }

  _sale_lines(row) {
    const sale = this.#lookup.sales.get(row.sale_id) || {};
    this.#push('saleLines', [
      sale.invoice || '', day(sale.date), row.sku, row.description,
      num(row.quantity), num(row.returned_quantity), num(row.unit_price),
      // Blank rather than zero when there was no offer: a column of zeroes
      // reads as "everything was free before", which is worse than a gap.
      Number(row.list_price) > 0 ? num(row.list_price) : '',
      num(row.discount_amount), num(row.tax_amount), num(row.line_total),
    ]);
  }

  _sales_returns(row) {
    this.#push('returns', [
      row.return_no, day(row.return_date), row.invoice_no,
      this.#lookup.customers.get(row.customer_id) || '', word(row.return_type, this.lang),
      num(row.total_amount), num(row.restocking_fee), word(row.refund_method, this.lang),
      row.reason_note || row.reason_code,
    ]);
  }

  _purchase_orders(row) {
    this.#remember(this.#lookup.purchaseOrders, row.id, row.po_number);
    this.#push('purchases', [
      row.po_number, day(row.order_date), this.#lookup.suppliers.get(row.supplier_id) || '',
      word(row.status, this.lang), num(row.subtotal), num(row.tax_amount), num(row.shipping_amount),
      num(row.total_amount), num(row.paid_amount),
    ]);
  }

  _purchase_order_lines(row) {
    const variant = this.#lookup.variants.get(row.variant_id) || {};
    this.#push('purchaseLines', [
      this.#lookup.purchaseOrders.get(row.purchase_order_id) || '', variant.sku || '',
      variant.product || '', num(row.quantity_ordered), num(row.quantity_received),
      num(row.unit_cost), num(row.line_total),
    ]);
  }

  _costs(row) {
    this.#push('costs', [
      day(row.spent_on), this.#lookup.costCategories.get(row.category_id) || '',
      row.description, num(row.amount), word(row.payment_method, this.lang), row.reference,
      this.#lookup.employees.get(row.employee_id) || '',
      this.#lookup.warehouses.get(row.warehouse_id) || '',
    ]);
  }

  _web_orders(row) {
    this.#push('webOrders', [
      row.order_no, day(row.created_at), row.customer_name, row.customer_phone,
      row.address_city, word(row.status, this.lang), num(row.subtotal), num(row.delivery_fee),
      num(row.total_amount), this.#lookup.sales.get(row.sale_id)?.invoice || '',
    ]);
  }

  _stock_levels(row) {
    const variant = this.#lookup.variants.get(row.variant_id) || {};
    // A variant can sit in several locations; the products sheet shows the sum.
    const stock = this.#lookup.stockByVariant;
    const running = stock.get(row.variant_id);
    if (running !== undefined || stock.size < MAX_LOOKUP) {
      stock.set(row.variant_id, (running || 0) + Number(row.quantity || 0));
    }
    this.#push('stock', [
      variant.sku || '', variant.product || '',
      this.#lookup.warehouses.get(row.warehouse_id) || '',
      num(row.quantity), num(row.reserved_quantity), num(row.average_cost),
    ]);
  }

  _stock_movements(row) {
    const variant = this.#lookup.variants.get(row.variant_id) || {};
    this.#push('movements', [
      stamp(row.created_at), variant.sku || '', variant.product || '',
      this.#lookup.warehouses.get(row.warehouse_id) || '', word(row.movement_type, this.lang),
      num(row.quantity), num(row.balance_after), row.reference_no || row.reference_type,
    ]);
  }

  /**
   * The finished sheets.
   *
   * The one deferred value — a variant's stock — is resolved here, because
   * `stock_levels` is read long after `product_variants` and a spreadsheet that
   * said "0 in stock" for everything would be worse than one that said nothing.
   */
  sheets() {
    return SHEETS.map((sheet) => {
      const rows = this.#rows.get(sheet.key).map((row) => row.map((value) => (
        value && typeof value === 'object' && 'stockFor' in value
          ? (this.#lookup.stockByVariant.get(value.stockFor) ?? 0)
          : value
      )));
      if (this.#over.has(sheet.key)) {
        rows.push([TRUNCATED[this.lang]]);
      }
      return {
        name: sheet.name[this.lang],
        columns: sheet.labels.map(([en, ar]) => ({ label: this.lang === 'ar' ? ar : en })),
        rows,
      };
    });
  }

  /** True when at least one sheet hit the ceiling — the manifest records it. */
  get truncated() {
    return [...this.#over];
  }

  workbook() {
    return buildWorkbook(this.sheets(), { rtl: this.lang === 'ar' });
  }
}

/**
 * One collector per language, fed from one pass.
 *
 * Two objects rather than one that emits both, because the Arabic workbook is
 * not a translation of the English one at render time — it picks `name_ar` all
 * the way down, so the two carry different values and not only different
 * headings.
 */
export class WorkbookBuilder {
  constructor() {
    this.collectors = [new SheetCollector('en'), new SheetCollector('ar')];
  }

  /**
   * Whether any sheet is built from this table.
   *
   * The caller asks BEFORE parsing a snapshot part, which is the whole point:
   * `product_images` is the largest table in a shop with photographs and no
   * sheet is made from it, so its megabytes of base64 are copied into the
   * download without ever becoming JavaScript objects.
   */
  // eslint-disable-next-line class-methods-use-this
  handles(table) {
    return SheetCollector.handles(table);
  }

  feed(table, columns, batch) {
    for (const collector of this.collectors) collector.feed(table, columns, batch);
  }

  async workbooks() {
    const out = [];
    for (const collector of this.collectors) {
      out.push({
        lang: collector.lang,
        bytes: await collector.workbook(),
        truncated: collector.truncated,
      });
    }
    return out;
  }
}

export default { SheetCollector, WorkbookBuilder, SHEETS };
