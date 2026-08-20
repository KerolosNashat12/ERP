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
 * It does NOT include the neutrals, and that is a decision rather than an
 * omission. They were the accent's hue desaturated for one release — coral
 * gave cream paper, gold gives a pale yellow-green — and the owner, looking at
 * the live site, asked for the opposite: "the background colour white solid
 * and gray". So the page, the ink, the hairlines and the tint a shadow is
 * coloured with are now one grey ramp that every shop shares, and the accent
 * does accent work only. A shop is still recognisably its own — its colour is
 * on every button, price, chip, link, hero and heart — it just is not on the
 * paper. See the `neutrals` section below for the ramp and for what came out
 * of this file when the hue did.
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
 * The paper, the ink, the hairlines and the shadow — one grey ramp, no hue.
 *
 * These used to be the accent's own hue, turned 15° round the wheel and wrung
 * out: a coral shop got cream paper under brown ink, a violet shop got violet
 * cream under plum ink. The owner saw it live and asked for the opposite —
 * "the background colour white solid and gray". His accent is gold, and gold
 * turned and desaturated is a pale yellow-green page, which is exactly the
 * thing he was looking at. So the neutrals stop carrying hue entirely. The
 * accent lost nothing: it still decides every `--accent*` key, and those are
 * still the buttons, the prices, the active chips, the links, the hero fill
 * and the heart. What changed is that the paper underneath them is the same
 * paper in every shop.
 *
 * WHAT WAS DELETED, so nobody goes hunting for it: `NEUTRAL_TURN` (the 15°
 * turn), `MIN_TINT` (the saturation floor that kept a greyscale accent off
 * dead browser grey) and `settleContrast()` (the 1%-step walk that darkened an
 * ink until it cleared its floor and pulled a hairline back under its ceiling).
 * The first two took the accent's hue and saturation as their only input, and
 * that input no longer exists. `settleContrast` is the subtler call: it would
 * still run and it would still be correct — but every argument it takes is now
 * a constant, so it is a loop run on every page load to arrive at a number
 * that could have been written down. A search that cannot change its answer is
 * not a safety net; it is a place a reader has to go and verify before they
 * can trust a colour. The floors did NOT go with it. They moved to
 * tests/brand-theme.test.js, which now measures the ramp itself rather than
 * measuring whether a shift rescued it, and fails if a level below is edited
 * into something illegible.
 *
 * WHAT SURVIVED: the ramp. One value per role, still one table, still the only
 * place a neutral is decided — it is just fed no hue now. The levels are
 * written as 0–255 greys rather than as HSL lightnesses because with
 * saturation at zero those are the same number, and the grey is the one a
 * reader can compare across roles and against a hex in the sheet.
 *
 * The ramp, and what each level is for:
 *
 *   surface 255  solid white. Cards, and the header. Not a near-white: the
 *                owner's note is "white SOLID and gray" and 253 is a smudge.
 *   bg      240  the page the white cards sit on. 1.14:1 against the surface —
 *                the step is the whole design. Below about 1.10 the card edge
 *                disappears on a phone in daylight and the page reads as one
 *                flat sheet; much past 1.3 the page stops being paper and
 *                starts being a filled panel with cards punched out of it.
 *   bg-2    228  one step deeper again (1.12:1 under the page, 1.27:1 under a
 *                white card): the ground for a photo frame, an inset well and
 *                a skeleton — things that have to RECEDE from a white card,
 *                which nothing at 240 can do while the card is 255.
 *   line    224  a hairline: 1.16:1 on the page, 1.32:1 on a card. A rule that
 *   line-2  235  contrasts is a rule demanding attention it has not earned, so
 *                both are held under a ceiling rather than over a floor.
 *   ink3    132  muted ink — a card's brand line, a section note. Never a
 *                sentence somebody has to read, so it is allowed to sit at
 *                2.94:1 on the deepest ground it lands on.
 *   ink2     71  body copy beside a heading: 7.31:1 on that same ground.
 *   ink      42  headings and body: 11.29:1. Near-black, not black — 42 keeps
 *                the page from ringing the way #000 does on a bright screen.
 *   shadow   20  not a colour, three channels: shop.css spends them as
 *                `rgb(var(--shadow-rgb) / .06)`. Near-black, because a shadow
 *                is an absence of light and a mid-grey one at 6% is nothing.
 *
 * Every ink is measured against `bg-2` — the DEEPEST neutral ground any of
 * them is ever set on (the page is lighter, a card is lighter still, and in
 * light mode the band IS `bg-2`). Clear the floor there and it is cleared
 * everywhere, by construction rather than by search.
 */
