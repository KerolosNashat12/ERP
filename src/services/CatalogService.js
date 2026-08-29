/**
 * Product catalogue use-cases.
 *
 * The aggregate root is the product; variants are children that cannot exist
 * without it. Saving a product replaces its whole variant set in one
 * transaction, which keeps SKUs, attribute options and prices consistent.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction, currentTenant } from '../infrastructure/database/connection.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2, round3 } from '../shared/money.js';
import {
  DEFAULT_GENDER, isGender, isDiscountType, suggestGender, offerPrice,
} from '../shared/pricing.js';
import auditService from './AuditService.js';
import { reindexProduct, removeFromIndex } from './searchIndex.js';
// The filename → code rule, shared with the browser that shows the result.
// One rule, imported at both ends: a screen that ticked a file the upload
// then filed against nothing would be worse than no screen. See that module.
import { codeCandidates, sequenceOf } from '../../public/shared/photoFilename.js';

const nowIso = () => new Date().toISOString();

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

/** Marks the variant the service invents for an attribute-less product. */
const GENERATED = Symbol('generated default variant');

/**
 * The four offer columns, normalised.
 *
 * Written as a function rather than inline because both halves of the rule need
 * saying out loud:
 *
 *  · An offer that is switched OFF is switched off completely — type 'none',
 *    value zero, both dates cleared. Leaving a stale rate behind in a column
 *    nobody reads is how an offer comes back from the dead six months later
 *    when somebody flips the type back and does not look at the value.
 *  · A caller that mentions none of these keeps exactly what the product had.
 *    The bulk price tool, an offline till replaying a queued save and every
 *    script written before this release send the product without them, and none
 *    of them may silently end an offer that is running.
 *
 * How MUCH is not settled here — a percent over 100 is refused by the API
 * schema, and an amount larger than the price is capped against that price at
 * the moment it is applied, because only then is the price known.
 */
/**
 * The fields a bulk change may touch, and how each one is checked.
 *
 * One entry per field, and adding the next one is one entry — which is the
 * whole reason this is a table rather than four `if` statements. `clean`
 * returns the value to store or throws a sentence a cashier can act on; a
 * foreign key is verified to EXIST, because pointing two hundred products at a
 * brand that was deleted this morning is exactly the kind of damage a bulk tool
 * does before anybody notices.
 */
const BULK_LIMIT = 500;

/**
 * How many filenames one match request may carry. A shop dropping a folder of
 * a thousand photographs is a real thing; answering for all of them in one
 * request is not — the screen pages through in batches this size, which keeps
 * each round trip small enough to survive a shop's connection and gives the
 * person progress they can watch instead of a spinner that might be stuck.
 */
const PHOTO_MATCH_LIMIT = 300;

const BULK_FIELDS = {
  gender: {
    async clean(value) {
      if (!isGender(value)) throw new ValidationError('Choose Women, Men or Unisex');
      return value;
    },
  },
  brand_id: {
    async clean(value, service) { return service.assertExists('brands', value, 'Brand'); },
  },
  category_id: {
    async clean(value, service) { return service.assertExists('categories', value, 'Category'); },
  },
  supplier_id: {
    async clean(value, service) { return service.assertExists('suppliers', value, 'Supplier'); },
  },
};

function offerFields(payload, existing) {
  const mentioned = payload.discount_type !== undefined
    || payload.discount_value !== undefined
    || payload.discount_starts_on !== undefined
    || payload.discount_ends_on !== undefined;

  if (!mentioned) {
    return {
      discount_type: existing?.discount_type || 'none',
      discount_value: Number(existing?.discount_value || 0),
      discount_starts_on: existing?.discount_starts_on || null,
      discount_ends_on: existing?.discount_ends_on || null,
    };
  }

  const type = isDiscountType(payload.discount_type) ? payload.discount_type : 'none';
  const value = round2(Number(payload.discount_value) || 0);
  if (type === 'none' || value <= 0) {
    return {
      discount_type: 'none', discount_value: 0, discount_starts_on: null, discount_ends_on: null,
    };
  }

  const from = payload.discount_starts_on || null;
  const to = payload.discount_ends_on || null;
  if (from && to && to < from) {
    throw new ValidationError('The offer ends before it starts');
  }
  return {
    discount_type: type, discount_value: value, discount_starts_on: from, discount_ends_on: to,
  };
}

