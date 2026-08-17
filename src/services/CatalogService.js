/**
 * Product catalogue use-cases.
 *
 * The aggregate root is the product; variants are children that cannot exist
 * without it. Saving a product replaces its whole variant set in one
 * transaction, which keeps SKUs, attribute options and prices consistent.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2, round3 } from '../shared/money.js';
import auditService from './AuditService.js';

/** Option codes become SKU segments: "Rose Gold" -> "ROSEGO". */
const slug = (value) => String(value || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, '')
  .slice(0, 6);

/** The product prefix is kept intact (hyphens allowed) so SKUs stay readable. */
const normalisePrefix = (value) => String(value || '')
  .toUpperCase()
  .trim()
  .replace(/[^A-Z0-9-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

export class CatalogService {
  constructor(deps = {}) {
    this.products = deps.products || repositories.products;
    this.variants = deps.variants || repositories.variants;
    this.attributes = deps.attributes || repositories.attributes;
    this.attributeValues = deps.attributeValues || repositories.attributeValues;
    this.inventory = deps.inventory || repositories.inventory;
    this.audit = deps.audit || auditService;
  }

  async list(query) {
    return this.products.search(query || {});
  }

  async get(productId) {
    const product = await this.products.findAggregate(productId);
    if (!product) throw new NotFoundError('Product', productId);
    return product;
  }

  /** Cartesian product of the selected attribute values — the variant matrix. */
  async generateCombinations(attributeIds = []) {
    // Built with a loop rather than map+filter: both reads per attribute await.
    const groups = [];
    for (const id of attributeIds) {
      const attribute = await this.attributes.requireById(id, 'attribute');
      const values = (await this.attributeValues.byAttribute(id)).filter((v) => v.is_active);
      if (values.length > 0) groups.push({ attribute, values });
    }

    if (!groups.length) return [];

    return groups.reduce(
      (combinations, group) => combinations.flatMap((combo) =>
        group.values.map((value) => [
          ...combo,
          {
            attribute_id: group.attribute.id,
            attribute_code: group.attribute.code,
            attribute_name_en: group.attribute.name_en,
            attribute_name_ar: group.attribute.name_ar,
            attribute_value_id: value.id,
            value_code: value.code,
            value_en: value.value_en,
            value_ar: value.value_ar,
            color_hex: value.color_hex,
          },
        ])),
      [[]],
    );
  }

  buildSku(skuPrefix, options) {
    const parts = options.map((o) => slug(o.value_code || o.code || o.value_en));
    return [normalisePrefix(skuPrefix), ...parts].filter(Boolean).join('-');
  }

  buildLabel(options, language = 'en') {
    return options
      .map((o) => (language === 'ar' ? (o.value_ar || o.value_en) : o.value_en))
      .join(' / ');
  }

  /**
   * Create or replace a product together with its variants.
   * @param {object} payload product fields + { attribute_ids, variants }
   */
  async save(payload, context = {}, productId = null) {
    return transaction(async () => {
      const isUpdate = Boolean(productId);
      const before = isUpdate ? await this.products.findAggregate(productId) : null;
      if (isUpdate && !before) throw new NotFoundError('Product', productId);

      const skuPrefix = normalisePrefix(payload.sku_prefix);
      if (!skuPrefix) throw new ValidationError('SKU prefix is required');
      if (await this.products.exists('sku_prefix', skuPrefix, productId)) {
        throw new ConflictError(`SKU prefix "${skuPrefix}" is already used`);
      }

      const productData = {
        sku_prefix: skuPrefix,
        name_en: payload.name_en,
        name_ar: payload.name_ar || null,
        description_en: payload.description_en || null,
        description_ar: payload.description_ar || null,
        brand_id: payload.brand_id || null,
        category_id: payload.category_id || null,
        supplier_id: payload.supplier_id || null,
        unit: payload.unit || 'piece',
        tax_rate: Number(payload.tax_rate || 0),
        base_cost: round2(payload.base_cost || 0),
        base_price: round2(payload.base_price || 0),
        track_inventory: payload.track_inventory === false ? 0 : 1,
        image_url: payload.image_url || null,
        tags: payload.tags || null,
        is_active: payload.is_active === false || payload.is_active === 0 ? 0 : 1,
      };

      const product = isUpdate
        ? await this.products.update(productId, productData)
        : await this.products.create({ ...productData, created_by: context.actor?.id || null });

      await this.#syncAttributes(product.id, payload.attribute_ids || []);
      await this.#syncVariants(product, payload.variants || [], payload.attribute_ids || []);

      const after = await this.products.findAggregate(product.id);
      await this.audit.recordChange(context, {
        action: isUpdate ? 'UPDATE' : 'CREATE',
        module: 'products',
        entityType: 'product',
        entityId: product.id,
        entityLabel: `${product.sku_prefix} — ${product.name_en}`,
        before: before ? { ...before, variants: before.variants?.length } : null,
        after: { ...after, variants: after.variants?.length },
      });
      return after;
    });
  }

  async #syncAttributes(productId, attributeIds) {
    const db = this.products.db;
    await db.prepare('DELETE FROM product_attributes WHERE product_id = ?').run(productId);
    const insert = db.prepare(
      'INSERT INTO product_attributes (product_id, attribute_id, display_order) VALUES (?, ?, ?)',
    );
    for (const [index, attributeId] of attributeIds.entries()) {
      await insert.run(productId, attributeId, index);
    }
  }

  async #syncVariants(product, variants, attributeIds) {
    if (!variants.length) {
      throw new BusinessRuleError('A product needs at least one variant (add a default one if it has no options)');
    }

    const existing = await this.variants.byProduct(product.id);
    const keptIds = new Set();
    const seenSkus = new Set();

    for (const input of variants) {
      const options = (input.options || []).map((o) => ({
        attribute_id: Number(o.attribute_id),
        attribute_value_id: Number(o.attribute_value_id),
      }));

      // Enrich options so SKU + label can be generated server-side.
      const enriched = [];
      for (const o of options) {
        const value = await this.attributeValues.requireById(o.attribute_value_id, 'attribute value');
        enriched.push({ ...o, value_code: value.code, value_en: value.value_en, value_ar: value.value_ar });
      }

      if (attributeIds.length && enriched.length !== attributeIds.length) {
        throw new BusinessRuleError('Every variant must define a value for each selected attribute');
      }

      const sku = String(input.sku || this.buildSku(product.sku_prefix, enriched)).trim().toUpperCase();
      if (seenSkus.has(sku)) throw new ConflictError(`Duplicate SKU in submission: ${sku}`);
      seenSkus.add(sku);

      const data = {
        product_id: product.id,
        sku,
        barcode: (input.barcode || sku).trim(),
        variant_label: enriched.length ? this.buildLabel(enriched) : (input.variant_label || 'Default'),
        cost_price: round2(input.cost_price ?? product.base_cost),
        selling_price: round2(input.selling_price ?? product.base_price),
        wholesale_price: round2(input.wholesale_price ?? input.selling_price ?? product.base_price),
        reorder_level: Number(input.reorder_level || 0),
        reorder_quantity: Number(input.reorder_quantity || 0),
        weight_grams: input.weight_grams ?? null,
        image_url: input.image_url || null,
        is_active: input.is_active === false || input.is_active === 0 ? 0 : 1,
      };

      if (await this.variants.exists('sku', data.sku, input.id || null)) {
        throw new ConflictError(`SKU "${data.sku}" is already used by another product`);
      }
      if (data.barcode && await this.variants.exists('barcode', data.barcode, input.id || null)) {
        throw new ConflictError(`Barcode "${data.barcode}" is already used`);
      }

      const saved = input.id
        ? await this.variants.update(input.id, data)
        : await this.variants.create(data);
      await this.variants.replaceOptions(saved.id, enriched);
      keptIds.add(saved.id);
    }

    for (const old of existing) {
      if (keptIds.has(old.id)) continue;
      if (await this.variants.isReferenced(old.id)) {
        await this.variants.update(old.id, { is_active: 0 });
      } else {
        await this.variants.remove(old.id);
      }
    }
  }

  async remove(productId, context = {}) {
    return transaction(async () => {
      const product = await this.products.requireById(productId, 'product');
      const variants = await this.variants.byProduct(productId);

      // `some()` cannot await — a promise is always truthy, which would have
      // deactivated every product. Loop instead, stopping at the first hit.
      let referenced = false;
      for (const v of variants) {
        if (await this.variants.isReferenced(v.id)) {
          referenced = true;
          break;
        }
      }

      if (referenced) {
        await this.products.update(productId, { is_active: 0 });
        for (const v of variants) await this.variants.update(v.id, { is_active: 0 });
        await this.audit.recordChange(context, {
          action: 'DEACTIVATE', module: 'products', entityType: 'product', entityId: productId,
          entityLabel: product.name_en, before: product,
        });
        return { deleted: false, deactivated: true };
      }

      await this.products.remove(productId);
      await this.audit.recordChange(context, {
        action: 'DELETE', module: 'products', entityType: 'product', entityId: productId,
        entityLabel: product.name_en, before: product,
      });
      return { deleted: true, deactivated: false };
    });
  }

  /**
   * Everything the product details screen shows: the product, its variants with
   * live stock and QR payloads, how it has been trading, and where it has been.
   * Assembled here so the screen is one request rather than six.
   */
  async overview(productId, { days = 90 } = {}) {
    // Nothing here writes, so the reads can overlap.
    const [product, stock] = await Promise.all([
      this.get(productId),
      this.products.variantStock(productId),
    ]);
    const stockByVariant = new Map(stock.map((row) => [row.variant_id, row]));

    const variants = product.variants.map((variant) => {
      const level = stockByVariant.get(variant.id);
      const quantity = Number(level?.quantity || 0);
      const averageCost = Number(level?.average_cost || variant.cost_price || 0);
      const margin = variant.selling_price > 0
        ? round2(((variant.selling_price - averageCost) / variant.selling_price) * 100)
        : 0;
      return {
        ...variant,
        quantity,
        available_quantity: Number(level?.available_quantity || 0),
        average_cost: averageCost,
        stock_value: round2(quantity * averageCost),
        retail_value: round2(quantity * Number(variant.selling_price || 0)),
        margin_percent: margin,
        is_low: variant.reorder_level > 0 && quantity <= variant.reorder_level,
        is_out: quantity <= 0,
      };
    });

    const totals = variants.reduce((acc, v) => ({
      quantity: round3(acc.quantity + v.quantity),
      stockValue: round2(acc.stockValue + v.stock_value),
      retailValue: round2(acc.retailValue + v.retail_value),
      lowCount: acc.lowCount + (v.is_low ? 1 : 0),
      outCount: acc.outCount + (v.is_out ? 1 : 0),
    }), { quantity: 0, stockValue: 0, retailValue: 0, lowCount: 0, outCount: 0 });

    const prices = variants.map((v) => Number(v.selling_price || 0));

    const [performance, sales, purchases, movements, returns] = await Promise.all([
      this.products.performance(productId, days),
      this.products.salesHistory(productId),
      this.products.purchaseHistory(productId),
      this.products.movementHistory(productId),
      this.products.returnHistory(productId),
    ]);

    return {
      product: {
        id: product.id,
        sku_prefix: product.sku_prefix,
        name_en: product.name_en,
        name_ar: product.name_ar,
        description_en: product.description_en,
        description_ar: product.description_ar,
        unit: product.unit,
        tax_rate: product.tax_rate,
        base_cost: product.base_cost,
        base_price: product.base_price,
        track_inventory: product.track_inventory,
        tags: product.tags,
        is_active: product.is_active,
        image_url: product.image_url,
        created_at: product.created_at,
        updated_at: product.updated_at,
        brand_id: product.brand_id,
        brand_name_en: product.brand_name_en,
        category_id: product.category_id,
        category_name_en: product.category_name_en,
        supplier_id: product.supplier_id,
        supplier_name_en: product.supplier_name_en,
      },
      attributes: product.attributes,
      variants,
      totals: {
        ...totals,
        variantCount: variants.length,
        activeVariantCount: variants.filter((v) => v.is_active).length,
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        potentialMargin: round2(totals.retailValue - totals.stockValue),
      },
      performance,
      sales,
      purchases,
      movements,
      returns,
    };
  }

  /** Scanner + POS lookups. */
  async findByCode(code) {
    const variant = await this.variants.findByCode(String(code || '').trim());
    if (!variant) throw new NotFoundError('Item with code', code);
    return variant;
  }

  async lookup(term, warehouseId) {
    if (!term || String(term).length < 1) return [];
    return this.variants.lookup(String(term).trim(), 25, warehouseId || null);
  }

  async variantDetails(variantId) {
    const details = await this.variants.details(variantId);
    if (!details) throw new NotFoundError('Variant', variantId);
    const stock = await this.variants.db.prepare(`
      SELECT sl.*, w.name_en AS warehouse_name_en, w.name_ar AS warehouse_name_ar
      FROM stock_levels sl JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.variant_id = ?
    `).all(variantId);
    return { ...details, stock };
  }

  /** Bulk price update — a real time-saver when a supplier raises prices. */
  async bulkUpdatePrices({ variantIds = [], mode = 'percent', field = 'selling_price', value = 0 }, context = {}) {
    if (!variantIds.length) throw new ValidationError('Select at least one variant');
    if (!['selling_price', 'cost_price', 'wholesale_price'].includes(field)) {
      throw new ValidationError('Unsupported price field');
    }
    return transaction(async () => {
      let updated = 0;
      for (const id of variantIds) {
        const variant = await this.variants.findById(id);
        if (!variant) continue;
        const current = Number(variant[field] || 0);
        const next = mode === 'percent'
          ? round2(current * (1 + Number(value) / 100))
          : (mode === 'set' ? round2(Number(value)) : round2(current + Number(value)));
        await this.variants.update(id, { [field]: Math.max(next, 0) });
        updated += 1;
      }
      await this.audit.record({
        action: 'BULK_UPDATE', module: 'products', entityType: 'product_variant',
        entityLabel: `${updated} variants`, after: { mode, field, value, variantIds },
        actor: context.actor, request: context.request,
      });
      return { updated };
    });
  }
}

export const catalogService = new CatalogService();
export default catalogService;