const NEUTRAL = {
  bg: 240,
  bg2: 228,
  // The well a photograph sits in, INSIDE a white card. Deliberately far
  // lighter than `bg2`: the design this was built from separates its photo
  // area from its card body by about 1.06:1, and at `bg2` (1.27:1 against
  // white) the top two thirds of every card read as a grey block with a white
  // strip under it rather than as one white card holding a picture. It is a
  // whisper on white and still lighter than the page, so a card on the grey
  // page keeps its edge either way.
  well: 247,
  line: 224,
  line2: 235,
  ink3: 132,
  ink2: 71,
  ink: 42,
  shadow: 20,
  // On a DARK band: body copy (7:1 and over), links and labels (4.5:1), and
  // the base line, the quietest thing on it (2.8:1).
  onBand2: 211,
  onBand3: 167,
  onBand4: 142,
  bandRule: 70,   // the dark band's own hairlines, under the same ceiling as
  bandRule2: 53,  // the paper's
  // …and on the PALE band, which is a lighter ground and so needs its own two.
  bandLine: 210,
  bandLine2: 218,
};

/** A level from the ramp above, as a hex: the same ramp, with no hue in it. */
const gray = (level) => hslToHex({ h: 0, s: 0, l: level / 255 });

/**
 * Every neutral. No argument but the mode — which is the point.
 *
 * Both modes share the paper and share the cards. That is the whole reason
 * shop.css has a mode split rather than an invert filter, and it survives
 * intact: "light" and "dark" do not swap the page for its opposite, they
 * change what the BANDS are — the announcement strip, the footer, the toast,
 * the order-number card. A dark shop bands the grey page with the ink itself
 * and puts white on top. A light shop bands it with `bg-2`, one step deeper
 * than the page, and puts the page's own inks back on top: the same grey a
 * well or a photo frame uses, which is deliberate — "one step deeper than
 * white" is one idea and it should not be two values. It has to be a step
 * DOWN and not white, because `--chrome` fills the order-number card that
 * sits inside a white `.success` card, and a white band on a white card is
 * not a band.
 */
function neutrals(dark) {
  const ink = gray(NEUTRAL.ink);
  const bg2 = gray(NEUTRAL.bg2);
  const well = gray(NEUTRAL.well);
  const chrome = dark ? ink : bg2;

  return {
    bg: gray(NEUTRAL.bg),
    bg2,
    well,
    // Written as a value rather than left to shop.css because everything else
    // in this family is set on `<html>`, and an inline property beats a
    // stylesheet — a half-set family is how a mode ends up with one stale
    // colour in it.
    surface: '#ffffff',
    ink,
    ink2: gray(NEUTRAL.ink2),
    ink3: gray(NEUTRAL.ink3),
    line: gray(NEUTRAL.line),
    line2: gray(NEUTRAL.line2),
    shadowRgb: toRgb(gray(NEUTRAL.shadow)).join(' '),
    chrome,
    ...(dark
      ? {
        onChrome: '#ffffff',
        onChrome2: gray(NEUTRAL.onBand2),
        onChrome3: gray(NEUTRAL.onBand3),
        onChrome4: gray(NEUTRAL.onBand4),
        chromeLine: gray(NEUTRAL.bandRule),
        chromeLine2: gray(NEUTRAL.bandRule2),
      }
      : {
        onChrome: ink,
        onChrome2: gray(NEUTRAL.ink2),
        onChrome3: gray(NEUTRAL.ink2),
        onChrome4: gray(NEUTRAL.ink3),
        chromeLine: gray(NEUTRAL.bandLine),
        chromeLine2: gray(NEUTRAL.bandLine2),
      }),
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
 * The neutrals ride along in the same object (see `neutrals` above), and they
 * ride along independently: not one line below reads them and not one of them
 * reads `accentRaw`, which is what "the shop's colour still decides the
 * accents and nothing else" means as code. Every accent key below keeps the
 * name and the value it has always had, because the ERP preview, the favicon
 * and shop.css all read them.
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
    ...neutrals(dark),
  };
}

/**
 * The custom properties `<html>` carries. shop.css reads these and derives
 * everything else, which is why there is nothing per component here: the whole
 * storefront palette is the values below plus a `data-theme` attribute.
 *
 * The names are shop.css's own. That is the mechanism, not a coincidence: the
 * sheet declares every one of them in `:root` as the pre-config fallback a
 * shop wears before its config lands, and an inline custom property on `<html>`
 * beats a stylesheet, so setting them here replaces the default in place — no
 * second sheet, no `!important`, nothing to keep in sync but a name. The
 * neutral half of that fallback should be these exact greys, so the first
 * paint and the second are the same picture.
 *
 * Which is also why the band family below is mode-aware rather than always
 * dark. These properties OVERRIDE `html[data-theme="light"]`, so a light shop
 * has to be handed the light band's values or it would get white text on a
 * pale strip.
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
    // New with the "white solid and gray" note: a photo frame, an inset well
    // and a skeleton all need a ground that recedes from a white card, and
    // the page itself cannot be it once the cards are pure white.
    '--bg-2': p.bg2,
    '--photo-well': p.well,
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
 * is the page itself — the grey the header sits on, not a near-black that
 * belonged to the platform's first shop. That grey is now the same in every
 * shop, so this answers the same value for every accent; it still takes one
 * because the caller is a page painting a shop and should not have to know
 * which half of the palette a phone's address bar lands in. Called with no
 * accent at all (the ERP, a caller from before this file derived neutrals) it
 * still answers the old pair.
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
