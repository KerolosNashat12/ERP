/**
 * One accent colour and one mode, turned into a palette — for every browser
 * screen this platform has.
 *
 * The server sends a shop's identity resolved (`branding.accent`,
 * `branding.dark`; see src/shared/branding.js). What it deliberately does NOT
 * send is a colour per component: "do not build a colour system per component"
 * is the rule, so exactly one hex arrives and everything a page paints —
 * buttons, links, prices, active chips, the footer, the hero fill — derives
 * from it here, once, as CSS custom properties set on `<html>`.
 *
 * It lives in `public/shared/` rather than in the storefront or the ERP
 * because BOTH need it and they must not disagree: the storefront paints the
 * real thing and the ERP's settings screen paints a live preview of it, and a
 * preview that derives its shades differently from the site is a preview that
 * lies. Same reasoning as `src/shared/branding.js` on the server — a decision
 * made twice is a decision made differently.
 *
 * No dependency, no build step, no DOM assumptions beyond an element to set
 * properties on, so it is equally importable from a page, a module worker or a
 * test.
 */

export const DEFAULT_ACCENT = '#c8a24a';

/** Near-black: the dark chrome's background, and what "on dark" is measured against. */
const CHROME_INK = '#111827';

// ---------------------------------------------------------------- colour

/** `#abc` / `c8a24a` / `#C8A24A` -> `#c8a24a`; anything else -> null (use the default). */
export function normalizeHex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$/i.test(raw) && !/^[0-9a-f]{6}$/i.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  return `#${full.toLowerCase()}`;
}

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const toHex = ([r, g, b]) => `#${[r, g, b]
  .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
  .join('')}`;

function rgbToHsl(hex) {
  const [r, g, b] = toRgb(hex).map((n) => n / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex({ h, s, l }) {
  if (s === 0) return toHex([l * 255, l * 255, l * 255]);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255]);
}

/** `amount` of `hex` in `into` — a straight channel mix, no colour space games. */
function mix(hex, into, amount) {
  const a = toRgb(hex);
  const b = toRgb(into);
  return toHex(a.map((channel, i) => channel * amount + b[i] * (1 - amount)));
}

/** WCAG relative luminance. */
function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The same hue, moved along lightness only, until it reads against `against`.
 *
 * Hue and saturation are the shop's decision and are never touched: a shop
 * that picked hot pink gets hot pink, only lighter or darker than it typed if
 * the value it typed would have been invisible where the page uses it. The
 * step is deliberately coarse (2%) — this runs on every page load and the
 * difference between 41% and 42% lightness is not a difference anybody sees.
 */
function shiftUntilReadable(hex, against, minContrast, direction) {
  const hsl = rgbToHsl(hex);
  const step = direction === 'lighten' ? 0.02 : -0.02;
  let { l } = hsl;
  let candidate = hex;
  for (let i = 0; i < 50; i += 1) {
    if (contrast(candidate, against) >= minContrast) return candidate;
    l += step;
    if (l <= 0.04 || l >= 0.97) break;
    candidate = hslToHex({ ...hsl, l });
  }
  return candidate;
}

/**
 * Every shade a page needs, from one hex and one mode.
 *
 * The contrast targets are not arbitrary: 2.9 against white is what the
 * original hand-picked palette already used for its gold on paper (a hairline,
 * a hover, a price), 4.5 is the text threshold for the same gold used as
 * words, and 5 against the near-black chrome is what keeps a footer heading
 * legible on the dark band. A shop that picks a colour too pale for text gets
 * a darker shade of ITS colour for the text and its own colour everywhere the
 * shade would not matter — never a palette some default decided for it.
 */
