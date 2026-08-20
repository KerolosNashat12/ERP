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
 * That includes the neutrals. The page, the ink, the hairlines and the tint a
 * card's shadow is coloured with are not a fixed cream this platform picked:
 * they are the accent's own hue, desaturated and moved along lightness, so
 * every shop gets the same warm design in its own colour — a coral shop on
 * coral-cream paper with brown-black ink, a violet shop on violet-cream with
 * plum ink. See the `neutrals` section below for the two constants that decide
 * it and what a shop that picks a greyscale accent gets.
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

// -------------------------------------------------------------- neutrals

/**
 * The paper, the ink and the hairlines — the shop's own colour, wrung out.
 *
 * The storefront used to write these down: a warm `#faf8f4` page, a near-black
 * `#111827` ink, a `#e7e2d9` rule. They were chosen to sit under gold, so a
 * shop that picked coral got coral buttons on somebody else's paper — the one
 * thing the design brief forbids ("nothing coral may be written down" cuts both
 * ways: nothing GOLD may be written down either). So every neutral below is the
 * accent's own hue, desaturated and moved along lightness, and shop.css keeps
 * its literals only as the pre-config default.
 *
 * TWO constants decide the whole family, and both were calibrated against the
 * source design (accent `#F07878`, a coral) until the derivation reproduced the
 * real values read off it:
 *
 *   NEUTRAL_TURN — the neutrals do not sit on the accent's hue exactly, they
 *     sit 15° round the wheel from it, in the same direction and by about the
 *     same distance as the hero gradient's warm end (`#F4A87C` is +22° from
 *     `#F07878`). That is what makes the design's paper read as CREAM beside a
 *     coral rather than as pink, and its ink as BROWN rather than as maroon:
 *     measured, the source site's paper is +22°, its ink +24°, its hairline
 *     +15° and its shadow +12° off the accent. One turn of 15° lands every one
 *     of them within 2% per channel; a turn of 0° misses the ink by 5%.
 *
 *   MIN_TINT — the least saturation a neutral may be derived from. A shop that
 *     types `#000000`, `#ffffff` or `#808080` has expressed no hue at all
 *     (HSL gives an achromatic colour hue 0, arbitrarily), and deriving from
 *     its saturation of zero would hand it a page of dead browser grey that
 *     reads as a stylesheet that failed to load. Hue 0 turned by NEUTRAL_TURN
 *     is 15° — the warm cream the source design itself wears — so a greyscale
 *     shop gets exactly that: this palette with nothing tinting it, which is
 *     the most honest answer to "no colour" there is. The floor is applied as a
 *     floor rather than a special case so a nearly-grey accent (a dusty rose, a
 *     slate) crosses it smoothly instead of jumping.
 */
const NEUTRAL_TURN = 15 / 360;
const MIN_TINT = 0.30;

/**
 * `[lightness, share of the accent's saturation]` per role.
 *
 * The lightnesses are the source design's own, read off the live site: paper
 * .958 (`#FDF3ED`), hairline .878 (`#F0D8D0`), ink .180 (`#3D2B1F`), shadow
 * tint .588 (`rgba(200,120,100,…)`). The shares are what those same colours
 * measure against the accent's saturation — the paper keeps most of it (at 96%
 * lightness there is almost no chroma left to keep), the ink about four tenths.
 *
 * `ink3` is the one place this table disagrees with the design. The site's
 * muted ink `#C4A090` measures 2.19:1 on its own paper, under the 2.8 floor
 * below, and a floor that every shop trips is not a floor. So the constant sits
 * a step darker than the design's — the darkest tone that passes without being
 * shifted — and a coral shop gets `#B68677`: the same tan, legible.
 */
const NEUTRAL = {
  bg:        [0.958, 0.82],   // the page
  line:      [0.878, 0.65],   // hairline
  line2:     [0.925, 0.55],   // the fainter hairline
  ink3:      [0.600, 0.38],   // muted ink: a card's brand line, a section note
  ink2:      [0.350, 0.42],   // mid ink: body copy beside a heading
  ink:       [0.180, 0.41],   // headings and body
  shadow:    [0.588, 0.60],   // the tint a card's shadow is coloured with
  band:      [0.930, 0.55],   // a PALE band (light mode's footer, toast, strip)
  bandLine:  [0.865, 0.60],
  bandLine2: [0.905, 0.55],
  onBand2:   [0.829, 0.30],   // on a DARK band: headings' body copy
  onBand3:   [0.655, 0.19],   // …links and labels
  onBand4:   [0.555, 0.16],   // …the base line, the quietest thing on it
  bandRule:  [0.276, 0.35],   // the dark band's own hairlines
  bandRule2: [0.206, 0.35],
};