export class CatalogService {
  constructor(deps = {}) {
    this.products = deps.products || repositories.products;
    this.variants = deps.variants || repositories.variants;
    this.attributes = deps.attributes || repositories.attributes;
    this.attributeValues = deps.attributeValues || repositories.attributeValues;
    this.inventory = deps.inventory || repositories.inventory;
    this.audit = deps.audit || auditService;
  }

  /**
   * The counters above the products screen: how many, in what state, for whom.
   * Filters flow straight through, so the cards always describe the list under
   * them rather than the whole shop.
   */
  async summary(query = {}) {
    return this.products.summary(query);
  }

  /**
   * The products screen.
   *
   * The offer is resolved HERE rather than on the screen: whether one is
   * running today is a question about dates, and a browser that has been open
   * since yesterday would answer it wrongly. Every row therefore arrives with
   * `on_offer`, `offer_price` and `offer_percent` already decided by the same
   * rule the till and the website use.
   */
  async list(query) {
    const result = await this.products.search(query || {});
    return {
      ...result,
      rows: result.rows.map((row) => {
        const offer = offerPrice(row.min_price, row);
        return {
          ...row,
          gender: row.gender || DEFAULT_GENDER,
          on_offer: offer.onSale,
          offer_price: offer.onSale ? offer.price : null,
          offer_percent: offer.percent,
        };
      }),
    };
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
   * `max_products` (0 = unlimited) counts every row in the tenant's own
   * `products` table — this limit is about how many products the shop is
   * allowed to hold, not how many are currently visible, so an unpublished
   * or inactive product still counts. Only a brand-new product can trip it;
   * editing an existing one must not.
   */
  async #assertProductSlotAvailable() {
    const tenant = currentTenant();
    const maxProducts = tenant?.limits?.maxProducts;
    if (!tenant || !maxProducts) return;
    const { n: count } = await this.products.db.prepare('SELECT COUNT(*) AS n FROM products').get();
    if (count >= maxProducts) {
      throw new BusinessRuleError(
        `This shop is limited to ${maxProducts} product(s) and already has ${count}`,
        { limit: 'max_products', max: maxProducts, count },
      );
    }
  }

  /**
   * Create or replace a product together with its variants.
   * @param {object} payload product fields + { attribute_ids, variants }
   */


