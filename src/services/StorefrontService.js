/**
 * The public storefront — read side only.
 *
 * SECURITY: every method here answers an UNAUTHENTICATED request. Anyone on the
 * internet can call these endpoints, so this file NEVER uses `SELECT *` and
 * NEVER reuses the ERP repositories or services. All SQL is hand-written and
 * every column is named explicitly.
 *
 * That is not stylistic. The same database holds `base_cost`, `cost_price`,
 * `wholesale_price`, supplier names, stock quantities, customer phone numbers
 * and every sale ever made. A shared query that grows one column — or a
 * repository that starts returning the whole row — publishes the shop's margins
 * to its competitors, silently, from a screen nobody reviewed. The only defence
 * that survives future edits is a column list somebody had to type.
 *
 * The same rule applies to stock: availability leaves this file as
 * 'in_stock' | 'low' | 'out' and never as a number. "Only 2 left" tells a
 * competitor exactly what the shop is holding; "low" does the same sales job
 * without it. The comparison against the threshold happens inside SQL, so the
 * raw quantity is never even loaded into JavaScript where a later `res.json(row)`
 * could leak it.
 */
import { getDb } from '../infrastructure/database/connection.js';
import { NotFoundError } from '../shared/errors.js';

/** Settings the storefront reads. Listed so `config()` can fetch them in one query. */
const CONFIG_KEYS = [
  'shop.enabled',
  'shop.delivery_fee',
  'shop.free_delivery_over',
  'shop.whatsapp',
  'shop.announcement_en',
  'shop.announcement_ar',
  'company.name',
  'company.name_ar',
  'company.currency',
  'company.currency_symbol_en',
  'company.currency_symbol_ar',
];

/** Units at or below this count as 'low'. Overridable from settings. */
const DEFAULT_LOW_STOCK_THRESHOLD = 3;

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 48;
const HOME_SIZE = 8;

/** How far back "featured" looks for best sellers. */
const FEATURED_DAYS = 90;

/**
 * What makes a product visible to the public, in one place so no query can
 * forget half of it: the product is live AND published, its brand and its
 * category (where set) are published too — an unpublished brand must not leak
 * through its products — and it has something that can actually be bought.
 *
 * Written against the alias `p`. The inner aliases are suffixed to stay clear
 * of whatever the outer query is using.
 */
const PUBLISHED_PRODUCT = `
  p.is_active = 1
  AND p.is_published = 1
  AND (p.brand_id IS NULL OR EXISTS (
        SELECT 1 FROM brands bg WHERE bg.id = p.brand_id AND bg.is_published = 1))
  AND (p.category_id IS NULL OR EXISTS (
        SELECT 1 FROM categories cg WHERE cg.id = p.category_id AND cg.is_published = 1))
  AND EXISTS (
        SELECT 1 FROM product_variants vg WHERE vg.product_id = p.id AND vg.is_active = 1)
`;

/**
 * The product card. Prices are the min/max across ACTIVE variants only, so a
 * discontinued colour cannot advertise a price nobody can buy.
 *
 * `image_id` prefers the chosen primary photo but falls back to the first by
 * display order — and the primary is checked against `product_id` as well as
 * its id, so a stale `primary_image_id` (the row was deleted, or the id now
 * belongs to another product's photo) shows this product's own first picture
 * rather than a blank card or, worse, somebody else's product.
 *
 * Not selected, deliberately: base_cost, base_price, supplier_id, sku_prefix.
 */
const CARD_COLUMNS = `
  p.id                AS id,
  p.name_en           AS name_en,
  p.name_ar           AS name_ar,
  p.brand_id          AS brand_id,
  b.name_en           AS brand_name_en,
  b.name_ar           AS brand_name_ar,
  p.category_id       AS category_id,
  (SELECT MIN(vp.selling_price) FROM product_variants vp
    WHERE vp.product_id = p.id AND vp.is_active = 1) AS price_from,
  (SELECT MAX(vp.selling_price) FROM product_variants vp
    WHERE vp.product_id = p.id AND vp.is_active = 1) AS price_to,
  COALESCE(
    (SELECT ip.id FROM product_images ip
      WHERE ip.id = p.primary_image_id AND ip.product_id = p.id),
    (SELECT i2.id FROM product_images i2
      WHERE i2.product_id = p.id ORDER BY i2.display_order, i2.id LIMIT 1)
  ) AS image_id
`;

const CARD_FROM = `
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
`;

