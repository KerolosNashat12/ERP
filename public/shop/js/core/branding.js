/**
 * The shop's own identity, on the shop's own website.
 *
 * Everything here reads `config.branding`, which `/api/shop/config` sends
 * already resolved (see src/shared/branding.js): the logo URL or null, the
 * monogram in both scripts, the four pieces of copy in both languages, one
 * accent and one mode. The browser's job is to render it — not to decide what
 * a shop is called when a field is empty, which is a decision the server
 * already made for every client at once.
 *
 * The literals this file exists to delete were `M&M` in the header and the
 * footer, `Accessories` beside them, and a search box that named three product
 * categories. There is no shop name, no tagline and no colour written down
 * anywhere below: a second shop opened on this platform and found the first
 * one's, and the only way that does not happen again is for the code to have
 * nothing of its own to show.
 */
import { el } from './dom.js';
import { getLanguage } from './i18n.js';
import { shop } from './store.js';
import { assetUrl } from './api.js';
import { applyTheme, monogramFavicon, markFor, chromeColor } from '../../../shared/brandTheme.js';

/** `config.branding`, or an empty object — never a fallback with a name in it. */
export const branding = () => shop.config?.branding || {};

/**
 * The language side of a `{ en, ar }` pair, falling back to the other language
 * rather than to nothing: a shop that wrote only its Arabic tagline still has
 * a tagline, in the same way `pick()` treats a product's two name columns.
 */
export function bilingual(record) {
  if (!record) return '';
  const ar = getLanguage() === 'ar';
  const wanted = ar ? record.ar : record.en;
  const other = ar ? record.en : record.ar;
  return (wanted && String(wanted).trim()) || (other && String(other).trim()) || '';
}

/** The shop's name in the language being read. */
export const shopName = () => bilingual(shop.config?.companyName);

/** The line beside the name in the header — empty for a shop that never wrote one. */
export const tagline = () => bilingual(branding().tagline);

/** The footer paragraph. The server falls this back to the shop's own name. */
export const about = () => bilingual(branding().about) || shopName();

/** What the search box says. Neutral ("Search products…") until a shop says otherwise. */
export const searchPlaceholder = () => bilingual(branding().searchPlaceholder);

/** What a shared link says about the shop. */
export const metaDescription = () => bilingual(branding().metaDescription) || about();

/**
 * The monogram alone — the mark a shop wears where a logo cannot go: the
 * hero's watermark, and the middle of a product card that has no photograph.
 * Derived by the server from the shop's own name; `markFor` only chooses which
 * script's version this page is reading.
 */
export const monogramText = () => markFor({ ...branding(), logo: null }, getLanguage()).text || '';

/**
 * The mark itself: an `<img>` of the uploaded logo, or the monogram the server
 * derived from the shop's own name.
 *
 * The logo is never re-encoded, resized or cropped on the way in (see
 * WebAssetService), so a PNG with transparency arrives with its transparency
 * intact — which is the whole point of it, because this same element sits on a
 * white header and on a dark footer. Its height is fixed and its width is left
 * alone, so a wordmark stays a wordmark and a square badge stays square.
 *
 * A logo that 404s (deleted in the ERP a moment ago, a slot row that outlived
 * its bytes) falls back to the monogram in place rather than leaving the
 * shop's header showing a broken-image glyph.
 */
export function brandMark({ className = 'brand-mark', logoClass = 'brand-logo' } = {}) {
  const mark = markFor(branding(), getLanguage());
  if (mark.kind === 'logo') {
    const img = el(`img.${logoClass}`, {
      src: assetUrl(mark.src),
      alt: shopName(),
      decoding: 'async',
    });
    img.addEventListener('error', () => {
      img.replaceWith(el(`span.${className}`, monogramText() || shopName()));
    });
    return img;
  }
  return el(`span.${className}`, { 'aria-hidden': mark.text ? null : 'true' }, mark.text || shopName());
}

/**
 * The palette and the mode, as custom properties on `<html>`.
 *
 * Called once, right after the config lands and before the first paint of the
 * shell. Everything else in shop.css derives from what this sets — there is no
 * second place that knows a shop's colour, and no component that has its own.
 */
export function applyBranding() {
  const b = branding();
  /*
   * `dark` is one setting and it now decides two things, which is deliberate
   * rather than lazy: a shop that ticked "dark" was already saying its
   * identity is a dark one, and until now all it got for that was a dark
   * footer under a white page — half an answer to a question it had already
   * answered. Ticking it now gives the whole site the night paper (see
   * /home/claude/briefs/storefront-luxe.md), and un-ticking it gives back
   * exactly the daylight storefront that existed before, unchanged.
   *
   * Only the STOREFRONT passes `night`. The landing page at /kj calls the same
   * function with the same `dark: true` and must keep its light paper, which
   * is why this is an argument here and not a new meaning inside the module.
   */
  const dark = b.dark !== false;
  applyTheme(document.documentElement, { accent: b.accent, dark, night: dark });
  // The monogram is drawn by CSS as the hero's watermark, so it arrives the
  // same way the colours do rather than as a second element to position.
  document.documentElement.style.setProperty('--brand-monogram', JSON.stringify(monogramText()));
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', chromeColor(b.dark !== false, b.accent));
  applyFavicon();
}

/**
 * The browser tab. The uploaded logo when there is one — no second `favicon`
 * slot exists on purpose, it is derived from the logo — and the shop's own
 * monogram drawn in its own colour when there is not.
 */
export function applyFavicon() {
  const b = branding();
  const mark = markFor(b, getLanguage());
  const href = mark.kind === 'logo'
    ? assetUrl(mark.src)
    : monogramFavicon(mark.text || shopName(), { accent: b.accent, dark: b.dark !== false });
  let link = document.head.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    document.head.append(link);
  }
  link.setAttribute('href', href);
  // The type only helps the SVG the monogram is drawn as; the logo's own bytes
  // arrive with the content type the server sniffed at upload.
  if (mark.kind === 'logo') link.removeAttribute('type');
  else link.setAttribute('type', 'image/svg+xml');
}