export function palette(accentInput, dark = true) {
  const accentRaw = normalizeHex(accentInput) || DEFAULT_ACCENT;

  // On paper: decoration first, then a darker sibling for words.
  const accent = shiftUntilReadable(accentRaw, '#ffffff', 2.9, 'darken');
  const strong = shiftUntilReadable(accent, '#ffffff', 4.5, 'darken');
  // On the dark chrome band.
  const bright = shiftUntilReadable(accentRaw, CHROME_INK, 5, 'lighten');
  // A wash for badges and soft panels: the colour itself, mixed into paper
  // rather than desaturated — a hue lightened in HSL goes grey, and a grey
  // wash under a shop's own badge is the one shade that looks like a bug.
  const soft = mix(accentRaw, '#ffffff', 0.16);
  // Ink ON a solid fill of the accent. Measured, not assumed: white reads on a
  // deep colour and disappears on a pale one, and both get chosen by shops.
  const solidInk = contrast('#ffffff', accent) >= 4 ? '#ffffff' : '#10131a';
  const deep = shiftUntilReadable(accent, '#ffffff', 6, 'darken');

  return { accentRaw, accent, strong, bright, soft, solidInk, deep, rgb: toRgb(accent).join(' ') };
}

/**
 * The custom properties `<html>` carries. shop.css reads these and derives
 * everything else, which is why there is nothing per component here: the whole
 * storefront palette is the six values below plus a `data-theme` attribute.
 */
export function themeVariables(accentInput, dark = true) {
  const p = palette(accentInput, dark);
  return {
    '--accent': p.accent,
    '--accent-strong': p.strong,
    '--accent-bright': p.bright,
    '--accent-soft': p.soft,
    '--accent-deep': p.deep,
    '--accent-ink': p.solidInk,
    '--accent-rgb': p.rgb,
  };
}

/**
 * Paint a shop's colour onto a document (or any element, which is what the ERP
 * preview uses so a card can wear the shade the owner is dragging towards
 * without the whole back office changing colour).
 */
export function applyTheme(node, { accent, dark = true } = {}) {
  if (!node) return;
  const vars = themeVariables(accent, dark);
  for (const [key, value] of Object.entries(vars)) node.style.setProperty(key, value);
  if (node.dataset) node.dataset.theme = dark ? 'dark' : 'light';
  return vars;
}

/** The page background a mode implies — used for `<meta name="theme-color">`. */
export const chromeColor = (dark) => (dark ? CHROME_INK : '#ffffff');

// -------------------------------------------------------------- the mark

/**
 * A favicon for a shop that has not uploaded a logo: its own monogram, in its
 * own colour, as an SVG data URL.
 *
 * Drawn rather than fetched because there is nothing to fetch — and drawn
 * here, from the monogram the server derived, so the tab, the header and the
 * ERP sidebar are all the same two letters. Arabic monograms arrive as two
 * letters with a space between them (`ح ب`), which is exactly what has to be
 * rendered: joined, they would fuse into a ligature that reads as a word.
 */
export function monogramFavicon(monogram, { accent, dark = true } = {}) {
  const p = palette(accent, dark);
  const mark = String(monogram || '').trim();
  const background = dark ? CHROME_INK : p.accent;
  const ink = dark ? p.bright : p.solidInk;
  // Two Arabic letters plus a space are wider than two Latin ones; a
  // `textLength` would squash them, so the font size steps down instead.
  const size = mark.length > 2 ? 13 : 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="7" fill="${background}"/>`
    + `<text x="16" y="${16 + size * 0.36}" font-family="Georgia, 'Noto Naskh Arabic', serif" font-size="${size}"`
    + ` fill="${ink}" text-anchor="middle">${mark.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The one place that decides what a shop's mark IS, given what the server
 * resolved: its logo if it uploaded one, its monogram in the language being
 * read otherwise, and — for a name with nothing letter-like in it, where the
 * server answers `null` rather than inventing initials — the name itself.
 */
export function markFor(branding, lang = 'ar') {
  if (!branding) return { kind: 'monogram', text: '' };
  if (branding.logo) return { kind: 'logo', src: branding.logo };
  const mono = lang === 'ar' ? branding.monogram?.ar : branding.monogram?.en;
  const other = lang === 'ar' ? branding.monogram?.en : branding.monogram?.ar;
  return { kind: 'monogram', text: mono || other || '' };
}

export default { palette, themeVariables, applyTheme, monogramFavicon, markFor, normalizeHex, contrast, DEFAULT_ACCENT };
