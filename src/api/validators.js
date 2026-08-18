/** Request schemas. Kept in one place so the API contract is easy to review. */
import { z } from 'zod';

const optionalString = z.string().trim().max(500).optional().nullable();
const money = z.coerce.number().min(0).default(0);
const id = z.coerce.number().int().positive();

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const supplierSchema = z.object({
  code: optionalString,
  name_en: z.string().trim().min(1, 'Supplier name is required'),
  name_ar: optionalString,
  contact_person: optionalString,
  phone: optionalString,
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  address: optionalString,
  city: optionalString,
  country: optionalString,
  tax_number: optionalString,
  payment_terms_days: z.coerce.number().int().min(0).default(0),
  credit_limit: money,
  opening_balance: z.coerce.number().default(0),
  lead_time_days: z.coerce.number().int().min(0).default(7),
  notes: optionalString,
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const brandSchema = z.object({
  code: optionalString,
  name_en: z.string().trim().min(1, 'Brand name is required'),
  name_ar: optionalString,
  description: optionalString,
  country: optionalString,
  supplier_id: id.optional().nullable(),
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const categorySchema = z.object({
  code: optionalString,
  name_en: z.string().trim().min(1, 'Category name is required'),
  name_ar: optionalString,
  parent_id: id.optional().nullable(),
  description: optionalString,
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const warehouseSchema = z.object({
  code: optionalString,
  name_en: z.string().trim().min(1, 'Location name is required'),
  name_ar: optionalString,
  address: optionalString,
  phone: optionalString,
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const customerSchema = z.object({
  code: optionalString,
  name: z.string().trim().min(1, 'Customer name is required'),
  phone: optionalString,
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  address: optionalString,
  city: optionalString,
  customer_group: z.enum(['retail', 'wholesale', 'vip']).default('retail'),
  tax_number: optionalString,
  credit_limit: money,
  notes: optionalString,
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const attributeSchema = z.object({
  code: optionalString,
  name_en: z.string().trim().min(1, 'Attribute name is required'),
  name_ar: optionalString,
  input_type: z.enum(['select', 'color']).default('select'),
  display_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const attributeValueSchema = z.object({
  code: z.string().trim().min(1, 'Value code is required').transform((v) => v.toUpperCase()),
  value_en: z.string().trim().min(1, 'Value is required'),
  value_ar: optionalString,
  color_hex: optionalString,
  display_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
});

export const productSchema = z.object({
  sku_prefix: z.string().trim().min(2, 'SKU prefix is required'),
  name_en: z.string().trim().min(1, 'Product name is required'),
  name_ar: optionalString,
  description_en: optionalString,
  description_ar: optionalString,
  brand_id: id.optional().nullable(),
  category_id: id.optional().nullable(),
  supplier_id: id.optional().nullable(),
  unit: z.string().trim().default('piece'),
  tax_rate: z.coerce.number().min(0).max(100).default(0),
  base_cost: money,
  base_price: money,
  track_inventory: z.coerce.boolean().default(true),
  tags: optionalString,
  is_active: z.coerce.boolean().default(true),
  // Website visibility, and the customer-facing copy that goes with it.
  // Kept separate from the internal description so staff can write for
  // shoppers without disturbing their own notes.
  is_published: z.coerce.boolean().default(false),
  web_description_en: optionalString,
  web_description_ar: optionalString,
  attribute_ids: z.array(id).default([]),
  // May be empty: a product with no attributes gets one default variant made
  // for it, because stock, sales and labels are always keyed to a variant.
  variants: z.array(z.object({
    id: id.optional().nullable(),
    sku: optionalString,
    barcode: optionalString,
    variant_label: optionalString,
    cost_price: money,
    selling_price: money,
    wholesale_price: money.optional(),
    reorder_level: z.coerce.number().min(0).default(0),
    reorder_quantity: z.coerce.number().min(0).default(0),
    is_active: z.coerce.boolean().default(true),
    options: z.array(z.object({
      attribute_id: id,
      attribute_value_id: id,
    })).default([]),
  })).default([]),
});

export const purchaseOrderSchema = z.object({
  supplier_id: id,
  warehouse_id: id.optional().nullable(),
  order_date: z.string().trim().min(1),
  expected_date: optionalString,
  discount_amount: money,
  shipping_amount: money,
  notes: optionalString,
  status: z.enum(['draft', 'ordered']).optional(),
  lines: z.array(z.object({
    variant_id: id,
    quantity_ordered: z.coerce.number().positive(),
    unit_cost: money,
    discount_percent: z.coerce.number().min(0).max(100).default(0),
    tax_rate: z.coerce.number().min(0).max(100).default(0),
    notes: optionalString,
  })).min(1, 'Add at least one line'),
});

export const receiveSchema = z.object({
  receipts: z.array(z.object({
    line_id: id,
    quantity: z.coerce.number().min(0),
  })).min(1),
  notes: optionalString,
});

export const saleSchema = z.object({
  customer_id: id.optional().nullable(),
  warehouse_id: id.optional().nullable(),
  sale_date: optionalString,
  promotion_code: optionalString,
  manual_discount: money,
  loyalty_redeem_points: z.coerce.number().min(0).default(0),
  payment_method: z.enum(['cash', 'card', 'transfer', 'wallet', 'credit', 'mixed']).default('cash'),
  paid_amount: z.coerce.number().min(0).optional(),
  payments: z.array(z.object({
    amount: z.coerce.number().min(0),
    method: z.enum(['cash', 'card', 'transfer', 'wallet', 'credit']).default('cash'),
    reference: optionalString,
  })).optional(),
  notes: optionalString,
  lines: z.array(z.object({
    key: z.union([z.string(), z.number()]).optional(),
    variant_id: id,
    quantity: z.coerce.number().positive(),
    unit_price: z.coerce.number().min(0).optional().nullable(),
    discount_percent: z.coerce.number().min(0).max(100).default(0),
    discount_amount: money,
  })).min(1, 'The sale has no items'),
});

export const returnSchema = z.object({
  return_type: z.enum(['with_receipt', 'no_receipt']).default('with_receipt'),
  sale_id: id.optional().nullable(),
  invoice_no: optionalString,
  customer_id: id.optional().nullable(),
  reason_code: z.enum([
    'defective', 'wrong_item', 'wrong_size', 'not_as_described',
    'changed_mind', 'damaged_in_transit', 'duplicate', 'other',
  ]).default('other'),
  reason_note: optionalString,
  refund_method: z.enum(['cash', 'card', 'transfer', 'wallet', 'store_credit', 'account']).default('cash'),
  restocking_fee: money,
  lines: z.array(z.object({
    sale_line_id: id.optional().nullable(),
    variant_id: id.optional().nullable(),
    quantity: z.coerce.number().min(0),
    condition: z.enum(['resellable', 'damaged']).default('resellable'),
    notes: optionalString,
  })).min(1, 'Select at least one item to return'),
}).refine(
  (data) => data.return_type === 'no_receipt' || Boolean(data.sale_id || data.invoice_no),
  { message: 'An invoice is required for a receipted return', path: ['invoice_no'] },
);

export const promotionSchema = z.object({
  code: z.string().trim().min(2, 'Code is required'),
  name_en: z.string().trim().min(1, 'Name is required'),
  name_ar: optionalString,
  kind: z.enum(['discount', 'voucher']).default('discount'),
  discount_type: z.enum(['percentage', 'fixed']).default('percentage'),
  value: z.coerce.number().min(0),
  scope: z.enum(['order', 'product', 'category', 'brand']).default('order'),
  min_order_amount: money,
  max_discount_amount: money,
  voucher_balance: money.optional(),
  starts_at: optionalString,
  ends_at: optionalString,
  usage_limit: z.coerce.number().int().min(0).default(0),
  per_customer_limit: z.coerce.number().int().min(0).default(0),
  customer_group: z.enum(['retail', 'wholesale', 'vip']).optional().nullable().or(z.literal('')),
  is_active: z.coerce.boolean().default(true).transform((v) => (v ? 1 : 0)),
  targets: z.array(z.object({
    target_type: z.enum(['product', 'category', 'brand', 'variant']),
    target_id: id,
  })).optional(),
});

export const adjustmentSchema = z.object({
  warehouse_id: id.optional().nullable(),
  reason: z.enum(['stock_take', 'damage', 'loss', 'theft', 'correction', 'expiry', 'other']).default('stock_take'),
  notes: optionalString,
  lines: z.array(z.object({
    variant_id: id,
    system_qty: z.coerce.number(),
    counted_qty: z.coerce.number().min(0),
    unit_cost: money,
    notes: optionalString,
  })).min(1, 'Add at least one line'),
});

export const quickAdjustSchema = z.object({
  variantId: id,
  warehouseId: id.optional().nullable(),
  newQuantity: z.coerce.number().min(0),
  reason: z.enum(['stock_take', 'damage', 'loss', 'theft', 'correction', 'expiry', 'other']).default('correction'),
  notes: optionalString,
});

export const userSchema = z.object({
  username: z.string().trim().min(3, 'Username must be at least 3 characters'),
  full_name: z.string().trim().min(1, 'Full name is required'),
  email: z.string().trim().email().optional().nullable().or(z.literal('')),
  phone: optionalString,
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role_id: id,
  default_warehouse_id: id.optional().nullable(),
  language: z.enum(['en', 'ar']).default('en'),
  is_active: z.coerce.boolean().default(true),
  must_change_password: z.coerce.boolean().default(false),
});

export const userUpdateSchema = userSchema
  .partial({ password: true, username: true })
  .extend({ unlock: z.coerce.boolean().optional() });

export const paymentSchema = z.object({
  amount: z.coerce.number().positive('Amount must be greater than zero'),
  method: z.string().trim().default('cash'),
  reference: optionalString,
});

export const labelBatchSchema = z.object({
  items: z.array(z.object({
    variant_id: id,
    copies: z.coerce.number().int().min(1).max(200).default(1),
  })).min(1, 'Select at least one item'),
  labelSize: z.string().trim().default('40x30'),
  qrSize: z.coerce.number().int().min(80).max(400).default(180),
  // Overrides `labels.symbology` for this one batch; omitted uses the setting.
  symbology: z.enum(['code128', 'ean13', 'qr']).optional(),
});

export const voucherBatchSchema = z.object({
  prefix: z.string().trim().min(1).max(8).default('MMV'),
  count: z.coerce.number().int().min(1).max(500).default(10),
  value: z.coerce.number().positive(),
  expiresAt: optionalString,
});

/** Username only — a locked-out user has nothing else to offer. */
export const forgotPasswordSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  note: z.string().max(300).optional().nullable(),
});

/**
 * A product photo arrives as a base64 data URL — the browser has already
 * resized and re-encoded it, so there is no multipart upload anywhere in this
 * system. Content type and size are checked against the decoded bytes in
 * ImageService; this only guards the shape.
 */
export const productImageSchema = z.object({
  dataUrl: z.string().min(1, 'A photo is required'),
  variantId: id.optional().nullable(),
  altEn: optionalString,
  altAr: optionalString,
});

export const productImageUpdateSchema = z.object({
  variantId: id.optional().nullable(),
  altEn: optionalString,
  altAr: optionalString,
});

export const imageOrderSchema = z.object({
  ids: z.array(id).default([]),
});

/** The website banner image — same shape as a product photo, its own endpoint. */
export const websiteBannerSchema = z.object({
  dataUrl: z.string().min(1, 'A photo is required'),
});

/**
 * A basket from the public internet.
 *
 * The only thing believed here is the SHAPE. Prices are absent from the schema
 * on purpose — the browser sends a variant and a quantity, and WebOrderService
 * looks the price up itself, so a client cannot name its own. Every string is
 * trimmed and length-capped at the boundary rather than in the service, because
 * this is the one schema whose input nobody has signed in to send.
 */
const publicText = (max) => z.string().trim().max(max);
const optionalPublicText = (max) => publicText(max).optional().nullable().or(z.literal(''));

export const webOrderSchema = z.object({
  lines: z.array(z.object({
    variant_id: id,
    quantity: z.coerce.number().int().min(1).max(99),
  })).min(1, 'Your basket is empty').max(50, 'An order can hold at most 50 items'),
  customer: z.object({
    name: publicText(120).min(1, 'Your name is required'),
    // Cash on delivery and a courier who has to ring the bell: the phone number
    // is the order's identity, and it is what `track()` checks against.
    phone: publicText(20).min(6, 'A valid phone number is required'),
    email: publicText(160).email().optional().nullable().or(z.literal('')),
  }),
  address: z.object({
    line: publicText(300).min(1, 'A delivery address is required'),
    area: optionalPublicText(120),
    city: publicText(120).min(1, 'A city is required'),
    notes: optionalPublicText(300),
  }),
  note: optionalPublicText(500),
  language: z.enum(['en', 'ar']).default('ar'),
});
