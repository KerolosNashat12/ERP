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
import { GENDERS, offerPrice } from '../shared/pricing.js';
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
  // The second, quieter button — "our story" beside "explore the collection".
  // Optional: a shop that fills in neither gets the one button it always had.
  'web.banner_cta2_label_en', 'web.banner_cta2_label_ar', 'web.banner_cta2_link',
  // The three figures under the banner. Off by default: a shop with eleven
  // products should not announce that it has eleven products.
  'web.stats_enabled',
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

  /*
   * Which of the two storefronts this shop wears. It has to be in THIS list,
   * not just in the settings table: `config()` fetches exactly these keys in
   * one query and hands the result to `buildBranding()` as its whole world, so
   * a key missing here does not read as "unset" somewhere harmless — it reads
   * as unset to `normalizeTemplate()`, which answers 'classic' by design.
   *
   * That is what happened on this feature's first build. Every other piece was
   * right — the migration, the enum, the SSR, the picker — and the storefront
   * still came back 'classic' for a shop that had chosen 'luxe', because the
   * one query never asked for the row. It looked correct while testing,
   * because 'classic' is also the default; the failure mode of a missing key
   * here is a setting that saves, reports success, and does nothing.
   */
  'web.template',

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

/**
 * How many ids one `products({ ids })` call will look up.
 *
 * The favourites page hands us a list the customer built themselves, so the
 * length is theirs to decide and this is the only thing stopping one request
 * from turning into a thousand bound parameters and a table scan per id. 60 is
 * a little over two full screens of cards — more than any real favourites list
 * and still comfortably inside SQLite's default 999-parameter limit once the
 * card query has bound them all. `core/favorites.js` caps the browser's own
 * list at the same number, so a shopper never quietly loses a card they can
 * see in their list: the client stops adding before the server starts cutting.
 */
const MAX_IDS = 60;

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
  /*
   * Deleted is deleted, on the public side too.
   *
   * This gate is the storefront's own — deliberately not the ERP's shared
   * predicate, because it must never reveal an unpublished product — so the
   * recycle bin has to be named here as well. It was not, and a product the
   * shop had deleted went on being offered for sale on the website while the
   * ERP had already hidden it. The bin is the one place that decides what
   * "deleted" means; every screen, public or private, asks it the same way.
   *
   * The brand and the category are asked too: a brand in the bin must not lead
   * a shopper to a page of products that are still perfectly published.
   */
  AND NOT EXISTS (SELECT 1 FROM trash_items tp
                   WHERE tp.entity_type = 'product' AND tp.entity_id = p.id
                     AND tp.status = 'in_bin')
  AND NOT EXISTS (SELECT 1 FROM trash_items tb
                   WHERE tb.entity_type = 'brand' AND tb.entity_id = p.brand_id
                     AND tb.status = 'in_bin')
  AND NOT EXISTS (SELECT 1 FROM trash_items tc
                   WHERE tc.entity_type = 'category' AND tc.entity_id = p.category_id
                     AND tc.status = 'in_bin')
  AND (p.brand_id IS NULL OR EXISTS (
        SELECT 1 FROM brands bg WHERE bg.id = p.brand_id AND bg.is_published = 1))
  AND (p.category_id IS NULL OR EXISTS (
        SELECT 1 FROM categories cg WHERE cg.id = p.category_id AND cg.is_published = 1))
  AND EXISTS (
        SELECT 1 FROM product_variants vg WHERE vg.product_id = p.id AND vg.is_active = 1)
