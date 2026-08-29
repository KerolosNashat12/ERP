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
  const lighten = direction === 'lighten';
  const step = lighten ? 0.02 : -0.02;
  let { l } = hsl;
  let candidate = hex;
  for (let i = 0; i < 50; i += 1) {
    if (contrast(candidate, against) >= minContrast) return candidate;
    l += step;
    /*
     * Stop at the end of the range this walk is actually walking towards.
     *
     * This used to read `if (l <= 0.04 || l >= 0.97) break` — one guard for
     * both directions, which was invisible while the only direction was
     * `darken`. The night ground made `lighten` real and the bug with it: a
     * shop whose accent is pure black starts at l = 0, takes its first step UP
     * to 0.02, is told 0.02 is too close to the floor, and breaks out holding
     * the black it started with — so a black-accented shop got a black price
     * on a black page. Each direction now watches only the end it is
     * approaching.
     */
    if (lighten ? l >= 0.97 : l <= 0.04) break;
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
 * THE NIGHT RAMP — the paper for a shop that sells at night.
 *
 * A second ramp rather than the first one inverted, because inverting a page
 * built for white is how a dark mode ends up grey and flat. This one is
 * measured: the owner sent a published design (see
 * /home/claude/briefs/storefront-luxe.md) and these are the levels that
 * reproduce it, to within a couple of units per channel, for HIS accent.
 *
 * ── Why this ramp carries hue when the day ramp refuses to ──────────────────
 * The day ramp had its hue taken away on purpose and the reason still stands:
 * gold turned and desaturated makes a pale yellow-green PAGE, and the owner
 * looked at one and asked for grey. But that argument is about a light ground,
 * where a few percent of saturation is a stain across two thirds of the screen.
 * At 3.5% lightness it is the opposite — a pure grey black reads as switched-off
 * television, and every luxury shop in the world warms it. The measured design
 * is warm: 10/9/8 is not neutral, and neither is its cream.
 *
 * So the hue here IS the shop's, and the saturation is held on a short lead:
 * `NIGHT_TINT_CEILING` caps it, and the test measures the distance from a true
 * grey at every level so a future edit cannot turn the page into a colour.
 * A gold shop gets #0A0908; a violet shop gets a violet-black of the same
 * depth, which is the platform working rather than the platform leaking.
 *
 * Each level is {l, s} — lightness and saturation as fractions, at the
 * accent's own hue. Read them as "how deep, and how much of the shop is in it".
 */
const NIGHT_TINT_CEILING = 0.40;

const NIGHT = {
  // The page. Deepest thing on the site, and the one the eye reads as black.
  bg: { l: 0.035, s: 0.11 },
  /*
   * The second ground — and on night paper it goes UP from the page, which is
   * the opposite of what its name does in daylight and is worth stating
   * plainly because it looks like a mistake.
   *
   * In daylight `bg-2` recedes: the page is 240 and it drops to 228, because
   * a thing that has to sit BEHIND a white card has room below it. At 3.5%
   * lightness there is no room below — every step down from the night page
   * lands on black, and three grounds that all read as black are one ground.
   * So it rises instead, by less than a card does, which is exactly what the
   * measured design does with the band under its hero (#0E0C09 over #0A0908).
   * The RELATIONSHIP survives — page, then this, then a card — and only the
   * direction the range allowed has changed.
   */
  bg2: { l: 0.046, s: 0.13 },
  /*
   * A card, and the one level where the day ramp's own instrument stops
   * working. In daylight the page-to-card step is stated as a WCAG ratio —
   * 1.14:1 — and held there because below about 1.10 a card loses its edge on
   * a phone in daylight. That ratio is useless here: near the bottom of the
   * range its 0.05 constant swamps both luminances, so page-against-card
   * measures 1.08:1 no matter how visibly different they are, and the measured
   * design itself sits at exactly that. What separates two near-blacks is the
   * LIGHTNESS distance, and this is 4 points of it — which is why the test for
   * this ramp measures lightness and the test for the day ramp measures
   * contrast. Same question, two grounds, two right instruments.
   */
  surface: { l: 0.075, s: 0.16 },
  // The well a photo sits in, INSIDE a dark card — LIGHTER than the card, the
  // mirror of the day ramp's well being lighter than its page. A photograph
  // with a transparent corner has to land on something, and on night paper
  // that something has to be a step up or the picture has no edge at all.
  well: { l: 0.105, s: 0.14 },
  // Headings and product names. Cream, not white: #fff on near-black rings the
  // same way #000 rings on white, and the design's own ink is 245/240/232.
  ink: { l: 0.935, s: 0.35 },
  // Body copy beside a heading.
  ink2: { l: 0.735, s: 0.18 },
  // Muted — a card's brand line, a footer link, a note.
  ink3: { l: 0.398, s: 0.06 },
};

/**
 * A night level, at the shop's own hue, with the tint held under the ceiling
 * AND scaled by how much colour the shop actually asked for.
 *
 * The scaling is the part that is easy to leave out and wrong to. A hue on its
 * own says nothing about whether a shop wanted colour: `#111111` and `#f5f5f5`
 * both carry hue 0, which is red, and a table of fixed saturations would hand
 * a shop that deliberately chose black or white a red-black page — the exact
 * mistake the day ramp had its hue taken away for. So the tint is multiplied
 * by the accent's own saturation, normalised against the measured design's
 * (0.457 for #C9A96E): that shop lands on its measured values unchanged, a
 * greyscale accent lands on a true grey black, and everything between scales.
 */
const NIGHT_TINT_REFERENCE = 0.457;

const night = (hue, level, accentSaturation = NIGHT_TINT_REFERENCE) => {
  const strength = Math.min(1, Math.max(0, accentSaturation / NIGHT_TINT_REFERENCE));
  return hslToHex({
    h: hue, s: Math.min(level.s, NIGHT_TINT_CEILING) * strength, l: level.l,
  });
};

/**
 * The hairline, on night paper: THE ACCENT AT LOW ALPHA, not a grey.
 *
 * This is the single measurement that carries the most of the look and it is
 * the one that would be easiest to miss. Every rule and every card edge in the
 * design is `rgba(201,169,110,.22)` — the shop's own colour, whispered. A grey
 * hairline on black reads as a cheap panel; a gold one at 22% reads as a frame
 * around something expensive, and it costs nothing but this line.
 */
const nightLine = (accentRgb, alpha) => `rgba(${accentRgb.join(', ')}, ${alpha})`;

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
function neutrals(dark, nightPaper, accentRaw) {
  if (nightPaper) return nightNeutrals(accentRaw);
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
 * The night paper's neutrals — same keys, same meanings, different ground.
 *
 * Every key `neutrals()` returns is returned here too, and that is the whole
 * contract: shop.css names these and only these, so a page can change from
 * daylight to night without a single new property being invented. What changes
 * is which direction each one moves.
 *
 * The bands do NOT invert here. On a white page a band is a dark strip that
 * separates the footer from the paper; on a black page there is nothing to
 * separate it FROM, so the band becomes the deepest ground (`bg2`) and the
 * page's own inks stay on top of it. A near-black band on a near-black page
 * would be a footer nobody can see the top of.
 */
function nightNeutrals(accentRaw) {
  const { h: hue, s: sat } = rgbToHsl(accentRaw);
  const accentRgb = toRgb(accentRaw);
  const bg = night(hue, NIGHT.bg, sat);
  const bg2 = night(hue, NIGHT.bg2, sat);
  const ink = night(hue, NIGHT.ink, sat);
  const ink2 = night(hue, NIGHT.ink2, sat);
  const ink3 = night(hue, NIGHT.ink3, sat);

  return {
    bg,
    bg2,
    well: night(hue, NIGHT.well, sat),
    surface: night(hue, NIGHT.surface, sat),
    ink,
    ink2,
    ink3,
    // The measured 0.22, and a fainter sibling for a rule that only divides.
    line: nightLine(accentRgb, 0.22),
    line2: nightLine(accentRgb, 0.12),
    // A shadow is an absence of light and there is no light here: the design
    // has not one box-shadow on it, and depth is carried by the hairline and
    // the card's step instead. The channels stay declared because shop.css
    // spends them, and pure black is the only honest value on this ground.
    shadowRgb: '0 0 0',
    chrome: bg2,
    onChrome: ink,
    onChrome2: ink2,
    onChrome3: ink3,
    onChrome4: ink3,
    chromeLine: nightLine(accentRgb, 0.22),
    chromeLine2: nightLine(accentRgb, 0.12),
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
export function palette(accentInput, dark = true, { night: nightPaper = false } = {}) {
  const accentRaw = normalizeHex(accentInput) || DEFAULT_ACCENT;
  const accentHsl = rgbToHsl(accentRaw);
  const ground = nightPaper ? night(accentHsl.h, NIGHT.bg, accentHsl.s) : '#ffffff';

  /*
   * Every accent shade is measured against the GROUND IT LANDS ON, and on
   * night paper that ground is the near-black page — so the two shifts flip
   * direction. `strong` is the one worth naming: in daylight it is the accent
   * pushed DARKER until it is legible as words on white; on black it has to go
   * LIGHTER for exactly the same reason. A palette that kept darkening here
   * would answer "make this readable" by walking the colour towards the page.
   */
  const toward = nightPaper ? 'lighten' : 'darken';
  const accent = shiftUntilReadable(accentRaw, ground, 2.9, toward);
  const strong = shiftUntilReadable(accent, ground, 4.5, toward);
  // On the dark chrome band.
  const bright = shiftUntilReadable(accentRaw, CHROME_INK, 5, 'lighten');
  // A wash for badges and soft panels: the colour itself, mixed into the paper
  // rather than desaturated — a hue lightened in HSL goes grey, and a grey
  // wash under a shop's own badge is the one shade that looks like a bug. On
  // night paper it mixes into the night, which is what makes a soft badge a
  // dim ember rather than a bright sticker.
  const soft = mix(accentRaw, ground, nightPaper ? 0.22 : 0.16);
  // Ink ON a solid fill of the accent. Measured, not assumed: white reads on a
  // deep colour and disappears on a pale one, and both get chosen by shops.
  // On night paper the dark option is the page itself, so a gold button carries
  // the page's own black the way the design does.
  const darkInk = nightPaper ? ground : '#10131a';
  const solidInk = contrast('#ffffff', accent) >= 4 ? '#ffffff' : darkInk;
  const deep = shiftUntilReadable(accent, ground, 6, nightPaper ? 'darken' : 'darken');

  return {
    accentRaw, accent, strong, bright, soft, solidInk, deep, rgb: toRgb(accent).join(' '),
    ...neutrals(dark, nightPaper, accentRaw),
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
export function themeVariables(accentInput, dark = true, options = {}) {
  const p = palette(accentInput, dark, options);
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
export function applyTheme(node, { accent, dark = true, night: nightPaper = false } = {}) {
  if (!node) return;
  const vars = themeVariables(accent, dark, { night: nightPaper });
  for (const [key, value] of Object.entries(vars)) node.style.setProperty(key, value);
  if (node.dataset) {
    node.dataset.theme = dark ? 'dark' : 'light';
    /*
     * A second attribute rather than a third value of `data-theme`, because
     * the two answer different questions and shop.css asks both: `data-theme`
     * decides what a BAND is, `data-paper` decides what the PAGE is. Folding
     * them into one would make every existing `[data-theme="light"]` rule in
     * the sheet mean something new.
     */
    node.dataset.paper = nightPaper ? 'night' : 'day';
  }
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