/**
 * Legibility is measured here, never assumed.
 *
 * 10:1 for ink and 7:1 for the mid ink are comfortably past WCAG AA for body
 * text and are what the design's own `#3D2B1F` on `#FDF3ED` already measures
 * (12.3:1) — a shop whose accent lands lighter than that gets its own hue
 * darkened until it reads, not a grey substituted for it. 2.8:1 for the muted
 * ink is the decorative-adjacent floor: it carries a brand line and a section
 * note, never a sentence somebody has to read. The hairlines are the opposite
 * problem — a rule that CONTRASTS is a rule that draws attention it has not
 * earned, so they are held UNDER their number rather than over it.
 */
const INK_FLOOR = { ink: 10, ink2: 7, ink3: 2.8 };
const HAIRLINE_CEILING = { line: 1.6, line2: 1.3 };

/**
 * The same hue, moved along lightness until it clears (`min`) or stays under
 * (`max`) a contrast against the ground it sits on.
 *
 * The sibling of `shiftUntilReadable`, and different from it in two ways that
 * matter. It walks in 1% steps rather than 2% because neutrals live within a
 * couple of percent of each other and a coarse step turns a hairline into a
 * visible rule. And it works out its own direction from the ground: ink moves
 * away from the paper to become legible, a hairline moves towards it to become
 * quiet, and the same call does the right thing for a pale band and a dark one.
 */
function settleContrast(hex, ground, { min, max }) {
  const hsl = rgbToHsl(hex);
  const groundL = rgbToHsl(ground).l;
  // Away from the ground raises contrast; towards it lowers contrast.
  const away = groundL > hsl.l ? -0.01 : 0.01;
  const step = min !== undefined ? away : -away;
  let { l } = hsl;
  let candidate = hex;
  for (let i = 0; i < 60; i += 1) {
    const ratio = contrast(candidate, ground);
    if (min !== undefined ? ratio >= min : ratio <= max) return candidate;
    l += step;
    if (l <= 0.03 || l >= 0.995) break;
    candidate = hslToHex({ ...hsl, l });
  }
  return candidate;
}

/**
 * Every neutral, from the same one hex the accent came from.
 *
 * Both modes share the paper. That is the whole point of the mode split in
 * shop.css and it survives here: "light" and "dark" do not invert the page,
 * they change what the BANDS are — the announcement strip, the footer, the
 * toast. A dark shop bands its cream page with the ink itself (which is
 * exactly what the design's deep-brown footer is, and what `--chrome` in
 * shop.css already resolved to); a light shop bands it with a pale wash of the
 * same hue and puts the page's own ink back on top.
 */
