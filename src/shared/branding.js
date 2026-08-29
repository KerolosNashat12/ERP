/**
 * A shop's own identity, worked out server-side.
 *
 * Two things live here, and they live here rather than in the browser for the
 * same reason: they are decisions, not decoration, and a decision made twice
 * is a decision made differently.
 *
 * `monogram()` is the fallback mark a shop wears until it uploads a logo.
 * "First letters of the first two words" is not the same operation in Arabic as
 * in Latin — Arabic letters join into a ligature when they sit next to each
 * other (حب reads as one word, not two initials), and the definite article ال
 * carries no identity at all, so حب البنات has to become "ح ب" and never
 * "ح ا". Deriving it here means the storefront, the ERP sidebar and the
 * favicon all render the same string without any of them owning the rule.
 *
 * `normalizeHexColor()` is the gate on the one setting that can break a page.
 * It is used on the write path (the ERP save refuses a bad value, where a human
 * is looking) and again on the read path (a hand-edited row falls back to the
 * default rather than reaching `<html>` as a broken custom property).
 */

/** The accent every shop starts with, and what a bad or empty value falls back to. */
export const DEFAULT_ACCENT = '#c8a24a';

/**
 * THE TWO WEBSITES A SHOP CAN WEAR.
 *
 * The platform sells one storefront to every kind of shop, and one storefront
 * cannot be right for all of them: a perfume boutique and a hardware shop want
 * opposite things from the same page. So the shop picks.
 *
 *   classic  White cards on grey paper, the shop's colour on the buttons and
 *            the prices. Bright, plain, and the right answer for a shop whose
 *            product photography is casual — a phone snap on a counter reads
 *            fine on white and looks like a mistake on black.
 *
 *   luxe     Near-black paper, gold hairlines, serif names, square photos.
 *            Built from the design the owner sent (see
 *            /home/claude/briefs/storefront-luxe.md). It flatters good
 *            photography and punishes bad — which is the honest trade and the
 *            reason this is a CHOICE rather than a replacement.
 *
 * ── Why this is its own setting and not `dark` ─────────────────────────────
 * It was `dark` for one release, and that was a shortcut with a real cost:
 * `dark` already meant something — which colour the BANDS are, the promo strip
 * and the footer — and overloading it meant a shop could not have a dark
 * footer on a light page any more, which is a combination the classic design
 * was built around. Two questions, two settings.
 *
 * ── What the default has to be ─────────────────────────────────────────────
 * `classic`. A platform does not redesign its customers' shops because its
 * owner liked a mock-up; a shop changes when somebody at that shop decides it
 * should. Migration 026 is what stops that being a downgrade for anybody
 * already wearing the night storefront — see the note there.
 */
export const TEMPLATES = ['classic', 'luxe'];
export const DEFAULT_TEMPLATE = 'classic';

/**
 * A stored template value, or the default.
 *
 * The same read-path argument as `normalizeHexColor` below it: the ERP refuses
 * an unknown value on save, where a person is looking, and this refuses one on
 * the way out — a hand-edited row, a restored backup or an import must not be
 * able to put a template nobody has written CSS for onto a live shop.
 */
export function normalizeTemplate(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return TEMPLATES.includes(raw) ? raw : DEFAULT_TEMPLATE;
}

/**
 * Arabic script, including the presentation forms a copy-paste from Word can
 * carry. Detection is on the first letter of the derived monogram, which is
 * enough: a name is not written half in one script and half in the other.
 */
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Harakat and the dagger alif: marks, not letters — never a monogram's first character. */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

/**
 * Words that identify nothing. Arabic's ال is a prefix rather than a word and
 * is handled separately below; these are the Latin ones that stand alone.
 */
const LATIN_ARTICLES = new Set(['the', 'a', 'an', 'el', 'la', 'le', 'les', 'al']);

/** Anything that is not a letter or a digit at either end of a word: "M&M," -> "M&M". */
const TRIM_NON_ALNUM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * `البنات` -> `بنات`. Only when something substantial is left: `الله` and
 * two-letter words keep their alif rather than being reduced to a single
 * letter that means nothing.
 */
function stripArabicArticle(word) {
  if (word.length >= 4 && word.startsWith('ال')) return word.slice(2);
  return word;
}

/**
 * The letters a shop's name reduces to, ready to render — or null for a name
 * with nothing letter-like in it, in which case the caller shows the name
 * itself rather than an empty box.
 *
 * Two words give one letter each. One word gives its first two letters,
 * because a lone letter reads as an accident rather than a mark.
 */
