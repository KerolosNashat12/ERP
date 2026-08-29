/**
 * What a shop shows where a photograph should be.
 *
 * Every catalogue has gaps. A product added at the counter in a hurry, a brand
 * whose logo nobody has found yet - and until now those drew two quiet letters
 * in a box, which reads as a page that has not finished loading rather than as
 * a shop. On a grid where the cards beside it have real photographs it is worse
 * than that: it looks broken.
 *
 * So the gap gets ARTWORK instead: a bottle for a product, a mark for a brand.
 * Drawn rather than photographed, on purpose - a stock photograph of somebody
 * else's perfume on a card is a small lie about what is in the box, and this
 * shop sells the real thing. A line drawing says "no picture yet" honestly
 * while still filling the frame like a picture.
 *
 * Inline SVG, not a file: it is a few hundred bytes, it costs no request on a
 * page that may draw forty of them, and - the reason it is worth doing this way
 * - it can be tinted with the shop's own accent, so a placeholder on a gold
 * shop and one on a green shop belong to their shops.
 */
import { el } from '../core/dom.js';
import { monogramText } from '../core/branding.js';

/** The accent, as the CSS variable resolves it right now. */
function accent(fallback = '#b58a3c') {
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

const svg = (markup) => `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;

/**
 * A bottle, square, on the frame's own background.
 *
 * Square because every photo frame in this shop is square (`--photo-ratio`), and
 * a placeholder that is a different shape from the pictures beside it defeats
 * the point of having a ratio at all.
 */
export function defaultProductArt(label = '') {
  const tint = accent();
  const initials = String(label || monogramText() || '').trim().slice(0, 2).toUpperCase();
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-hidden="true">
  <rect width="200" height="200" fill="none"/>
  <g fill="none" stroke="${tint}" stroke-opacity="0.42" stroke-width="3.2"
     stroke-linejoin="round" stroke-linecap="round">
    <rect x="86" y="34" width="28" height="18" rx="4"/>
    <path d="M92 52v10c0 4-2 6-6 9-10 6-16 15-16 27v46c0 8 6 14 14 14h32c8 0 14-6 14-14v-46c0-12-6-21-16-27-4-3-6-5-6-9V52"/>
    <path d="M74 118h52"/>
  </g>
  <text x="100" y="106" text-anchor="middle" font-family="Georgia, serif"
        font-size="26" fill="${tint}" fill-opacity="0.5">${initials}</text>
</svg>`);
}

