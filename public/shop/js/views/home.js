/** The landing page: one request, four shelves. */
import { el, fill, icon, chevron, ICONS } from '../core/dom.js';
import { api, assetUrl } from '../core/api.js';
import { t, pick } from '../core/i18n.js';
import { shopName, tagline, bilingual } from '../core/branding.js';
import { href } from '../core/router.js';
import { routePath, slugFor } from '../../../shared/shopUrls.js';
import { setPageMeta } from '../core/seo.js';
import { shop, deliverySettings } from '../core/store.js';
import { money, number } from '../core/format.js';
import { productGrid, taxonomyTile, sectionHead, brandCard, rail } from '../ui/cards.js';
import { skeletonGrid, errorState, emptyState } from '../ui/states.js';

/**
 * Pick the language side of a `{ en, ar }` config record — the banner's copy
 * here, the shop's own tagline and About paragraph in core/branding.js, which
 * is where the one implementation now lives.
 */
const bt = bilingual;

// `config.banner.align` is physical ('right' means the text sits on the
// right-hand side of the photo in BOTH languages), so it maps straight onto
// `justify-content` on a flex row whose own `direction` is pinned to `ltr` in
// CSS (see `.hero-frame` in shop.css) — `flex-start` there is always the true
// left, `flex-end` always the true right, independent of page language.
const ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' };
const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
// Ratios, not fixed sizes, so the existing `clamp()` viewport scaling in
// shop.css keeps doing its job at every one of the three settings.
const SIZE_SCALE = { small: 0.82, medium: 1, large: 1.18 };
// `textColor: 'dark'` is for a light or busy-but-pale photo, where dark text
// needs a LIGHT scrim to sit on, not the usual dark one — inverting the
// overlay's colour, not just the ink, is what actually keeps it readable.
const TEXT_COLOR = {
  light: {
    ink: '#ffffff', bodyInk: '#f2f3f5', scrim: '0 0 0',
    shadow: '0 2px 10px rgba(0, 0, 0, .55), 0 1px 3px rgba(0, 0, 0, .45)',
  },
  dark: {
    ink: '#15181f', bodyInk: '#262a33', scrim: '255 255 255',
    shadow: '0 2px 10px rgba(255, 255, 255, .55), 0 1px 3px rgba(255, 255, 255, .4)',
  },
};

/**
 * The hero is one fixed-size box (16:5 on desktop, 4:3 on a phone — see
 * `.hero` in shop.css) whichever shop opens it: a shop with a banner photo
 * gets that photo `cover`-cropped into the box; a shop that has not uploaded
 * one yet gets the same box filled with the original gradient/monogram
 * design, so "nothing configured" still reads as a finished page, not a
 * missing one.
 */
function hero() {
  const banner = shop.config?.banner || {};
  // What a shop that has uploaded no banner says on its own front page: its
  // banner heading, then its tagline, then a neutral line. Never a sentence
  // naming a product category — see `heroTagline` in core/i18n.js.
  const heading = bt(banner.heading) || tagline() || t('heroTagline');
  const body = bt(banner.text) || t('heroBody');
  const cta = banner.cta && bt(banner.cta.label) && banner.cta.link
    ? { label: bt(banner.cta.label), href: href(banner.cta.link) }
    : null;
  const cta2 = banner.cta2 && bt(banner.cta2.label) && banner.cta2.link
    ? { label: bt(banner.cta2.label), href: href(banner.cta2.link) }
    : null;
  const overlay = Number.isFinite(Number(banner.overlay)) ? Number(banner.overlay) : 35;
  // Prefixed with this tenant's own path: `/api/shop/banner` from the server
  // is prefix-agnostic, and unprefixed it would fetch the default shop's.
  const image = assetUrl(banner.image);

  const align = ALIGN[banner.align] || ALIGN.right;
  const valign = VALIGN[banner.valign] || VALIGN.middle;
  const scale = SIZE_SCALE[banner.size] || SIZE_SCALE.medium;
  const boxWidthRaw = Number(banner.boxWidth);
  const boxWidth = Number.isFinite(boxWidthRaw) ? Math.min(Math.max(boxWidthRaw, 30), 100) : 45;
  const colors = TEXT_COLOR[banner.textColor] || TEXT_COLOR.light;

  // One `style` string of custom properties rather than a class per
  // align×valign×size×color×width combination — shop.css has one generic
  // ruleset that reads all five, so this is the only place any of them is
  // decided.
  const heroStyle = [
    `--hero-align: ${align}`,
    `--hero-valign: ${valign}`,
    `--hero-scale: ${scale}`,
    `--hero-box-width: ${boxWidth}%`,
    `--hero-ink: ${colors.ink}`,
    `--hero-body-ink: ${colors.bodyInk}`,
    `--hero-scrim: ${colors.scrim}`,
    `--hero-text-shadow: ${colors.shadow}`,
  ].join('; ');

  const photo = image && el('img.hero-photo', {
    src: image,
    alt: '',
    loading: 'eager',
    decoding: 'async',
    // A banner row can exist with `hasImage` stale for a moment after an ERP
    // delete; falling back to the gradient beats a broken-image glyph on the
    // storefront's most visible pixel.
    onError: (event) => { event.currentTarget.closest('.hero')?.classList.remove('has-image'); event.currentTarget.remove(); },
  });

  return el('section.hero', { class: image ? 'has-image' : '', style: heroStyle },
    photo,
    image && el('div.hero-overlay', { style: `--hero-overlay: ${overlay / 100}` }),
    el('div.hero-frame',
      el('div.hero-inner',
        // The shop's own name, above its own heading — the eyebrow used to
        // read "From Cairo", which is a claim only one shop had made.
        !image && el('p.hero-eyebrow', shopName()),
        headingLines(heading),
        el('p.hero-body', body),
        /*
         * TWO BUTTONS, over a photograph as well as over the gradient.
         *
         * This used to draw the outline button only when there was no image,
         * on the reasoning that an outline colour chosen here could land
         * white-on-white on somebody's photo. Sound, and it is why the second
         * button is not simply drawn unconditionally now: it inherits
         * `--hero-ink`, the ink this hero has ALREADY resolved from the shop's
         * own light/dark banner setting, and sits on the same scrim as the
         * heading. If the heading is readable on that photograph the button is,
         * because they are the same colour on the same veil.
         *
         * The second button is what the shop configured, or — when it has
         * configured none and there is no photo to worry about — the standing
         * "browse everything" link the hero has always carried.
         */
        (cta || cta2 || !image) && el('div.hero-actions',
          cta && el('a.btn.btn-primary', { href: cta.href }, cta.label, chevron(16)),
          cta2
            ? el('a.btn.btn-outline', { href: cta2.href }, cta2.label)
            : (!image && el('a.btn.btn-outline', { href: href('products') }, t('heroCta')))))));
}