/** Whitelist — the sort key arrives from a query string and is never interpolated. */
const SORTS = {
  newest: 'COALESCE(p.published_at, p.created_at) DESC, p.id DESC',
  price_asc: 'price_from ASC, p.id DESC',
  price_desc: 'price_from DESC, p.id DESC',
  name: 'p.name_en COLLATE NOCASE ASC, p.id DESC',
};

/** 'in_stock' beats 'low' beats 'out' when rolling variants up to their product. */
const AVAILABILITY_RANK = { out: 0, low: 1, in_stock: 2 };
const RANK_AVAILABILITY = ['out', 'low', 'in_stock'];

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value) => (value === null || value === undefined ? null : Number(value));

/** `%` and `_` typed by a shopper are text, not wildcards. */
const likeTerm = (term) => `%${String(term).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** settings.value is TEXT; value_type says what it meant. */
function decodeSetting(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === '1' || value === 'true';
  return value;
}

export class StorefrontService {
  get db() {
    return getDb();
  }

  // ------------------------------------------------------------------ config

  /**
   * Everything the shell of the site needs before it can paint: the shop's
   * name, its money, its delivery terms and whether it is open at all.
   * One query for eleven keys rather than eleven round trips — this runs on
   * every cold page load, over a network connection.
   */
  async config() {
    const placeholders = CONFIG_KEYS.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT key, value, value_type
      FROM settings
      WHERE key IN (${placeholders})
    `).all(...CONFIG_KEYS);

    const s = new Map(rows.map((r) => [r.key, decodeSetting(r.value, r.value_type)]));
    const num = (key, fallback = 0) => {
      const value = Number(s.get(key));
      return Number.isFinite(value) ? value : fallback;
    };

    const freeOver = num('shop.free_delivery_over', 0);

    return {
      // Missing row means nobody has ever configured the shop; the migration
      // seeds it enabled, so treat absence as enabled rather than dark.
      shopEnabled: s.get('shop.enabled') === null || s.get('shop.enabled') === undefined
        ? true
        : Boolean(s.get('shop.enabled')),
      companyName: {
        en: s.get('company.name') || 'M&M Accessories',
        ar: s.get('company.name_ar') || s.get('company.name') || 'M&M Accessories',
      },
      currency: s.get('company.currency') || 'EGP',
      currencySymbol: {
        en: s.get('company.currency_symbol_en') || s.get('company.currency') || 'EGP',
        ar: s.get('company.currency_symbol_ar') || s.get('company.currency') || 'EGP',
      },
      deliveryFee: num('shop.delivery_fee', 0),
      // null, not 0: a client comparing `total >= freeDeliveryOver` would make
      // every order free delivery if this were zero.
      freeDeliveryOver: freeOver > 0 ? freeOver : null,
      whatsapp: s.get('shop.whatsapp') || null,
      announcement: {
        en: s.get('shop.announcement_en') || null,
        ar: s.get('shop.announcement_ar') || null,
      },
    };
  }

  // -------------------------------------------------------------------- home

  /** The landing page in one request; the four reads are independent, so overlap them. */
  async home() {
    const [newest, featured, categories, brands] = await Promise.all([
      this.products({ sort: 'newest', pageSize: HOME_SIZE }).then((r) => r.rows),
      this.#featured(HOME_SIZE),
      this.categories(),
      this.brands(),
    ]);
    return { newest, featured, categories, brands };
  }

  /**
   * Featured = what has actually been selling, topped up with the newest arrivals
   * so a quiet week still fills the shelf. Only ids and an ordering leave the
   * sales tables — no revenue, no units, no customer, nothing a competitor could
   * read a number off. The window is bounded so this stays a small aggregate
   * rather than a scan of the shop's entire trading history on every page load.
   */
  async #featured(limit) {
    const best = await this.db.prepare(`
      SELECT p.id AS id
      FROM sale_lines sl
      JOIN sales s            ON s.id = sl.sale_id AND s.status = 'completed'
      JOIN product_variants v ON v.id = sl.variant_id AND v.is_active = 1
      JOIN products p         ON p.id = v.product_id
      WHERE ${PUBLISHED_PRODUCT}
        AND s.sale_date >= date('now', ?)
      GROUP BY p.id
      ORDER BY SUM(sl.quantity - sl.returned_quantity) DESC, p.id DESC
      LIMIT ?
    `).all(`-${FEATURED_DAYS} days`, limit);

    const ids = best.map((row) => row.id);
    if (ids.length < limit) {
      const filler = await this.products({ sort: 'newest', pageSize: limit });
      for (const row of filler.rows) {
        if (ids.length >= limit) break;
        if (!ids.includes(row.id)) ids.push(row.id);
      }
    }
    return this.#cardsByIds(ids);
  }

  // ------------------------------------------------------- categories, brands

  /**
   * Only categories a shopper can get somewhere from: published, live, and
   * holding at least one visible product. An empty category on a storefront is
   * a dead end that also tells the world what the shop is planning to stock.
   */
  async categories() {
    return this.db.prepare(`
      SELECT c.id        AS id,
             c.name_en   AS name_en,
             c.name_ar   AS name_ar,
             c.parent_id AS parent_id,
             (SELECT COUNT(*) FROM products p
               WHERE p.category_id = c.id AND ${PUBLISHED_PRODUCT}) AS product_count
      FROM categories c
      WHERE c.is_active = 1
        AND c.is_published = 1
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.category_id = c.id AND ${PUBLISHED_PRODUCT})
      ORDER BY c.display_order, c.name_en COLLATE NOCASE
    `).all();
  }

  /**
   * Same shape and same rules as `categories()` so one component can render
   * both. Brands have neither a parent nor a display order in the schema, so
   * `parent_id` is a constant null and the ordering falls through to the name.
   */
  async brands() {
    return this.db.prepare(`
      SELECT b.id      AS id,
             b.name_en AS name_en,
             b.name_ar AS name_ar,
             NULL      AS parent_id,
             (SELECT COUNT(*) FROM products p
               WHERE p.brand_id = b.id AND ${PUBLISHED_PRODUCT}) AS product_count
      FROM brands b
      WHERE b.is_active = 1
        AND b.is_published = 1
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.brand_id = b.id AND ${PUBLISHED_PRODUCT})
      ORDER BY b.name_en COLLATE NOCASE
    `).all();
  }

  // ---------------------------------------------------------------- browsing

  /**
   * The catalogue listing: filter, sort, paginate.
   *
   * Three queries, whatever the page size: a count, the page itself, and one
   * variant query for the whole page. The obvious version — loop the products
   * and ask for each one's stock — is N+1, and on a networked database that is
   * N round trips of latency on the shop's busiest public page. So the page's
   * ids go into a single `WHERE product_id IN (...)` and the rows are stitched
   * together here.
   */
  async products({ category, brand, q, sort, page, pageSize } = {}) {
    const where = [PUBLISHED_PRODUCT];
    const params = [];

    const categoryId = toInt(category, null);
    if (categoryId) {
      where.push('p.category_id = ?');
      params.push(categoryId);
    }
    const brandId = toInt(brand, null);
    if (brandId) {
      where.push('p.brand_id = ?');
      params.push(brandId);
    }
    const term = String(q ?? '').trim();
    if (term) {
      where.push(`(p.name_en LIKE ? ESCAPE '\\'
               OR p.name_ar LIKE ? ESCAPE '\\'
               OR p.tags    LIKE ? ESCAPE '\\')`);
      const like = likeTerm(term);
      params.push(like, like, like);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const orderSql = SORTS[sort] || SORTS.newest;
    const size = Math.min(Math.max(toInt(pageSize, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const current = Math.max(toInt(page, 1), 1);

    const counted = await this.db.prepare(`
      SELECT COUNT(*) AS n FROM products p ${whereSql}
    `).get(...params);
    const total = Number(counted?.n || 0);

    const rows = await this.db.prepare(`
      SELECT ${CARD_COLUMNS}
      ${CARD_FROM}
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    return {
      rows: await this.#withAvailability(rows),
      total,
      page: current,
      pageSize: size,
      pages: Math.ceil(total / size) || 1,
    };
  }

  /**
   * One product page. Anything that is not a published product is a 404 —
   * including a product that exists but is hidden. Ids are sequential, so
   * "exists but you may not see it" would let anyone count next season's range
   * with a for-loop.
   */
  async product(id) {
    const productId = toInt(id, null);
    if (!productId) throw new NotFoundError('Product', id);

    const row = await this.db.prepare(`
      SELECT ${CARD_COLUMNS},
             COALESCE(NULLIF(p.web_description_en, ''), p.description_en) AS description_en,
             COALESCE(NULLIF(p.web_description_ar, ''), p.description_ar) AS description_ar,
             p.tax_rate AS tax_rate
      ${CARD_FROM}
      WHERE p.id = ? AND ${PUBLISHED_PRODUCT}
    `).get(productId);
    if (!row) throw new NotFoundError('Product', id);

    // Independent reads: the photos do not depend on the variants.
    const [variants, images] = await Promise.all([
      this.#variants([productId]),
      this.db.prepare(`
        SELECT i.id     AS id,
               i.alt_en AS alt_en,
               i.alt_ar AS alt_ar,
               i.variant_id AS variant_id
        FROM product_images i
        WHERE i.product_id = ?
        ORDER BY i.display_order, i.id
      `).all(productId),
    ]);

    return {
      id: row.id,
      name_en: row.name_en,
      name_ar: row.name_ar,
      brand_id: row.brand_id,
      brand_name_en: row.brand_name_en,
      brand_name_ar: row.brand_name_ar,
      category_id: row.category_id,
      price_from: money(row.price_from),
      price_to: money(row.price_to),
      image_id: row.image_id,
      availability: rollUp(variants),
      description_en: row.description_en,
      description_ar: row.description_ar,
      tax_rate: Number(row.tax_rate || 0),
      images,
      variants: variants.map((v) => ({
        id: v.id,
        label: v.label,
        price: money(v.price),
        availability: v.availability,
        image_id: v.image_id,
      })),
    };
  }

  // --------------------------------------------------------------- internals

  /** Cards for a known set of ids, returned in the order the ids were given. */
  async #cardsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await this.db.prepare(`
      SELECT ${CARD_COLUMNS}
      ${CARD_FROM}
      WHERE p.id IN (${placeholders}) AND ${PUBLISHED_PRODUCT}
    `).all(...ids);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    return this.#withAvailability(ordered);
  }

  /**
   * Attaches availability to a page of cards with ONE extra query, then rolls
   * the variants up in JavaScript. Prices are already on the row; only the
   * stock verdict needs the variants.
   */
  async #withAvailability(rows) {
    if (!rows.length) return [];
    const variants = await this.#variants(rows.map((row) => row.id));

    const byProduct = new Map();
    for (const variant of variants) {
      const list = byProduct.get(variant.product_id);
      if (list) list.push(variant);
      else byProduct.set(variant.product_id, [variant]);
    }

    return rows.map((row) => ({
      id: row.id,
      name_en: row.name_en,
      name_ar: row.name_ar,
      brand_id: row.brand_id,
      brand_name_en: row.brand_name_en,
      brand_name_ar: row.brand_name_ar,
      category_id: row.category_id,
      price_from: money(row.price_from),
      price_to: money(row.price_to),
      image_id: row.image_id,
      availability: rollUp(byProduct.get(row.id) || []),
    }));
  }

  /**
   * Active variants for a set of products — one query, never one per product.
   *
   * The stock comparison is done in SQL against a bound threshold, so what
   * comes back is already the word 'in_stock' | 'low' | 'out'. The quantity
   * and the reservation are summed inside the database and discarded there;
   * no stock number is ever bound to a JavaScript object in this process, which
   * is the only way to be sure one cannot be serialised out by accident.
   *
   * A product with `track_inventory = 0` is always sellable — services and
   * made-to-order lines have no shelf to run empty.
   */
  async #variants(productIds) {
    if (!productIds.length) return [];
    const threshold = await this.#lowStockThreshold();
    const placeholders = productIds.map(() => '?').join(', ');
    const available = `
      COALESCE((SELECT SUM(sl.quantity - sl.reserved_quantity)
                  FROM stock_levels sl WHERE sl.variant_id = v.id), 0)`;

    return this.db.prepare(`
      SELECT v.id            AS id,
             v.product_id    AS product_id,
             v.variant_label AS label,
             v.selling_price AS price,
             (SELECT iv.id FROM product_images iv
               WHERE iv.variant_id = v.id ORDER BY iv.display_order, iv.id LIMIT 1) AS image_id,
             CASE
               WHEN p.track_inventory = 0 THEN 'in_stock'
               WHEN ${available} <= 0 THEN 'out'
               WHEN ${available} <= ? THEN 'low'
               ELSE 'in_stock'
             END AS availability
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.is_active = 1
        AND v.product_id IN (${placeholders})
      ORDER BY v.product_id, v.id
    `).all(threshold, ...productIds);
  }

  async #lowStockThreshold() {
    const row = await this.db.prepare(
      'SELECT value, value_type FROM settings WHERE key = ?',
    ).get('shop.low_stock_threshold');
    const value = Number(decodeSetting(row?.value ?? null, row?.value_type));
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LOW_STOCK_THRESHOLD;
  }
}

/** Best verdict across a product's variants: one colour in stock means in stock. */
function rollUp(variants) {
  let rank = 0;
  for (const variant of variants) {
    rank = Math.max(rank, AVAILABILITY_RANK[variant.availability] ?? 0);
  }
  return variants.length ? RANK_AVAILABILITY[rank] : 'out';
}

export const storefrontService = new StorefrontService();
export default storefrontService;