  /**
   * Change the same field on many products at once.
   *
   * ── The shape, and why it is a map of changes rather than a field and a value
   * The screen today sets one field. Building it as `{ids, changes}` costs
   * nothing now and means the second field — and the fifth — is a line in
   * `BULK_FIELDS` below rather than a new endpoint, a new validator and a new
   * dialog. The owner asked for exactly that: "should support other
   * bulk-editable fields in the future, not only gender".
   *
   * ── What may be changed here, and what may not ──────────────────────────
   * Classification only: who the piece is for, whose brand it is, which shelf
   * it belongs on, who supplies it. Deliberately NOT price, cost, stock or
   * publication — every one of those is a decision per product with money or a
   * shop window behind it, and the whole risk of a bulk tool is that it is one
   * click away from being applied to the wrong two hundred rows. Prices already
   * have their own tool, which shows each one before and after.
   *
   * ── What it refuses ─────────────────────────────────────────────────────
   * An empty selection, an empty change, a value the column does not allow, and
   * a brand/category/supplier id that does not exist — the last one because a
   * bulk update pointed at a deleted brand would silently orphan two hundred
   * products at once.
   *
   * Only rows that actually MOVE are written, and each writes one audit entry.
   * Sending three hundred products to the gender they already have is not three
   * hundred changes, and must not read as three hundred in the log.
   */
  /**
   * A foreign key that must be real, or an explicit "none".
   *
   * An empty value means clearing the field — which is a legitimate bulk
   * change, and the reason this returns null rather than refusing.
   */
  async assertExists(table, value, label) {
    if (value === null || value === undefined || value === '' || Number(value) === 0) return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`${label} is not valid`);
    const row = await this.products.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new NotFoundError(label, id);
    return id;
  }

  async bulkUpdate({ ids = [], changes = {} } = {}, context = {}) {
    const wanted = [...new Set(ids.map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
    if (!wanted.length) throw new ValidationError('Select at least one product');
    if (wanted.length > BULK_LIMIT) {
      throw new ValidationError(`A bulk change is limited to ${BULK_LIMIT} products at a time`);
    }

    const patch = {};
    for (const [field, spec] of Object.entries(BULK_FIELDS)) {
      const value = changes[field];
      if (value === undefined) continue;
      patch[field] = await spec.clean(value, this);
    }
    if (!Object.keys(patch).length) throw new ValidationError('Choose what to change');

    return transaction(async () => {
      let changed = 0;
      const touched = [];
      for (const id of wanted) {
        const before = await this.products.findById(id);
        if (!before) continue;

        // Only the fields that would actually differ. A product already sitting
        // on the value it was sent is skipped whole.
        const diff = {};
        for (const [field, value] of Object.entries(patch)) {
          const current = before[field] === undefined || before[field] === null
            ? null
            : before[field];
          if (String(current ?? '') !== String(value ?? '')) diff[field] = value;
        }
        if (!Object.keys(diff).length) continue;

        await this.products.update(id, diff);
        /*
         * A bulk edit can move products between brands and categories, and both
         * names are in the index. Without this, changing fifty products' brand
         * leaves fifty rows findable by the brand they used to be under and not
         * by the one they are.
         */
        await reindexProduct(id);
        changed += 1;
        touched.push(before.name_en);
        await this.audit.record({
          action: 'UPDATE',
          module: 'products',
          entityType: 'product',
          entityId: id,
          entityLabel: before.name_en,
          before: Object.fromEntries(Object.keys(diff).map((key) => [key, before[key] ?? null])),
          after: diff,
          message: 'Bulk update',
          actor: context.actor,
          request: context.request,
        });
      }

      return {
        requested: wanted.length,
        changed,
        unchanged: wanted.length - changed,
        fields: Object.keys(patch),
        sample: touched.slice(0, 5),
      };
    });
  }

  /**
   * Every product, with a suggested gender beside the one it has.
   *
   * ── Why a screen and not a script ───────────────────────────────────────
   * The shop had hundreds of products the day this field was added, and every
   * one of them needed an answer. Two ways to get there: guess from the name
   * and write it, or guess from the name and ASK. The first is faster by one
   * evening and wrong on every gift set, every unisex oud whose name happens to
   * contain "man", and every bottle labelled in a language the guesser does not
   * read — and wrong on a live website, where a men's fragrance filed under
   * حريمي is invisible to exactly the person looking for it.
   *
   * So this answers "what would you suggest", the screen shows it next to what
   * the product has now, and a person confirms a page at a time. The suggestion
   * itself is `suggestGender` in shared/pricing.js, which returns null when a
   * name carries both a masculine and a feminine marker — because a gift set
   * with two bottles in it genuinely has no answer, and inventing one is the
   * failure this whole flow exists to avoid.
   */
  async genderReview({ onlyUnset = false } = {}) {
    const rows = await this.products.db.prepare(`
      SELECT p.id, p.sku_prefix, p.name_en, p.name_ar, p.gender,
             b.name_en AS brand_name_en, b.name_ar AS brand_name_ar
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE p.is_active = 1
      ORDER BY p.name_en COLLATE NOCASE
    `).all();

    const reviewed = rows.map((row) => {
      const suggestion = suggestGender(row.name_en, row.name_ar);
      return {
        id: row.id,
        sku_prefix: row.sku_prefix,
        name_en: row.name_en,
        name_ar: row.name_ar,
        brand_name_en: row.brand_name_en,
        brand_name_ar: row.brand_name_ar,
        gender: row.gender || DEFAULT_GENDER,
        suggested: suggestion,
        // What the screen sorts and colours by: a row where the suggestion
        // disagrees with what is stored is the only kind worth a person's time.
        differs: Boolean(suggestion) && suggestion !== (row.gender || DEFAULT_GENDER),
      };
    });

    return {
      rows: onlyUnset ? reviewed.filter((row) => row.differs) : reviewed,
      total: reviewed.length,
      unclassified: reviewed.filter((row) => row.gender === DEFAULT_GENDER).length,
      suggestions: reviewed.filter((row) => row.differs).length,
    };
  }

  /**
   * Set the gender on many products at once.
   *
   * One transaction and one audit row per product that actually MOVED. A row
   * that already held the value it was sent is skipped rather than rewritten:
   * confirming a page of suggestions must not fill the audit log with three
   * hundred entries saying nothing changed.
   */
  async assignGenders(assignments = [], context = {}) {
    const wanted = assignments
      .map((entry) => ({ id: Number(entry.id), gender: String(entry.gender || '') }))
      .filter((entry) => Number.isInteger(entry.id) && entry.id > 0 && isGender(entry.gender));
    if (!wanted.length) throw new ValidationError('Nothing to classify');

    return transaction(async () => {
      let changed = 0;
      for (const entry of wanted) {
        const before = await this.products.findById(entry.id);
        if (!before) continue;
        if ((before.gender || DEFAULT_GENDER) === entry.gender) continue;

        await this.products.update(entry.id, { gender: entry.gender });
        changed += 1;
        await this.audit.record({
          action: 'UPDATE',
          module: 'products',
          entityType: 'product',
          entityId: entry.id,
          entityLabel: before.name_en,
          before: { gender: before.gender || DEFAULT_GENDER },
          after: { gender: entry.gender },
          actor: context.actor,
          request: context.request,
        });
      }
      return { requested: wanted.length, changed };
    });
  }

  async save(payload, context = {}, productId = null) {
    return transaction(async () => {
      const isUpdate = Boolean(productId);
      if (!isUpdate) await this.#assertProductSlotAvailable();
      const before = isUpdate ? await this.products.findAggregate(productId) : null;
      if (isUpdate && !before) throw new NotFoundError('Product', productId);

      const skuPrefix = normalisePrefix(payload.sku_prefix);
      if (!skuPrefix) throw new ValidationError('SKU prefix is required');
      if (await this.products.exists('sku_prefix', skuPrefix, productId)) {
        throw new ConflictError(`SKU prefix "${skuPrefix}" is already used`);
      }

      const published = payload.is_published === true || payload.is_published === 1;
      const existingProduct = isUpdate ? await this.products.findById(productId) : null;

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
        is_published: published ? 1 : 0,
        // Stamped the first time it goes live and never cleared, so the
        // storefront can order by "newest on the website" rather than by
        // when the product was first typed into the back office.
        published_at: published ? (existingProduct?.published_at || nowIso()) : (existingProduct?.published_at || null),
        web_description_en: payload.web_description_en || null,
        web_description_ar: payload.web_description_ar || null,

        /*
         * Gender, and the offer.
         *
         * `??` and not `||` for the gender: a caller that sends nothing keeps
         * whatever the product already had, and only an explicit value changes
         * it. A new product with no answer is 'unisex' — visible to everybody,
         * which is the one default that cannot hide a piece from half the shop.
         */
        gender: isGender(payload.gender)
          ? payload.gender
          : (existingProduct?.gender || DEFAULT_GENDER),
        ...offerFields(payload, existingProduct),
      };

      const product = isUpdate
        ? await this.products.update(productId, productData)
        : await this.products.create({ ...productData, created_by: context.actor?.id || null });

      await this.#syncAttributes(product.id, payload.attribute_ids || []);
      await this.#syncVariants(product, payload.variants || [], payload.attribute_ids || []);

      /*
       * AFTER the variants, because the index carries their SKUs, barcodes and
       * labels — indexing before them would store the previous set and a newly
       * added SKU would not be findable until the next save.
       *
       * Inside the transaction, so a product and the text it is found by are
       * committed together. It cannot throw (see searchIndex.js): a product
       * that saved correctly is not rolled back because its search text could
       * not be rebuilt.
       */
      await reindexProduct(product.id);

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
    const existing = await this.variants.byProduct(product.id);
    // A simple product may be saved with no attributes and no variants, but
    // stock, sales and labels are all keyed to a variant — so it gets exactly
    // one, carrying the product's own code and default prices.
    const inputs = variants.length ? variants : [await this.#defaultVariant(product, existing)];
    const keptIds = new Set();
    const seenSkus = new Set();

    for (const input of inputs) {
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

      // The generated single variant carries no label at all: there is nothing
      // to distinguish, and "Default" would only add noise to receipts.
      const label = enriched.length
        ? this.buildLabel(enriched)
        : (input[GENERATED] ? null : (input.variant_label || 'Default'));

      const data = {
        product_id: product.id,
        sku,
        barcode: (input.barcode || sku).trim(),
        variant_label: label,
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

  /**
   * The single variant a product with no attributes gets.
   * Re-saving such a product must not spawn a second one, so the variant that
   * already carries the empty option signature is reused by id — which is also
   * what keeps its stock, its history and its printed labels valid.
   */
  async #defaultVariant(product, existing) {
    const current = await this.#findVariantWithoutOptions(existing);
    return {
      [GENERATED]: true,
      id: current?.id || null,
      sku: product.sku_prefix,
      barcode: product.sku_prefix,
      variant_label: null,
      cost_price: product.base_cost,
      selling_price: product.base_price,
      wholesale_price: product.base_price,
      reorder_level: current?.reorder_level ?? 0,
      reorder_quantity: current?.reorder_quantity ?? 0,
      is_active: true,
      options: [],
    };
  }

  /** The existing variant whose attribute-option signature is empty, if any. */
  async #findVariantWithoutOptions(existing) {
    for (const variant of existing) {
      const option = await this.variants.db
        .prepare('SELECT 1 FROM variant_attribute_values WHERE variant_id = ? LIMIT 1')
        .get(variant.id);
      if (!option) return variant;
    }
    return null;
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
      /*
       * The FK is `ON DELETE CASCADE` and `PRAGMA foreign_keys = ON` is set, so
       * this is belt as well as braces — and worth having: a deleted product
       * that stayed in the index would be offered as a suggestion, clicked, and
       * open nothing. Cheap insurance against a delete path that reaches the
       * row some other way.
       */
      await removeFromIndex(productId);
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

  /**
   * Match a list of filenames to products, for the bulk photo screen.
   *
   * The shop drops a folder in; this answers "which of these do I know?"
   * BEFORE a single photograph is uploaded, so the person sees the whole
   * outcome — matched, already has photos, not recognised — as a list they can
   * read, and can fix the two filenames they got wrong instead of finding out
   * afterwards that eleven photos went nowhere.
   *
   * ── The filename is cleaned here, not in the browser ───────────────────────
   * `VS-1042 (2).jpg`, `vs-1042_3.JPG` and `VS-1042-2.jpeg` are all the same
   * product, because a phone and a camera and Windows all number duplicates
   * differently and no shop is going to rename two hundred files. The rule that
   * strips that numbering has to be the same rule the upload uses, so it lives
   * on the server where both can reach it rather than being written twice.
   *
   * A code is never INVENTED from a name: everything is matched exactly (case
   * aside) against a real product code, SKU or barcode. A fuzzy match here
   * would file a photograph of one product against another, which is worse
   * than not matching it at all — the shop would never know to look.
   */
  async matchPhotoFilenames(filenames = []) {
    const files = (Array.isArray(filenames) ? filenames : [])
      .map((name) => String(name ?? '').trim())
      .filter(Boolean)
      .slice(0, PHOTO_MATCH_LIMIT);
    if (!files.length) return { rows: [], matched: 0, unmatched: 0 };

    /*
     * Every reading of every filename, looked up in ONE query. `codeCandidates`
     * gives at most two per file (the literal stem and the stem with a trailing
     * duplicate number removed), so two hundred files is at most four hundred
     * codes in one `IN` list — still one round trip, still one index seek per
     * code.
     */
    const candidates = files.map((filename) => codeCandidates(filename));
    const matches = await this.products.matchCodes(candidates.flat());
    const byCode = new Map(matches.map((row) => [String(row.code).toLowerCase(), row]));

    const rows = files.map((filename, index) => {
      // Best first: see codeCandidates(). The literal filename beats the
      // stripped one, so a shop whose codes end in a number needs no special
      // handling and a shop numbering its shots still lands on the product.
      const tried = candidates[index];
      const code = tried.find((candidate) => byCode.has(candidate.toLowerCase())) || tried[0] || null;
      const hit = code ? byCode.get(code.toLowerCase()) : null;
      return {
        filename,
        code: code || null,
        sequence: sequenceOf(filename),
        product_id: hit ? hit.product_id : null,
        sku_prefix: hit ? hit.sku_prefix : null,
        name_en: hit ? hit.name_en : null,
        name_ar: hit ? hit.name_ar : null,
        matched_on: hit ? hit.matched_on : null,
        photo_count: hit ? hit.photo_count : 0,
      };
    });

    return {
      rows,
      matched: rows.filter((row) => row.product_id).length,
      unmatched: rows.filter((row) => !row.product_id).length,
    };
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