/**
 * The headline, as the design writes it: three lines with the MIDDLE one
 * leaning.
 *
 * «Accessories / *That Define* / Your Essence» — that one detail is most of
 * why the reference reads as an editorial rather than as a heading. The shop
 * writes its own banner copy, so the italic cannot be hard-coded to a phrase;
 * what leans is the SECOND LINE of whatever was typed, which is the pattern
 * the design uses and which degrades to nothing at all on a one-line heading.
 *
 * A shop makes a line break by pressing Enter in the banner heading box.
 *
 * ── Built as elements, never as markup ─────────────────────────────────────
 * This is shop-authored text on a public page. `el()` appends text nodes, so a
 * heading containing `<script>` is a heading containing the characters
 * `<script>`. Reaching for `innerHTML` here to get one `<em>` would put an
 * injection point on the most visible pixel of every shop on the platform —
 * `.hero-title em` was styled months ago and this is the code that finally
 * feeds it, deliberately without markup.
 */
function headingLines(heading) {
  const lines = String(heading ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return el('h1.hero-title', heading);
  /*
   * The hero box has a fixed height and the title is clamped so a long heading
   * cannot push the buttons out of it. That clamp has to know how many lines
   * were actually written, or a three-line heading comes back as two with the
   * last one cut mid-word — which reads as a broken banner, not as a limit.
   *
   * Capped at three: past that the shop is writing a paragraph in a heading,
   * and the box is not going to grow for it.
   */
  const shown = Math.min(lines.length, 3);
  return el('h1.hero-title.is-lined', { style: `--hero-lines: ${shown}` },
    lines.slice(0, shown).map((line, index) => el(
      // A block span per line, so the lines break where the shop put them
      // instead of wherever the box happens to run out.
      index === 1 ? 'em.hero-line' : 'span.hero-line',
      line,
    )));
}

/**
 * THE THREE FIGURES UNDER THE BANNER.
 *
 * Every one of them is a claim the shop is making to a customer on its own
 * front page, so every one of them is counted from this shop's catalogue by
 * the server (`#stats` in StorefrontService) rather than typed into a design.
 * The strip does not render at all when the shop has not switched it on, and
 * it does not render a figure it does not have.
 *
 * Delivery is the one that could most easily become a lie: the reference says
 * "Free SHIPPING", which is true only of a shop that gives it. So the server
 * sends what this shop's delivery settings actually say, and the wording is
 * chosen here from the shop's own dictionary in both languages.
 */
function statsStrip(stats) {
  if (!stats) return null;

  /*
   * Rounded DOWN, with a "+", and only above 50 — see `#stats` for why. The
   * arithmetic is repeated here rather than sent pre-formatted because "240+"
   * is a piece of TEXT and text on this storefront is built in the language
   * the shopper chose, through this file's own formatter.
   */
  const approx = (n) => {
    if (n < 50) return number(n);
    /*
     * The step is the smallest one that still reads as round, because rounding
     * down costs the shop real products and there is no reason to charge it
     * more than the tidying is worth. The first ladder here jumped to 50s at
     * 200, which turned a shop with 248 products into "200+" — literally true,
     * and forty-eight products of false modesty on its own front page.
     */
    const step = n < 1000 ? 10 : (n < 5000 ? 50 : 100);
    return `${number(Math.floor(n / step) * step)}+`;
  };

  const delivery = stats.delivery || {};
  const deliveryCell = delivery.alwaysFree
    ? { value: t('statsFree'), label: t('statsShipping') }
    : (delivery.freeOver
      // "Free over EGP 1,500" — the figure is the promise, the label is the
      // condition, so a shopper reads both or neither.
      ? { value: t('statsFree'), label: t('statsFreeOver').replace('{amount}', money(delivery.freeOver)) }
      : {
        value: delivery.mode === 'percent' ? `${number(delivery.percent)}%` : money(delivery.flat),
        label: t('statsShipping'),
      });

  const cells = [
    stats.products > 0 && { value: approx(stats.products), label: t('statsProducts') },
    stats.brands > 0 && { value: approx(stats.brands), label: t('statsBrands') },
    deliveryCell,
  ].filter(Boolean);

  // One cell is a stray number, not a strip. Two or three read as a claim.
  if (cells.length < 2) return null;

  return el('section.stats-strip', { 'aria-label': t('statsAria') },
    el('div.wrap',
      el('div.stats-row', cells.map((cell) => el('div.stat-cell',
        el('span.stat-value', cell.value),
        el('span.stat-label', cell.label))))));
}

/**
 * What this shop actually charges to deliver, in one sentence.
 *
 * Every shape here exists because it is a different promise: a flat fee, a
 * percentage, and a percentage with a floor and/or a cap are four things a
 * customer would plan differently around. Nothing is concatenated — the
 * sentences live in core/i18n.js in both languages, and the money goes
 * through core/format.js so it carries this shop's own currency.
 */
function deliveryPromise(delivery) {
  if (delivery.mode === 'percent' && delivery.percent > 0) {
    const percent = number(delivery.percent);
    if (delivery.min !== null && delivery.max !== null) {
      return t('trustDeliveryPercentMinMax', percent, money(delivery.min), money(delivery.max));
    }
    if (delivery.min !== null) return t('trustDeliveryPercentMin', percent, money(delivery.min));
    if (delivery.max !== null) return t('trustDeliveryPercentMax', percent, money(delivery.max));
    return t('trustDeliveryPercent', percent);
  }
  /*
   * One fixed amount, whatever the basket. That is a flat fee — and it is also
   * what "0% of your order, minimum 50" comes out as, so it is worded the same
   * way rather than told as a percentage that would always be wrong.
   *
   * A shop that charges nothing says so. "Delivery 0 to every governorate" is
   * a price tag on something that is free, and it reads as a bug.
   */
  const flat = delivery.mode === 'percent' ? (delivery.min || 0) : delivery.fee;
  return t('trustDeliveryFlat', flat > 0 ? money(flat) : t('free'));
}

/**
 * The three promises under the shelves. Real numbers or nothing: the free
 * delivery card only exists for a shop that has actually set a threshold.
 */
function trustRow() {
  const delivery = deliverySettings();
  const card = (glyph, title, note) => el('div.trust-card',
    el('span.trust-icon', icon(glyph, { size: 24 })),
    el('h3.trust-title', title),
    el('p.trust-note', note));

  return el('section.section',
    el('div.trust-row',
      card(ICONS.truck, t('trustDeliveryTitle'), deliveryPromise(delivery)),
      card(ICONS.wallet, t('trustCodTitle'), t('trustCodNote')),
      delivery.freeOver !== null
        && card(ICONS.gift, t('trustFreeTitle'), t('trustFreeNote', money(delivery.freeOver)))));
}

export default async function homeView(root) {
  // No description of its own: the home page IS the shop, so the shop's own
  // meta description (`config.branding`, resolved server-side) is the right
  // one, and `setPageMeta` falls back to it.
  setPageMeta({});

  const shelves = el('div.wrap.stack');
  /*
   * The figures sit directly under the banner and are drawn only once the
   * home payload lands — they are counted from the catalogue, so there is
   * nothing honest to show before it arrives. Its own host, appended now and
   * filled later, so the strip appears in place rather than pushing the
   * shelves down when it does.
   */
  const statsHost = el('div');
  // The banner is a rounded block inside the page's column, not a full-bleed
  // strip — see `.hero-wrap` in shop.css.
  root.append(el('div.wrap.hero-wrap', hero()), statsHost, shelves);
  fill(shelves, el('div.section', skeletonGrid(4)), el('div.section', skeletonGrid(8)));

  let data;
  try {
    data = await api.home();
  } catch (error) {
    fill(shelves, errorState(error, () => homeView(fill(root))));
    return;
  }

  const {
    newest = [], featured = [], categories = [], brands = [],
    featuredFromSales = false, stats = null,
  } = data;
  shop.categories = categories;
  shop.brands = brands;
  fill(statsHost, statsStrip(stats));

  const sections = [];

  /*
   * A GRID, not a rail — and this is a decision that was made twice.
   *
   * Every shelf on this page was briefly a rail, for consistency with the
   * brands. The shop's owner looked at it and said put the products back, which
   * is the right call and worth writing down rather than quietly reverting: a
   * rail is for a long row nobody reads in order, and sixty brand logos are
   * exactly that. A shopper's categories, and the newest pieces in the shop,
   * are the opposite — a short set, all of it worth seeing at once, and a grid
   * shows every one of them without asking anybody to push anything.
   *
   * So the rail earns its place once, on the brands, where it started.
   */
  if (categories.length) {
    sections.push(el('section.section',
      sectionHead(t('shopByCategory')),
      el('div.tiles', categories.map((row) => taxonomyTile(row, 'category')))));
  }

  // The white band. The design alternates paper and white full-bleed bands
  // down the page, and the brands and the best sellers are the white ones.
  if (brands.length) {
    /*
     * A rail, not a wall. Sixty brands as wrapped text pills filled six rows
     * with no shape to them; the same sixty as cards that scroll sideways take
     * one row, carry a logo or a letter and say how many pieces are behind each
     * name. See `rail()` in ui/cards.js for why it does not slide on its own.
     */
    sections.push(el('section.section.section-band',
      sectionHead(t('ourBrands')),
      rail(brands.map(brandCard), { label: t('ourBrands'), bleed: true })));
  }

  if (newest.length) {
    sections.push(el('section.section',
      sectionHead(t('newArrivals'), t('newArrivalsNote'),
        { href: href('products'), label: t('viewAll') }),
      productGrid(newest)));
  }

  /*
   * Best sellers is the shop's own sales record, topped up with new arrivals
   * so a quiet week does not leave a gap. `featuredFromSales` is the API
   * saying whether there is any sales record in there at all.
   *
   * With one — the owner asked for this shelf and it is telling the truth, so
   * it always shows, on its own white band. Without one, the shelf is made
   * entirely of the newest arrivals, and printing "الأكثر مبيعًا" over the
   * eight products that are already on the shelf above would be a brand-new
   * shop lying about what its customers bought. So the old dedupe stands and
   * the shelf disappears when it would only repeat itself.
   */
  const sameAsNewest = featured.length
    && featured.every((card, index) => card.id === newest[index]?.id);
  if (featured.length && (featuredFromSales || !sameAsNewest)) {
    sections.push(el('section.section.section-band',
      sectionHead(t('bestSellers'), t('bestSellersNote'),
        { href: href('products'), label: t('viewAll') }),
      productGrid(featured, { eagerCount: 0 })));
  }

  if (!sections.length) {
    fill(shelves, emptyState({ title: t('nothingHere'), body: t('nothingHereBody') }));
    return;
  }

  /**
   * The catalogue itself, at the foot of the page.
   *
   * The shelves above are a shop's opinion — what is new, what sells. This is
   * the shop, and it closes the page for the visitor who has scrolled past both
   * without seeing the one thing they came for. A first page of it, with the way
   * through to the rest: the home page is not the place to paginate a catalogue,
   * and `/products` already does that properly, with sorting and filters.
   *
   * Its own request, made AFTER the page has painted, so nothing above it waits
   * on it — and if it fails, the section simply is not there. A shop whose home
   * page is already on screen must not go blank because its last shelf could not
   * be fetched.
   */
  const catalogue = el('section.section');
  sections.push(catalogue);

  // The trust row closes the page, under whatever shelves the shop has.
  sections.push(trustRow());
  fill(shelves, sections);

  try {
    const page = await api.products({ page: 1, pageSize: CATALOGUE_PREVIEW });
    const rows = page.rows || [];
    if (!rows.length) { catalogue.remove(); return; }
    fill(catalogue,
      sectionHead(t('allProducts'), t('productsFound', Number(page.total || rows.length)),
        { href: href('products'), label: t('viewAll') }),
      productGrid(rows, { eagerCount: 0 }));
  } catch {
    catalogue.remove();
  }
}

/**
 * How much of the catalogue the home page shows before handing over to
 * `/products`. Ten rather than a dozen: the grid is five across on a desktop
 * and four on a narrower one, so ten closes on a full row at both — a shelf
 * ending in two lonely cards reads as a page that failed to load the rest.
 */
const CATALOGUE_PREVIEW = 10;
