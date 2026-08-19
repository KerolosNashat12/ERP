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
 *
 * ONE EXCEPTION, added deliberately and at the owner's explicit request: the
 * product DETAIL endpoint also returns `available`, the exact number of units
 * of a variant. It is there so the quantity stepper can stop at what the shop
 * actually has, instead of the customer finding out after typing their name,
 * phone and address into checkout. The cost — a competitor can read one
 * product's stock, one product at a time — was weighed and accepted.
 *
 * It stops there. `products()` and `home()` still carry the word only, and
 * `#variants()` only selects the number when it is asked to, so a listing
 * cannot start leaking counts because somebody widened a shared query.
 */
import { getDb, currentTenant } from '../infrastructure/database/connection.js';
import { NotFoundError } from '../shared/errors.js';
import { buildBranding, companyNameFrom } from '../shared/branding.js';

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

  // --- website: banner
  'web.banner_heading_en', 'web.banner_heading_ar',
  'web.banner_text_en', 'web.banner_text_ar',
  'web.banner_cta_label_en', 'web.banner_cta_label_ar', 'web.banner_cta_link',
  'web.banner_overlay',
  'web.banner_align', 'web.banner_valign', 'web.banner_text_size',
  'web.banner_text_color', 'web.banner_box_width',

  // --- website: branding. Words that describe a shop rather than a product
  // category, and the two values the whole palette is derived from.
  'web.tagline_en', 'web.tagline_ar',
  'web.about_en', 'web.about_ar',
  'web.search_placeholder_en', 'web.search_placeholder_ar',
  'web.meta_description_en', 'web.meta_description_ar',
  'web.theme_accent', 'web.theme_dark',

  // --- website: social links + their visibility toggles
  'web.social_facebook', 'web.social_facebook_enabled',
  'web.social_instagram', 'web.social_instagram_enabled',
  'web.social_tiktok', 'web.social_tiktok_enabled',
  'web.social_youtube', 'web.social_youtube_enabled',
  'web.social_whatsapp', 'web.social_whatsapp_enabled',
  'web.social_x', 'web.social_x_enabled',

  // --- website: contact
  'web.contact_email', 'web.contact_phone',
  'web.contact_address_en', 'web.contact_address_ar',
  'web.contact_hours_en', 'web.contact_hours_ar',
  'web.contact_map_url',

  // --- shipping. shop.delivery_fee and shop.free_delivery_over are already
  // listed above and keep their meaning; these are the round-2 additions.
  'shop.delivery_mode', 'shop.delivery_percent', 'shop.delivery_min', 'shop.delivery_max',
];

/**
 * Banner text placement: physical positions the owner picked in the ERP
 * preview, shown identically in Arabic and English. A stored value outside
 * this list (hand-edited row, a future enum member this build predates) falls
 * back to the documented default rather than reaching the browser.
 */
const BANNER_ALIGN = ['right', 'center', 'left'];
const BANNER_VALIGN = ['top', 'middle', 'bottom'];
const BANNER_TEXT_SIZE = ['small', 'medium', 'large'];
const BANNER_TEXT_COLOR = ['light', 'dark'];
const DELIVERY_MODES = ['flat', 'percent'];

/** `value` if it is one of `allowed`, the documented default otherwise. */
const enumOr = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** Clamped into [min, max]; a non-finite stored value is the default, not 0. */
const clamped = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/** `network` key -> the `web.social_*` setting name it reads, in display order. */
const SOCIAL_NETWORKS = ['facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp', 'x'];

/**
 * A shop owner types a phone number, not a URL — `01001234567`,
 * `+20 100 123 4567`, spaces and all. Click-to-chat needs a `wa.me` link, so it
 * is built here rather than asked of the owner: strip everything but digits,
 * and a local leading `0` becomes the country code `20` (this shop is Egypt
 * only). A value that is already a URL (an owner who pasted a wa.me link
 * directly) is passed through untouched rather than mangled by digit-stripping.
 */
function whatsappUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const withCountryCode = digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
  return `https://wa.me/${withCountryCode}`;
}

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
    const [rows, assetRows] = await Promise.all([
      this.db.prepare(`
        SELECT key, value, value_type
        FROM settings
        WHERE key IN (${placeholders})
      `).all(...CONFIG_KEYS),
      // Existence only — never the bytes, and never a second table read of
      // anything the /banner and /logo routes themselves will stream.
      this.db.prepare("SELECT slot FROM web_assets WHERE slot IN ('banner', 'logo')").all(),
    ]);
    const slots = new Set(assetRows.map((row) => row.slot));

    const s = new Map(rows.map((r) => [r.key, decodeSetting(r.value, r.value_type)]));
    const num = (key, fallback = 0) => {
      const value = Number(s.get(key));
      return Number.isFinite(value) ? value : fallback;
    };
    const str = (key) => s.get(key) || null;

    const freeOver = num('shop.free_delivery_over', 0);

    const ctaLabelEn = str('web.banner_cta_label_en');
    const ctaLabelAr = str('web.banner_cta_label_ar');
    const ctaLink = str('web.banner_cta_link');

    // The shop's own name, and never a literal that belongs to one tenant —
    // see shared/branding.js, which the ERP shell resolves it through too.
    const companyName = companyNameFrom((key) => s.get(key), currentTenant());

    /**
     * Everything a shop's identity is made of, resolved server-side so the
     * browser receives values it can paint without a fallback of its own.
     * The rules themselves live in shared/branding.js — the ERP shell needs
     * the same block for its sidebar, and a monogram derived twice is a
     * monogram derived differently.
     */
    const branding = buildBranding({
      get: (key) => s.get(key),
      companyName,
      hasLogo: slots.has('logo'),
    });

    const social = SOCIAL_NETWORKS
      .filter((network) => Boolean(s.get(`web.social_${network}_enabled`)) && str(`web.social_${network}`))
      .map((network) => {
        const raw = s.get(`web.social_${network}`);
        return { network, url: network === 'whatsapp' ? whatsappUrl(raw) : raw };
      })
      .filter((entry) => Boolean(entry.url));

    return {
      // Missing row means nobody has ever configured the shop; the migration
      // seeds it enabled, so treat absence as enabled rather than dark.
      shopEnabled: s.get('shop.enabled') === null || s.get('shop.enabled') === undefined
        ? true
        : Boolean(s.get('shop.enabled')),
      companyName,
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

      branding,

      banner: {
        image: slots.has('banner') ? '/api/shop/banner' : null,
        heading: { en: str('web.banner_heading_en'), ar: str('web.banner_heading_ar') },
        text: { en: str('web.banner_text_en'), ar: str('web.banner_text_ar') },
        // null only when BOTH the label and the link are empty — a shop that
        // filled in one but not the other still gets a button, just a plainer one.
        cta: (ctaLabelEn || ctaLabelAr || ctaLink)
          ? { label: { en: ctaLabelEn, ar: ctaLabelAr }, link: ctaLink }
          : null,
        overlay: num('web.banner_overlay', 35),
        align: enumOr(s.get('web.banner_align'), BANNER_ALIGN, 'right'),
        valign: enumOr(s.get('web.banner_valign'), BANNER_VALIGN, 'middle'),
        size: enumOr(s.get('web.banner_text_size'), BANNER_TEXT_SIZE, 'medium'),
        textColor: enumOr(s.get('web.banner_text_color'), BANNER_TEXT_COLOR, 'light'),
        boxWidth: clamped(s.get('web.banner_box_width'), 30, 100, 45),
      },

      social,

      contact: {
        email: str('web.contact_email'),
        phone: str('web.contact_phone'),
        // Not `web.social_whatsapp_enabled`-gated: that toggle controls the
        // small icon row, but a shop that gave a WhatsApp number expects it on
        // its own contact page regardless of whether the icon is shown too.
        whatsapp: whatsappUrl(s.get('web.social_whatsapp')),
        address: { en: str('web.contact_address_en'), ar: str('web.contact_address_ar') },
        hours: { en: str('web.contact_hours_en'), ar: str('web.contact_hours_ar') },
        mapUrl: str('web.contact_map_url'),
      },

      // The shipping TERMS, for display — `deliveryFee` and `freeDeliveryOver`
      // above are unchanged and stay the top-level truth existing code reads.
      // The actual charge is only ever computed server side, in
      // WebOrderService, from these same settings via `deliveryFor()`.
      delivery: {
        mode: enumOr(s.get('shop.delivery_mode'), DELIVERY_MODES, 'flat'),
        fee: num('shop.delivery_fee', 0),
        percent: clamped(s.get('shop.delivery_percent'), 0, 100, 0),
        min: num('shop.delivery_min', 0) > 0 ? num('shop.delivery_min', 0) : null,
        max: num('shop.delivery_max', 0) > 0 ? num('shop.delivery_max', 0) : null,
        freeOver: freeOver > 0 ? freeOver : null,
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
      this.#variants([productId], { includeAvailable: true }),
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
        /**
         * The exact number of units left — quantity minus what is already
         * reserved, floored at 0; null when the product is not stock-tracked,
         * meaning unlimited.
         *
         * DELIBERATE, AND DELIBERATELY ONLY HERE. The shop owner asked for it
         * so the quantity stepper can refuse to go past what exists rather than
         * letting the customer discover it at the end of checkout. Every other
         * method in this file returns the WORD ('in_stock' | 'low' | 'out') and
         * must keep doing so: a number on a listing publishes the shop's whole
         * position in one request. Do not "tidy" this field up into
         * `#withAvailability()`, `products()` or `home()`.
         *
         * This is UX. The real guard is `WebOrderService.place()`, which
         * re-checks every line inside the ordering transaction.
         */
        available: v.available === null || v.available === undefined
          ? null
          : Number(v.available),
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
   *
   * `includeAvailable` is the one way the raw count can be selected at all, and
   * exactly one caller passes it: `product()`. Everything else gets the word
   * and no number, so the default is still the safe one.
   */
  async #variants(productIds, { includeAvailable = false } = {}) {
    if (!productIds.length) return [];
    const threshold = await this.#lowStockThreshold();
    const placeholders = productIds.map(() => '?').join(', ');
    const available = `
      COALESCE((SELECT SUM(sl.quantity - sl.reserved_quantity)
                  FROM stock_levels sl WHERE sl.variant_id = v.id), 0)`;

    // Whole units only, never negative — a reservation that has overrun the
    // shelf is 0 left to sell, not a negative cap the stepper would misread.
    // NULL for an untracked product: unlimited, not zero.
    const availableColumn = includeAvailable ? `
             CASE WHEN p.track_inventory = 0 THEN NULL
                  ELSE MAX(CAST(${available} AS INTEGER), 0) END AS available,` : '';

    return this.db.prepare(`
      SELECT v.id            AS id,
             v.product_id    AS product_id,
             v.variant_label AS label,
             v.selling_price AS price,
             (SELECT iv.id FROM product_images iv
               WHERE iv.variant_id = v.id ORDER BY iv.display_order, iv.id LIMIT 1) AS image_id,${availableColumn}
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