/** A brand with no logo: its initials inside a ring, in the shop's accent. */
export function defaultBrandArt(label = '') {
  const tint = accent();
  const initials = String(label || '').trim().slice(0, 2).toUpperCase() || monogramText();
  return svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-hidden="true">
  <circle cx="60" cy="60" r="46" fill="none" stroke="${tint}" stroke-opacity="0.35" stroke-width="2.5"/>
  <text x="60" y="72" text-anchor="middle" font-family="Georgia, serif"
        font-size="34" fill="${tint}" fill-opacity="0.7">${initials}</text>
</svg>`);
}

/**
 * The <img> a card uses when there is no photograph. An image element rather
 * than a background, so it sits in exactly the same box, with exactly the same
 * fitting rules, as a real photograph would - which is what keeps the grid even.
 */
export function defaultProductImage(label = '') {
  return el('img.photo-default', {
    src: defaultProductArt(label),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
}

export function defaultBrandImage(label = '') {
  return el('img.brand-logo-img.brand-logo-default', {
    src: defaultBrandArt(label),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CATEGORY ARTWORK — the icon a shelf wears when nobody uploaded a photograph.

   The owner asked for both halves: «ممكن تبقي صور ونضيف صور للفئات وانت خلي
   الـdefault من عندك ايقونات لو الادمين مضفش صور». So a category shows the
   picture the shop uploaded, and a shop that has uploaded none gets a drawn
   line icon — not the letter in a circle it used to get, which is what "no
   artwork" looks like when it is pretending not to be.

   ── Why the icon is guessed from the NAME ──────────────────────────────────
   The alternative is a picker in the ERP with thirty icons in it, and a shop
   owner adding a category at the counter is not going to open it. Guessing
   from the name is right almost always and costs nothing when it is wrong: the
   fallback is a neutral tag, and the shop can upload a real photograph the
   moment it cares. The keywords are Arabic AND English because this shop's
   categories are named in Arabic and the platform's other shops may not be.

   ── Why line art and not emoji ─────────────────────────────────────────────
   An emoji is a different drawing on every Android in Egypt, and half of them
   are full colour cartoons that would sit on a page whose whole design is one
   gold line on black. These are stroked paths in the shop's own accent.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The icon vocabulary. Each entry is a set of words that mean it — in both
 * languages, unvowelled, and matched as substrings so «العطور» finds «عطر».
 *
 * Paths are drawn on a 24×24 grid, stroked, never filled: they are set at
 * 40-56px inside a tile and a filled glyph at that size reads as a blob.
 */
const CATEGORY_ICONS = [
  {
    key: 'perfume',
    words: ['عطر', 'عطور', 'برفان', 'بارفان', 'فوم', 'كولون', 'كولونيا', 'مسك', 'عود',
      'perfume', 'fragrance', 'parfum', 'cologne', 'scent', 'edp', 'edt', 'oud', 'musk'],
    path: 'M10 3h4v3h-4zM9 6h6a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM10 11h4',
  },
  {
    key: 'wallet',
    words: ['محفظ', 'محافظ', 'wallet', 'purse', 'cardholder'],
    path: 'M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 11h5v4h-5a2 2 0 0 1 0-4z',
  },
  {
    key: 'watch',
    words: ['ساع', 'ساعات', 'watch', 'timepiece', 'clock'],
    path: 'M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM12 9.5V12l1.8 1.2M9.5 7l.5-4h4l.5 4M9.5 17l.5 4h4l.5-4',
  },
  {
    key: 'glasses',
    words: ['نظار', 'نضار', 'شمس', 'glass', 'eyewear', 'sunglass', 'optic'],
    path: 'M2 12h4M18 12h4M6 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0zM12 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0z',
  },
  {
    key: 'bag',
    /*
     * «حقائب» is here as well as «حقيب» and that is not redundancy: Arabic
     * broken plurals do not share a stem with their singular — حقيبة becomes
     * حقائب, not حقيبات — so a substring match on the singular finds nothing.
     * The test caught this one; every family below that has a broken plural
     * carries both forms for the same reason.
     */
    words: ['شنط', 'شنطة', 'حقيب', 'حقائب', 'كلتش', 'bag', 'handbag', 'clutch', 'tote', 'backpack'],
    path: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  },
  {
    key: 'jewellery',
    words: ['مجوهر', 'اكسسوار', 'إكسسوار', 'سلسل', 'سلاسل', 'خاتم', 'خواتم', 'انسيال', 'اسور', 'أسور',
      'jewel', 'accessor', 'necklace', 'ring', 'bracelet'],
    path: 'M12 4l3 4-3 12-3-12zM9 8h6M7 4h10',
  },
  {
    key: 'lipstick',
    words: ['مكياج', 'ميك اب', 'روج', 'احمر شفاه', 'makeup', 'lipstick', 'cosmetic', 'beauty'],
    path: 'M9 21h6V10H9zM10 10V5a2 2 0 0 1 4 0v5',
  },
  {
    key: 'care',
    words: ['عناي', 'كريم', 'لوشن', 'بادي', 'سبراي', 'care', 'lotion', 'cream', 'spray', 'body', 'splash', 'mist'],
    path: 'M9 9h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM10 9V6h4v3M10 3h4',
  },
];

/** The neutral one: a shop tag, for a category none of the words above matched. */
const CATEGORY_FALLBACK = 'M4 12.5 12.5 4H20v7.5L11.5 20zM16.5 7.5h.01';

/**
 * Which icon a category's name means. Matched on BOTH names, so an English
 * category on an Arabic shop and the reverse both find their icon.
 */
export function categoryIconPath(row) {
  const haystack = `${row?.name_ar || ''} ${row?.name_en || ''}`.toLowerCase();
  const hit = CATEGORY_ICONS.find((entry) => entry.words.some((word) => haystack.includes(word)));
  return hit ? hit.path : CATEGORY_FALLBACK;
}

/**
 * The drawn icon itself, as an inline SVG element in the shop's own accent.
 *
 * `currentColor` rather than a resolved hex: the tile already sets its colour,
 * and inheriting means a hover that changes the tile's colour changes the icon
 * with it for free.
 */
export function categoryArt(row, { size = 46 } = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.1');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  node.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', categoryIconPath(row));
  node.append(path);
  return node;
}