function neutrals(accentRaw, dark) {
  const { h, s } = rgbToHsl(accentRaw);
  const hue = (h + NEUTRAL_TURN) % 1;
  const tint = Math.max(s, MIN_TINT);
  const shade = (role) => hslToHex({
    h: hue, s: Math.min(1, tint * NEUTRAL[role][1]), l: NEUTRAL[role][0],
  });

  const bg = shade('bg');
  const ink = settleContrast(shade('ink'), bg, { min: INK_FLOOR.ink });
  const ink2 = settleContrast(shade('ink2'), bg, { min: INK_FLOOR.ink2 });
  const ink3 = settleContrast(shade('ink3'), bg, { min: INK_FLOOR.ink3 });
  const line = settleContrast(shade('line'), bg, { max: HAIRLINE_CEILING.line });
  const line2 = settleContrast(shade('line2'), bg, { max: HAIRLINE_CEILING.line2 });

  // The band. Dark: the ink itself, white on top. Light: a pale wash of the
  // hue, with the page's inks re-measured against IT rather than against the
  // paper — a band is a different ground and the floors are about grounds.
  const chrome = dark ? ink : shade('band');
  const band = dark
    ? {
      onChrome: '#ffffff',
      onChrome2: settleContrast(shade('onBand2'), chrome, { min: 7 }),
      onChrome3: settleContrast(shade('onBand3'), chrome, { min: 4.5 }),
      onChrome4: settleContrast(shade('onBand4'), chrome, { min: 3 }),
      chromeLine: settleContrast(shade('bandRule'), chrome, { max: HAIRLINE_CEILING.line }),
      chromeLine2: settleContrast(shade('bandRule2'), chrome, { max: HAIRLINE_CEILING.line2 }),
    }
    : {
      onChrome: settleContrast(shade('ink'), chrome, { min: INK_FLOOR.ink }),
      onChrome2: settleContrast(shade('ink2'), chrome, { min: INK_FLOOR.ink2 }),
      onChrome3: settleContrast(shade('ink2'), chrome, { min: INK_FLOOR.ink2 }),
      onChrome4: settleContrast(shade('ink3'), chrome, { min: INK_FLOOR.ink3 }),
      chromeLine: settleContrast(shade('bandLine'), chrome, { max: HAIRLINE_CEILING.line }),
      chromeLine2: settleContrast(shade('bandLine2'), chrome, { max: HAIRLINE_CEILING.line2 }),
    };

  return {
    bg,
    // Cards are white paper in both modes: only the bands change, and a card
    // is not a band. Written as a value rather than left to shop.css because
    // everything else in this family is set on `<html>`, and an inline
    // property beats a stylesheet — a half-set family is how a mode ends up
    // with one stale colour in it.
    surface: '#ffffff',
    ink,
    ink2,
    ink3,
    line,
    line2,
    // The shadow is not a colour, it is three channels: shop.css spends them
    // as `rgb(var(--shadow-rgb) / .06)`, one tint at several alphas.
    shadowRgb: toRgb(shade('shadow')).join(' '),
    chrome,
    ...band,
  };
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
 *
 * The neutrals ride along in the same object (see `neutrals` above). They are
 * additive: every accent key below keeps the name and the value it has always
 * had, because the ERP preview, the favicon and shop.css all read them.
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

  return {
    accentRaw, accent, strong, bright, soft, solidInk, deep, rgb: toRgb(accent).join(' '),
    ...neutrals(accentRaw, dark),
  };
}

/**
 * The custom properties `<html>` carries. shop.css reads these and derives
 * everything else, which is why there is nothing per component here: the whole
 * storefront palette is the values below plus a `data-theme` attribute.
 *
 * The names are shop.css's own. That is the mechanism, not a coincidence: the
 * sheet declares every one of them in `:root` as the default gold-on-cream a
 * shop wears before its config lands, and an inline custom property on `<html>`
 * beats a stylesheet, so setting them here replaces the default in place — no
 * second sheet, no `!important`, nothing to keep in sync but a name.
 *
 * Which is also why the band family below is mode-aware rather than always
 * dark. These properties OVERRIDE `html[data-theme="light"]`, so a light shop
 * has to be handed the light band's values or it would get white text on a pale
 * strip. Same two families the sheet has always had; the difference is that
 * they are now the shop's hue instead of a blue-grey somebody typed once.
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

    '--bg': p.bg,
    '--surface': p.surface,
    '--ink': p.ink,
    '--ink-2': p.ink2,
    '--ink-3': p.ink3,
    '--line': p.line,
    '--line-2': p.line2,
    '--shadow-rgb': p.shadowRgb,

    '--chrome': p.chrome,
    '--on-chrome': p.onChrome,
    '--on-chrome-2': p.onChrome2,
    '--on-chrome-3': p.onChrome3,
    '--on-chrome-4': p.onChrome4,
    '--chrome-line': p.chromeLine,
    '--chrome-line-2': p.chromeLine2,
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

/**
 * What the phone paints its own address bar with — `<meta name="theme-color">`.
 *
 * It has to be the colour of the strip the page actually starts with, which
 * since the neutrals became the accent's own is this shop's paper, not a
 * near-black that belonged to the platform's first shop. Called with no accent
 * (the ERP, a caller from before this file derived neutrals) it still answers
 * the old pair, so nothing that has not been told about a shop's colour gets a
 * colour a shop chose.
 */
export const chromeColor = (dark, accent) => (
  accent === undefined
    ? (dark ? CHROME_INK : '#ffffff')
    : palette(accent, dark).bg
);

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