`;


/**
 * One value, several comma-separated values, or an array — all read as a list.
 *
 * `?gender=women&gender=men`, `?gender=women,men` and a JSON array from the
 * favourites page all mean the same thing to a shopper, so they mean the same
 * thing here. Blank entries are dropped, which is what an untouched checkbox
 * group sends.
 */
const asList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(','))
  .map((entry) => String(entry).trim())
  .filter(Boolean);

/** A checkbox, over a query string: `1`, `true`, `on` and `yes` all mean yes. */
const isTrue = (value) => ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase());


/**
 * The two prices a card shows, from the one rule.
 *
 * `price_from` / `price_to` are always WHAT IS CHARGED — so a page that knows
 * nothing about offers still prints the right number — and the old prices ride
 * alongside them, present only when there is a real saving to show. That is
 * deliberate: a card cannot accidentally strike through a price that is not
 * actually lower, because when the offer is off these fields are simply not
 * there.
 *
 * `discount_percent` is a whole number for the badge. It is computed from the
 * range's LOW end, which is the number the card leads with; a product whose
 * variants are priced differently discounts them all at the same rate anyway,
 * so the badge is true of every one of them.
 */
/**
 * The one-tap half of a card: the variant to add, or nothing.
 *
 * Deliberately not `single_variant_id` verbatim. A product with three variants
 * still has a first one, and sending it under a name like `variant_id` is how a
 * shopper ends up with the 30ml in their basket because they tapped a card for
 * a bottle that also comes in 100ml. The id only survives the count check.
 */
function cardVariant(row) {
  const count = Number(row.variant_count || 0);
  return {
    variant_count: count,
    variant_id: count === 1 ? Number(row.single_variant_id) || null : null,
    tax_rate: Number(row.tax_rate || 0),
  };
}

function cardPricing(row) {
  const from = offerPrice(row.price_from, row);
  const to = offerPrice(row.price_to, row);
  if (!from.onSale && !to.onSale) {
    return {
      price_from: money(row.price_from),
      price_to: money(row.price_to),
      on_sale: false,
      discount_percent: 0,
    };
  }
  return {
    price_from: money(from.price),
    price_to: money(to.price),
    list_price_from: money(from.listPrice),
    list_price_to: money(to.listPrice),
    on_sale: true,
    discount_percent: from.percent || to.percent,
  };
}

/**
 * Is this product's offer running today, in SQL?
 *
 * The same four conditions as `offerRunning` in shared/pricing.js, in the one
 * place a filter, a facet count and a sort need them — everything a shopper
 * SEES is still priced by the JavaScript rule, so there is exactly one
 * implementation of the arithmetic; this is only for the questions a database
 * has to answer for itself: which rows are on sale, and in what order.
 *
 * `date('now')` is UTC, and so is the `today()` the JavaScript side uses. That
 * they agree is the point; that Cairo is two or three hours ahead of both means
 * an offer set to end "on the 30th" stops at 2 or 3 a.m. on the 31st local
 * time, which is a shop's quiet hour and the safe direction to be wrong in.
 */
const OFFER_RUNNING = `
  p.discount_type <> 'none'
  AND p.discount_value > 0
  AND (p.discount_starts_on IS NULL OR date(p.discount_starts_on) <= date('now'))
  AND (p.discount_ends_on   IS NULL OR date(p.discount_ends_on)   >= date('now'))
`;

/**
 * A price with the offer applied, in SQL. `price` is any expression in pounds.
 *
 * Mirrors `offerPrice()` clause for clause: a percent is clamped to 0–100, an
 * amount is clamped to the price itself, the floor is zero and the result is
 * rounded to two decimals. A price filter that disagreed with the price on the
 * card by one piastre would put a product outside a range the shopper can see
 * it inside, which is the kind of bug that gets reported as "your filter is
 * broken" and is impossible to reproduce by hand.
 */
const offerPriceSql = (price) => `
  CASE WHEN ${OFFER_RUNNING} THEN
    CASE WHEN p.discount_type = 'percent'
      THEN ROUND(MAX(${price} - ROUND(${price} * (MIN(MAX(p.discount_value, 0), 100) / 100.0), 2), 0), 2)
      ELSE ROUND(MAX(${price} - MIN(MAX(p.discount_value, 0), ${price}), 0), 2)
    END
  ELSE ${price} END
`;

/** The lowest price a shopper would actually pay for this product today. */
const EFFECTIVE_PRICE_FROM = offerPriceSql(`(SELECT MIN(vp.selling_price) FROM product_variants vp
    WHERE vp.product_id = p.id AND vp.is_active = 1)`);

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
  -- Who it is for, and the offer on it. The card sends both what is charged
  -- and what it was; the arithmetic that turns these four columns into those
  -- two numbers is offerPrice() in shared/pricing.js, applied once, in
  -- withAvailability below.
  p.gender            AS gender,
  p.discount_type     AS discount_type,
  p.discount_value    AS discount_value,
  p.discount_starts_on AS discount_starts_on,
  p.discount_ends_on  AS discount_ends_on,
  COALESCE(
    (SELECT ip.id FROM product_images ip
      WHERE ip.id = p.primary_image_id AND ip.product_id = p.id),
    (SELECT i2.id FROM product_images i2
      WHERE i2.product_id = p.id ORDER BY i2.display_order, i2.id LIMIT 1)
  ) AS image_id,
  /*
   * ENOUGH TO PUT THIS CARD IN A BASKET, WHEN THERE IS ONLY ONE THING TO PUT.
   *
   * A card carried a price range and no variant, which is correct for drawing
   * a card and useless for the "add to cart" the design puts on one: a basket
   * line is a VARIANT, and a product with three sizes has no single answer.
   *
   * So the question is asked here rather than guessed at in the browser. A
   * product with exactly one active variant sends that variant's id and its
   * tax rate, and a card can add it in one tap. A product with two or more
   * sends variant_count above one and no id at all - the card then takes the
   * shopper to the page where the choice actually exists, which is the honest
   * behaviour and the one the reference design has too the moment a product
   * has options.
   *
   * variant_id is NULL rather than absent for a multi-variant product, so a
   * client can tell "there is no single variant" from "this field is missing
   * because the server is old".
   */
  (SELECT COUNT(*) FROM product_variants vc
    WHERE vc.product_id = p.id AND vc.is_active = 1) AS variant_count,
  (SELECT vs.id FROM product_variants vs
    WHERE vs.product_id = p.id AND vs.is_active = 1
    LIMIT 2) AS single_variant_id,
  p.tax_rate AS tax_rate
`;