export function monogram(name) {
  const cleaned = String(name || '').replace(ARABIC_MARKS, '').trim();
  if (!cleaned) return null;

  let words = cleaned
    .split(/\s+/)
    .map((word) => word.replace(TRIM_NON_ALNUM, ''))
    .filter(Boolean);

  // Drop leading articles, but never the last word standing: a shop actually
  // called "The" keeps it.
  while (words.length > 1 && LATIN_ARTICLES.has(words[0].toLowerCase())) words = words.slice(1);

  words = words.map(stripArabicArticle).filter(Boolean);
  if (!words.length) return null;

  // Array.from, not [0]: a name may begin with a character outside the basic
  // plane, and half a surrogate pair is a replacement glyph on the page.
  const letters = words.length >= 2
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);

  const mark = letters.filter(Boolean);
  if (!mark.length) return null;

  // Arabic letters would fuse into a single joined form if written adjacent;
  // the space is what keeps two initials looking like two initials.
  return ARABIC.test(mark[0])
    ? mark.join(' ')
    : mark.join('').toLocaleUpperCase('en');
}

/**
 * `#C8A24A`, `c8a24a`, `#abc` -> `#c8a24a`, `#aabbcc`. Anything else -> null,
 * which every caller reads as "use the default" rather than as an error to
 * paint onto the page.
 */
export function normalizeHexColor(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$/i.test(raw) && !/^[0-9a-f]{6}$/i.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return `#${full.toLowerCase()}`;
}

/**
 * A stored boolean that may have been written as a real boolean, as '1'/'0' by
 * the settings encoder, or as 'true'/'false' by a hand-edited row. Empty and
 * missing mean "never set", which is the fallback rather than false — a shop
 * that has configured nothing must get the documented default.
 */
export function booleanOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

/**
 * Copy a brand-new shop wears until its owner types its own. Every one of
 * these has to be true of a jeweller, a clothes shop and a bookshop alike:
 * nothing here may name a product category, because the moment it does, the
 * next shop to open finds somebody else's words on its own website.
 */
const NEUTRAL_SEARCH_PLACEHOLDER = { en: 'Search products…', ar: 'ابحث عن المنتجات…' };

/**
 * The shop's own name in both languages, and never a literal that belongs to
 * one tenant. The settings rows are written when a shop is provisioned, so
 * they are normally there; the tenant row is the next best answer, and the
 * generic word is the last resort for a database somebody emptied by hand.
 */
export function companyNameFrom(get, tenant = null) {
  const en = get('company.name') || tenant?.name || 'Shop';
  return {
    en: String(en),
    ar: String(get('company.name_ar') || get('company.name') || tenant?.nameAr || tenant?.name || 'المتجر'),
  };
}

/**
 * The whole `branding` block, built from settings that have already been read.
 *
 * Deliberately pure: it takes a `get(key)` and a name, does no SQL and knows
 * nothing about a request, so the storefront (which reads its settings in one
 * hand-written query, by doctrine) and the ERP shell (which reads them through
 * the settings repository) can produce a byte-identical block without either
 * one owning the rules.
 *
 * Every field comes back resolved. The browser never has to fall back to
 * anything, which is the point: a fallback in the client is a fallback that
 * exists once per client, and this system has two of them in two languages.
 * The only field that may be null is `tagline` — an invented one would be a
 * claim the shop never made, and the header reads correctly as the name alone.
 */
export function buildBranding({ get, companyName, hasLogo = false, logoUrl = '/api/shop/logo' }) {
  const str = (key) => {
    const value = get(key);
    return value === null || value === undefined || value === '' ? null : String(value);
  };

  const about = {
    en: str('web.about_en') || companyName.en,
    ar: str('web.about_ar') || companyName.ar,
  };

  return {
    logo: hasLogo ? logoUrl : null,
    monogram: { en: monogram(companyName.en), ar: monogram(companyName.ar) },
    tagline: { en: str('web.tagline_en'), ar: str('web.tagline_ar') },
    about,
    searchPlaceholder: {
      en: str('web.search_placeholder_en') || NEUTRAL_SEARCH_PLACEHOLDER.en,
      ar: str('web.search_placeholder_ar') || NEUTRAL_SEARCH_PLACEHOLDER.ar,
    },
    // What a shared link says about the shop. A shop that wrote nothing gets
    // its footer paragraph, which is its own name at worst — never a blank
    // preview card, and never another shop's description.
    metaDescription: {
      en: str('web.meta_description_en') || about.en,
      ar: str('web.meta_description_ar') || about.ar,
    },
    // Validated a second time here on purpose. The ERP already refuses a bad
    // hex on save, where a human is looking; this is the read path, and a
    // hand-edited row, a restored backup or an import must not be able to put
    // a broken value into a CSS custom property on `<html>`.
    accent: normalizeHexColor(get('web.theme_accent')) || DEFAULT_ACCENT,
    dark: booleanOr(get('web.theme_dark'), true),
    // Which of the two storefronts this shop wears. See TEMPLATES above for
    // what each one is and why the default is the plain one.
    template: normalizeTemplate(get('web.template')),
  };
}

export default {
  monogram, normalizeHexColor, booleanOr, companyNameFrom, buildBranding, DEFAULT_ACCENT,
  normalizeTemplate, TEMPLATES, DEFAULT_TEMPLATE,
};