const CARD_FROM = `
  FROM products p
  LEFT JOIN brands b ON b.id = p.brand_id
`;

/** Whitelist — the sort key arrives from a query string and is never interpolated. */
const SORTS = {
  newest: 'COALESCE(p.published_at, p.created_at) DESC, p.id DESC',
  /*
   * Sorted by what the shopper would PAY, not by the ticket price — a piece
   * marked 3,200 and selling at 800 belongs at the cheap end of "price: low to
   * high", which is the only reading of that control that is not a lie.
   */
  price_asc: 'effective_price ASC, p.id DESC',
  price_desc: 'effective_price DESC, p.id DESC',
  name: 'p.name_en COLLATE NOCASE ASC, p.id DESC',
  // Biggest saving first. Only meaningful next to the "on sale" filter, and
  // ordered by the RATE rather than the money so a 50%-off 200 beats a
  // 5%-off 3,000 — which is how a shopper reads a sale rail.
  discount: `CASE WHEN ${OFFER_RUNNING} THEN 0 ELSE 1 END ASC,
             CASE WHEN p.discount_type = 'percent' THEN p.discount_value ELSE 0 END DESC,
             p.id DESC`,
};

/** 'in_stock' beats 'low' beats 'out' when rolling variants up to their product. */
const AVAILABILITY_RANK = { out: 0, low: 1, in_stock: 2 };
const RANK_AVAILABILITY = ['out', 'low', 'in_stock'];

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The `ids` option, turned into a clean list of product ids.
 *
 * Returns null when the caller did not ask for a by-id lookup at all — that is
 * the ONLY thing that distinguishes "browse the catalogue" from "these exact
 * products". `ids=` with nothing after it, or `ids=nonsense`, is a caller who
 * asked for a specific set and gets an empty answer; it must never fall through
 * to the whole shop, because a favourites page whose list failed to parse would
 * then show the entire catalogue as the customer's favourites.
 *
 * Junk is dropped rather than refused: this list came out of somebody's
 * localStorage, which is user input and has been through however many versions
 * of the site. `Number.parseInt` is deliberately not used — it reads '12abc' as
 * 12, and a value that is not a plain run of digits is not an id we wrote.
 * Duplicates are collapsed so a doubled favourite cannot spend the cap twice or
 * come back as two identical cards.
 */
function parseIds(raw) {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const seen = new Set();
  for (const entry of list) {
    const value = String(entry).trim();
    if (!/^\d+$/.test(value)) continue;
    const id = Number(value);
    if (id > 0) seen.add(id);
    if (seen.size >= MAX_IDS) break;
  }
  return [...seen];
}

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
    const cta2LabelEn = str('web.banner_cta2_label_en');
    const cta2LabelAr = str('web.banner_cta2_label_ar');
    const cta2Link = str('web.banner_cta2_link');

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
        /*
         * The second button. Same rule as the first — present when the shop
         * typed ANY of its three fields — so a half-filled pair still produces
         * a button rather than vanishing and leaving the owner wondering which
         * of the three fields was the wrong one.
         */
        cta2: (cta2LabelEn || cta2LabelAr || cta2Link)
          ? { label: { en: cta2LabelEn, ar: cta2LabelAr }, link: cta2Link }
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
    const [newest, featured, categories, brands, stats] = await Promise.all([
      this.products({ sort: 'newest', pageSize: HOME_SIZE }).then((r) => r.rows),
      this.#featured(HOME_SIZE),
      this.categories(),
      this.brands(),
      this.#stats(),
    ]);
    return {
      newest,
      featured: featured.rows,
      /**
       * The three figures under the banner — REAL, counted now, or absent.
       *
       * The design this came from prints "387+ PRODUCTS · 45+ BRANDS · Free
       * SHIPPING", and the temptation is to treat those as decoration and type
       * them into the page. They are claims a shop is making to its customers
       * on its own front page, so they are counted from the catalogue this
       * shopper is actually looking at.
       *
       * `null` when the shop has not switched the strip on — see `#stats`.
       */
      stats,
      /**
       * Whether the "best sellers" shelf actually contains a best seller.
       *
       * The owner asked for the shelf and the shelf is topped up with new
       * arrivals so a quiet week does not leave a gap — which means a shop that
       * has never sold anything gets a shelf made ENTIRELY of its newest
       * products with the words "الأكثر مبيعًا" printed over them. That is a
       * lie, on the shop's own front page, about the one thing a shopper reads
       * a best-seller shelf for: what other people bought.
       *
       * `#featured` is the only code that can tell the difference, and it used
       * to throw the knowledge away. It is reported here instead of being acted
       * on, because whether a half-real shelf is worth showing is a design
       * decision and this file's job is only to stop the page from guessing.
       */
      featuredFromSales: featured.fromSales,
      categories,
      brands,
    };
  }

  /**
   * The banner's three figures. Counted, never typed — and honest about the
   * rounding.
   *
   * ── Why the numbers are rounded DOWN ────────────────────────────────────
   * "248 products" is a strange thing to put on a shop front; "240+" is the
   * register the design is written in. Rounding down and adding "+" keeps it
   * literally true — a shop with 248 products does have more than 240 — where
   * rounding to the NEAREST would let a shop with 248 claim 250, which it does
   * not have. The step scales so the claim never gets vague: under 50 the
   * exact number is shown, because "40+" from a shop with 44 products throws
   * away more than it tidies.
   *
   * ── Why delivery is a THIRD kind of thing ───────────────────────────────
   * The reference says "Free SHIPPING", and that is only true of a shop that
   * gives it. This reports what the shop's OWN delivery settings say, so a
   * shop that charges says what it charges. Writing "Free shipping" over a
   * shop that charges 50 EGP is a promise the checkout then breaks, and the
   * customer finds out at the last screen.
   *
   * Returns null when the strip is switched off, which is the DEFAULT: a shop
   * with eleven products should not announce that it has eleven products.
   */
  async #stats() {
    const row = await this.db
      .prepare("SELECT value FROM settings WHERE key = 'web.stats_enabled'")
      .get();
    const raw = String(row?.value ?? '').trim().toLowerCase();
    if (!['1', 'true', 'yes', 'on'].includes(raw)) return null;

    const [products, brands, delivery] = await Promise.all([
      this.db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${PUBLISHED_PRODUCT}`).get(),
      this.db.prepare(`
        SELECT COUNT(*) AS n FROM brands b
        WHERE EXISTS (SELECT 1 FROM products p
                       WHERE p.brand_id = b.id AND ${PUBLISHED_PRODUCT})
      `).get(),
      this.db.prepare(`
        SELECT key, value FROM settings
        WHERE key IN ('shop.free_delivery_over', 'shop.delivery_fee', 'shop.delivery_mode',
                      'shop.delivery_percent', 'shop.delivery_min')
      `).all(),
    ]);

    const d = new Map(delivery.map((r) => [r.key, r.value]));
    const freeOver = Number(d.get('shop.free_delivery_over')) || 0;
    const mode = d.get('shop.delivery_mode') === 'percent' ? 'percent' : 'flat';
    const flat = Number(d.get('shop.delivery_fee')) || 0;
    const percent = Number(d.get('shop.delivery_percent')) || 0;
    const charges = mode === 'percent' ? percent > 0 : flat > 0;

    return {
      products: Number(products?.n || 0),
      brands: Number(brands?.n || 0),
      /*
       * Everything the page needs to SAY something true about delivery, with
       * no sentence built here — the wording lives in the storefront's own
       * dictionary in both languages, and the money goes through its
       * formatter so it carries this shop's currency.
       */
      delivery: {
        alwaysFree: !charges,
        freeOver: freeOver > 0 ? freeOver : null,
        mode,
        flat,
        percent,
      },
    };
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

    /**
     * `{ rows, fromSales }` rather than the bare array: the cards are unchanged,
     * and `fromSales` is the one bit `home()` cannot work out for itself once
     * the best sellers and the filler have been merged into one list.
     *
     * Measured against the cards that actually came back, not against `best`,
     * so a product that sold and was unpublished in between — dropped by the
     * publish gate inside `#cardsByIds` — cannot vouch for a shelf it is not on.
     */
    const soldIds = new Set(best.map((row) => row.id));
    const rows = await this.#cardsByIds(ids);
    return { rows, fromSales: rows.some((row) => soldIds.has(row.id)) };
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
             -- Whether this shop uploaded a picture for it. The bytes are NOT
             -- sent here - the tile asks for them by URL, the same way a brand
             -- logo works - and a category with none is the ordinary case, not
             -- a gap: the storefront draws its own icon instead.
             EXISTS (SELECT 1 FROM web_assets w WHERE w.slot = 'category:' || c.id) AS has_image,
             (SELECT COUNT(*) FROM products p
               WHERE p.category_id = c.id AND ${PUBLISHED_PRODUCT}) AS product_count
      FROM categories c
      WHERE c.is_active = 1
        AND c.is_published = 1
        AND NOT EXISTS (SELECT 1 FROM trash_items tc
                         WHERE tc.entity_type = 'category' AND tc.entity_id = c.id
                           AND tc.status = 'in_bin')
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
      SELECT b.id       AS id,
             b.name_en  AS name_en,
             b.name_ar  AS name_ar,
             -- The storefront never used to read either of these. The brands
             -- rail does: a picture the shop uploaded, a URL it recorded, or the
             -- brand's first letter — in that order.
             b.logo_url AS logo_url,
             EXISTS (SELECT 1 FROM web_assets w WHERE w.slot = 'brand:' || b.id) AS has_logo,
             NULL       AS parent_id,
             (SELECT COUNT(*) FROM products p
               WHERE p.brand_id = b.id AND ${PUBLISHED_PRODUCT}) AS product_count
      FROM brands b
      WHERE b.is_active = 1
        AND b.is_published = 1
        AND NOT EXISTS (SELECT 1 FROM trash_items tb2
                         WHERE tb2.entity_type = 'brand' AND tb2.entity_id = b.id
                           AND tb2.status = 'in_bin')
        AND EXISTS (SELECT 1 FROM products p
                     WHERE p.brand_id = b.id AND ${PUBLISHED_PRODUCT})
      ORDER BY b.name_en COLLATE NOCASE
    `).all();
  }

  // ---------------------------------------------------------------- browsing


  /**
   * The checkbox half of the filter panel, turned into SQL.
   *
   * One method rather than five inline blocks, because the LISTING and the
   * FACET COUNTS have to agree exactly: a panel that says "على الخصم (7)" and
   * then shows six products is a panel nobody trusts a second time.
   *
   * Every value is bound, never interpolated — these arrive from a query string
   * a stranger controls. The attribute ids are the only list, and they are
   * mapped through `Number` and filtered to real integers before a single one
   * reaches a placeholder.
   */
  async #facetClauses({ gender, onSale, minPrice, maxPrice, attr, inStock } = {}) {
    const where = [];
    const params = [];

    const genders = asList(gender).filter((value) => GENDERS.includes(value));
    if (genders.length) {
      where.push(`p.gender IN (${genders.map(() => '?').join(', ')})`);
      params.push(...genders);
    }

    if (isTrue(onSale)) where.push(`(${OFFER_RUNNING})`);

    // Against the price she would pay, offer included. See the doc above.
    const min = Number(minPrice);
    if (Number.isFinite(min) && min > 0) {
      where.push(`${EFFECTIVE_PRICE_FROM} >= ?`);
      params.push(min);
    }
    const max = Number(maxPrice);
    if (Number.isFinite(max) && max > 0) {
      where.push(`${EFFECTIVE_PRICE_FROM} <= ?`);
      params.push(max);
    }

    /*
     * Attribute values: OR inside one attribute, AND across attributes.
     * The grouping is done by reading each value's own attribute out of the
     * database rather than trusting the shape of the query string, so
     * `attr=3,4` behaves identically whether 3 and 4 are two sizes or a size
     * and a colour.
     */
    const values = asList(attr).map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (values.length) {
      const groups = await this.#groupAttributeValues(values);
      for (const group of groups) {
        where.push(`EXISTS (
          SELECT 1 FROM variant_attribute_values vav
            JOIN product_variants vv ON vv.id = vav.variant_id
           WHERE vv.product_id = p.id AND vv.is_active = 1
             AND vav.attribute_value_id IN (${group.map(() => '?').join(', ')})
        )`);
        params.push(...group);
      }
    }

    if (isTrue(inStock)) {
      /*
       * "On the shelf" means unreserved. A piece already promised to an order
       * that has not gone out yet is not available to the next shopper, and a
       * filter that counted it would send her to a product page that says
       * غير متوفر — worse than not showing it at all.
       */
      where.push(`EXISTS (
        SELECT 1 FROM product_variants vs
          JOIN stock_levels sls ON sls.variant_id = vs.id
         WHERE vs.product_id = p.id AND vs.is_active = 1
           AND (sls.quantity - sls.reserved_quantity) > 0
      )`);
    }

    return { where, params };
  }

  /**
   * Attribute value ids, split into one list per attribute they belong to.
   *
   * An id the shop does not have is dropped rather than refused: these come out
   * of a URL somebody may have bookmarked before the shop tidied its
   * attributes, and a stale link should show a wider result, never an error
   * page.
   */
  async #groupAttributeValues(ids) {
    const rows = await this.db.prepare(`
      SELECT id, attribute_id FROM attribute_values
       WHERE id IN (${ids.map(() => '?').join(', ')})
    `).all(...ids);
    const byAttribute = new Map();
    for (const row of rows) {
      const list = byAttribute.get(row.attribute_id);
      if (list) list.push(row.id);
      else byAttribute.set(row.attribute_id, [row.id]);
    }
    return [...byAttribute.values()];
  }


  /**
   * What the filter panel is built from: every option a shopper can tick, with
   * how many products are behind each one.
   *
   * ── The counting rule, stated because it is a choice ────────────────────
   * Counts are measured against the SCOPE the shopper is in — this category,
   * this brand, this search — but NOT against the boxes she has already
   * ticked. Tick «حريمي» and the price range still says how many pieces the
   * shop has in each band overall.
   *
   * The alternative, recounting every facet against every other filter, is what
   * the big shops do and it costs one query per dimension per keystroke. For a
   * shop this size it would buy a subtlety nobody has asked for, at the price
   * of a filter panel that flickers. What it must never do is claim a count
   * the listing then contradicts, and it cannot: both are built from
   * `#facetClauses`, over the same scope, in the same file.
   *
   * The price band comes back as the real minimum and maximum a shopper would
   * PAY, so the two ends of a slider are always reachable.
   */
  async filters({ category, brand, q } = {}) {
    const where = [PUBLISHED_PRODUCT];
    const params = [];

    const categoryId = toInt(category, null);
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
    const brandId = toInt(brand, null);
    if (brandId) { where.push('p.brand_id = ?'); params.push(brandId); }
    const term = String(q ?? '').trim();
    if (term) {
      where.push(`(p.name_en LIKE ? ESCAPE '\\'
               OR p.name_ar LIKE ? ESCAPE '\\'
               OR p.tags    LIKE ? ESCAPE '\\')`);
      const like = likeTerm(term);
      params.push(like, like, like);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [genders, sale, band, attributes] = await Promise.all([
      this.db.prepare(`
        SELECT p.gender AS gender, COUNT(*) AS product_count
        ${CARD_FROM} ${whereSql}
        GROUP BY p.gender
      `).all(...params),

      this.db.prepare(`
        SELECT COUNT(*) AS product_count
        ${CARD_FROM} ${whereSql} AND ${OFFER_RUNNING}
      `).get(...params),

      this.db.prepare(`
        SELECT MIN(${EFFECTIVE_PRICE_FROM}) AS min_price,
               MAX(${EFFECTIVE_PRICE_FROM}) AS max_price
        ${CARD_FROM} ${whereSql}
      `).get(...params),

      /*
       * Only attributes the shop actually uses on products a shopper can see —
       * a colour nobody has stocked is a dead checkbox, and a filter panel full
       * of them is how a small catalogue looks empty.
       */
      this.db.prepare(`
        SELECT a.id        AS attribute_id,
               a.code      AS attribute_code,
               a.name_en   AS attribute_name_en,
               a.name_ar   AS attribute_name_ar,
               a.input_type AS input_type,
               av.id       AS value_id,
               av.value_en AS value_en,
               av.value_ar AS value_ar,
               av.color_hex AS color_hex,
               COUNT(DISTINCT p.id) AS product_count
        FROM attribute_values av
        JOIN attributes a ON a.id = av.attribute_id AND a.is_active = 1
        JOIN variant_attribute_values vav ON vav.attribute_value_id = av.id
        JOIN product_variants pv ON pv.id = vav.variant_id AND pv.is_active = 1
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN brands b ON b.id = p.brand_id
        ${whereSql.replace('WHERE', 'WHERE av.is_active = 1 AND')}
        GROUP BY av.id
        HAVING product_count > 0
        ORDER BY a.display_order, a.id, av.display_order, av.id
      `).all(...params),
    ]);

    const byAttribute = new Map();
    for (const row of attributes) {
      const key = row.attribute_id;
      if (!byAttribute.has(key)) {
        byAttribute.set(key, {
          id: key,
          code: row.attribute_code,
          name_en: row.attribute_name_en,
          name_ar: row.attribute_name_ar,
          input_type: row.input_type,
          values: [],
        });
      }
      byAttribute.get(key).values.push({
        id: row.value_id,
        value_en: row.value_en,
        value_ar: row.value_ar,
        color_hex: row.color_hex,
        product_count: Number(row.product_count || 0),
      });
    }

    const counts = new Map(genders.map((row) => [row.gender, Number(row.product_count || 0)]));
    return {
      genders: GENDERS
        .map((value) => ({ value, product_count: counts.get(value) || 0 }))
        .filter((row) => row.product_count > 0),
      onSale: Number(sale?.product_count || 0),
      price: {
        min: Math.floor(Number(band?.min_price || 0)),
        max: Math.ceil(Number(band?.max_price || 0)),
      },
      attributes: [...byAttribute.values()],
    };
  }

  /**
   * The catalogue listing: filter, sort, paginate.
   *
   * ── The filters, and what each one means ────────────────────────────────
   *   gender    'women' | 'men' | 'unisex', or several at once. Several means
   *             OR, because a shopper ticking two boxes is widening her search,
   *             never narrowing it to products that are somehow both.
   *   onSale    only what is discounted TODAY.
   *   minPrice  measured against what she would PAY, offer included. A filter
   *   maxPrice  that measured the ticket price would hide a 3,200 bottle
   *             selling at 800 from somebody shopping under 1,000 — the exact
   *             shopper the offer exists to catch.
   *   attr      attribute value ids (size, colour, concentration...). Values of
   *             the SAME attribute are OR — 30ml or 50ml — and different
   *             attributes are AND — 30ml AND black. That is what every shop
   *             online does, and doing anything else makes a filter panel feel
   *             broken without the shopper being able to say why.
   *   inStock   something on the shelf right now. Uses the same reservation
   *             maths the product page shows, so it cannot promise a piece the
   *             checkout would then refuse.
   */
  async products({
    category, brand, q, sort, page, pageSize, ids,
    gender, onSale, minPrice, maxPrice, attr, inStock,
  } = {}) {
    const wanted = parseIds(ids);
    if (wanted) {
      // The publish gate lives inside `#cardsByIds`, so a product the shop has
      // taken down since the customer favourited it is simply absent from the
      // answer — the page shows it as removed rather than the shop leaking it.
      const rows = await this.#cardsByIds(wanted);
      return {
        rows, total: rows.length, page: 1, pageSize: rows.length, pages: 1,
      };
    }

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

    const facet = await this.#facetClauses({
      gender, onSale, minPrice, maxPrice, attr, inStock,
    });
    where.push(...facet.where);
    params.push(...facet.params);

    const whereSql = `WHERE ${where.join(' AND ')}`;
    /*
     * `Object.hasOwn`, not a bare lookup: `?sort=constructor` finds an inherited
     * property, which is truthy, and would be interpolated into ORDER BY. No
     * attacker-chosen SQL comes out of that - the value is a function, not a
     * string - but a public URL that returns a 500 is a public URL somebody
     * will keep pulling on.
     */
    const orderSql = Object.hasOwn(SORTS, String(sort)) ? SORTS[sort] : SORTS.newest;
    const size = Math.min(Math.max(toInt(pageSize, DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
    const current = Math.max(toInt(page, 1), 1);

    const counted = await this.db.prepare(`
      SELECT COUNT(*) AS n FROM products p ${whereSql}
    `).get(...params);
    const total = Number(counted?.n || 0);

    const rows = await this.db.prepare(`
      SELECT ${CARD_COLUMNS},
             ${EFFECTIVE_PRICE_FROM} AS effective_price
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
    const [variants, images, options] = await Promise.all([
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
      this.#variantOptions(productId),
    ]);

    return {
      id: row.id,
      name_en: row.name_en,
      name_ar: row.name_ar,
      brand_id: row.brand_id,
      brand_name_en: row.brand_name_en,
      brand_name_ar: row.brand_name_ar,
      category_id: row.category_id,
      ...cardPricing(row),
      gender: row.gender || 'unisex',
      image_id: row.image_id,
      availability: rollUp(variants),
      description_en: row.description_en,
      description_ar: row.description_ar,
      tax_rate: Number(row.tax_rate || 0),
      images,
      variants: variants
        .map((v) => ({ ...v, offer: offerPrice(v.price, row) }))
        .map((v) => ({
        id: v.id,
        label: v.label,
        /*
         * Every variant is priced by the same rule as the card above it, so
         * choosing 50ml on a product that is 20% off shows the 50ml offer
         * price — not the ticket price, and not the 30ml one. `list_price` is
         * present only while an offer runs, for the struck-through number.
         */
        price: money(v.offer.price),
        list_price: v.offer.onSale ? money(v.offer.listPrice) : null,
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
        /**
         * What this variant IS, in the shop's own words: `الحجم: ٣٠ مل`,
         * `اللون: أسود`. Empty for a shop that never set an attribute up, which
         * is why the storefront still falls back to `variant_label`.
         */
        options: options.get(v.id) || [],
      })),
    };
  }

  // ----------------------------------------------------------------- sitemap

  /**
   * How many products a crawler is allowed to be told about.
   *
   * Same gate as every other public query — `PUBLISHED_PRODUCT` — which is the
   * only reason a sitemap cannot become the one place next season's range leaks
   * from. A sitemap is read by a machine that will fetch every address in it,
   * so "listed but hidden" is not a smaller mistake here than it is on a page;
   * it is a bigger one.
   */
  async sitemapCount() {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS n FROM products p WHERE ${PUBLISHED_PRODUCT}
    `).get();
    return Number(row?.n || 0);
  }

  /**
   * One page of the sitemap, and never more than one.
   *
   * A shop with 5,000 products would be 5,000 rows and several megabytes of XML
   * built in a serverless function with a memory limit and a wall clock. So the
   * sitemap is an index of shards and this answers exactly one of them: one
   * bounded query, `LIMIT`/`OFFSET` on the primary key, a fixed number of rows
   * whatever the catalogue grows to. The index itself costs one `COUNT(*)`.
   *
   * Five columns, named, as everything in this file is: an id, the two names
   * the address is built from, a timestamp, and the id of one photograph. No
   * price, no stock, no cost — a sitemap is a public document and this one is
   * generated from the same doctrine as the pages it points at.
   */
  async sitemapProducts({ offset = 0, limit = 1000 } = {}) {
    return this.db.prepare(`
      SELECT p.id      AS id,
             p.name_en AS name_en,
             p.name_ar AS name_ar,
             COALESCE(p.updated_at, p.published_at, p.created_at) AS lastmod,
             COALESCE(
               (SELECT ip.id FROM product_images ip
                 WHERE ip.id = p.primary_image_id AND ip.product_id = p.id),
               (SELECT i2.id FROM product_images i2
                 WHERE i2.product_id = p.id ORDER BY i2.display_order, i2.id LIMIT 1)
             ) AS image_id
      FROM products p
      WHERE ${PUBLISHED_PRODUCT}
      ORDER BY p.id
      LIMIT ? OFFSET ?
    `).all(limit, offset);
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
      ...cardPricing(row),
      // What it takes to add this card to a basket in one tap, when the
      // product has exactly one thing to add. See cardVariant().
      ...cardVariant(row),
      gender: row.gender || 'unisex',
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

  /**
   * The attributes behind a product's variants — the NAMES, not just the labels.
   *
   * `variant_label` is a shorthand somebody typed ("30ml / Black"); it is one
   * string and it does not say what either half of it means. The shop has
   * already recorded the real thing — an attribute with a name, and a value with
   * a name and sometimes a colour — and until now the storefront never read it,
   * so a customer picking between nine options was picking between nine
   * transliterated words with no heading over them.
   *
   * One query per product page. Only the detail page needs this: a listing
   * shows a card, not a choice.
   */
  async #variantOptions(productId) {
    const rows = await this.db.prepare(`
      SELECT vav.variant_id        AS variant_id,
             a.id                  AS attribute_id,
             a.name_en             AS attribute_en,
             a.name_ar             AS attribute_ar,
             a.input_type          AS input_type,
             av.id                 AS value_id,
             av.value_en           AS value_en,
             av.value_ar           AS value_ar,
             av.color_hex          AS color_hex
      FROM variant_attribute_values vav
      JOIN product_variants v  ON v.id = vav.variant_id
      JOIN attributes a        ON a.id = vav.attribute_id
      JOIN attribute_values av ON av.id = vav.attribute_value_id
      WHERE v.product_id = ? AND v.is_active = 1
        AND a.is_active = 1 AND av.is_active = 1
      ORDER BY a.display_order, a.id, av.display_order, av.id
    `).all(productId);

    const byVariant = new Map();
    for (const row of rows) {
      const list = byVariant.get(row.variant_id) || [];
      list.push({
        attribute_id: row.attribute_id,
        attribute_en: row.attribute_en,
        attribute_ar: row.attribute_ar,
        input_type: row.input_type,
        value_id: row.value_id,
        value_en: row.value_en,
        value_ar: row.value_ar,
        color_hex: row.color_hex,
      });
      byVariant.set(row.variant_id, list);
    }
    return byVariant;
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
