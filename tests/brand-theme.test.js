/**
 * One hex in, a whole design out — measured rather than eyeballed.
 *
 * `public/shared/brandTheme.js` is the only place a shop's colour becomes a
 * palette, and as of the owner's "the background colour white solid and gray"
 * note it is also the only place the NEUTRALS are decided — and they are no
 * longer decided by the accent. They were, for one release: the paper, the
 * ink, the hairlines and the shadow were the accent's own hue turned and wrung
 * out, which gave a gold shop a pale yellow-green page. Now they are one grey
 * ramp every shop shares.
 *
 * That moves what these tests are for. When a neutral was derived per shop,
 * the question was "does the shift rescue this accent"; a fixed ramp cannot be
 * rescued and does not need to be, so the question is now:
 *
 *   1. is the RAMP right — is the surface solid white, is the page a grey you
 *      can actually see the card edge against, does `--bg-2` recede from a
 *      white card, do the inks clear their floors and do the hairlines stay
 *      under their ceilings, on the deepest ground each one lands on;
 *   2. is it genuinely neutral, and genuinely shared — no accent, however
 *      saturated, may put one point of hue into one neutral or move one of
 *      them by one channel;
 *   3. does it still hold in BOTH modes, which are still two designs rather
 *      than one inverted;
 *   4. did it disturb the accent shades. Seven properties predate the
 *      neutrals, are read by shop.css, the ERP's live preview and the monogram
 *      favicon, and are frozen below at the values they have always had.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  palette, themeVariables, applyTheme, contrast, DEFAULT_ACCENT,
} from '../public/shared/brandTheme.js';

// ------------------------------------------------------------------ helpers

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Every neutral property the sheet reads, minus the shadow's three channels. */
const NEUTRAL_KEYS = [
  '--bg', '--bg-2', '--surface', '--ink', '--ink-2', '--ink-3', '--line', '--line-2',
  '--chrome', '--on-chrome', '--on-chrome-2', '--on-chrome-3', '--on-chrome-4',
  '--chrome-line', '--chrome-line-2',
];

/**
 * The spread. Not a list of nice brand colours — the point is the ones a nice
 * brand colour would never be: the primaries at full saturation (whose hues
 * carry wildly different luminance at the same HSL lightness), a near-white
 * that has almost no room to go lighter, a near-black with almost none to go
 * darker, and the three greyscale accents that have no hue at all.
 */
const SPREAD = [
  '#f07878', // the design's coral
  '#c8a24a', // the platform default gold — the owner's own shop
  '#4f46e5', // indigo
  '#000000', // achromatic: black
  '#ffffff', // achromatic: white
  '#808080', // achromatic: mid grey
  '#0a0a0a', // near-black
  '#f9f6f2', // near-white, and warm
  '#fde2e4', // a very pale pink — an accent with nowhere lighter to go
  '#ff0000', '#00ff00', '#0000ff', // fully saturated primaries
  '#ffff00', '#00ffff', '#ff00ff', // …and secondaries
  '#2e7d32', // bottle green
  '#8b0000', // dark red
  '#5b21b6', // violet
  '#e8b4d0', // dusty rose
  '#123456', // navy
  '#fef08a', // pale yellow
  '#ff8c00', // orange
  '#f5f5dc', // beige — barely any saturation at all
  '#111827', // the ERP's own near-black
];

// ------------------------------------------------------- 1. the ramp itself

/**
 * The note, as a number.
 *
 * "White solid and gray" is two colours and one relationship, and the
 * relationship is the part that can fail: white cards sit directly on the page
 * on every screen this site has, so if the two are within a hair of each other
 * the card edge vanishes and the whole design collapses into one flat sheet —
 * which is the failure a near-white `--surface` would have shipped.
 *
 * 1.12:1 is the floor asserted here. Two large flat fields side by side is the
 * easiest contrast comparison an eye ever gets (no thin strokes, no small
 * type), and a step of roughly a tenth of a ratio point survives a phone at
 * half brightness in daylight, which is where most of this shop's customers
 * are. The ceiling matters too and is the reason for the second assertion: past
 * about 1.35 the grey stops being paper and starts being a filled panel with
 * white holes punched in it, and the owner asked for a background, not a frame.
 */
const SURFACE_STEP_MIN = 1.12;
const SURFACE_STEP_MAX = 1.35;

test('the surface is solid white and the page is a grey you can see it against', () => {
  for (const accent of SPREAD) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      const where = `${accent} (${dark ? 'dark' : 'light'})`;

      assert.equal(v['--surface'], '#ffffff', `${where}: --surface is not solid white`);

      const step = contrast(v['--surface'], v['--bg']);
      assert.ok(
        step >= SURFACE_STEP_MIN,
        `${where}: --surface on --bg is ${step.toFixed(3)}:1 — the card edge is invisible`,
      );
      assert.ok(
        step <= SURFACE_STEP_MAX,
        `${where}: --surface on --bg is ${step.toFixed(3)}:1 — the page is a panel, not paper`,
      );
    }
  }
});

/**
 * `--bg-2` exists for one job: a ground that recedes from a WHITE card — a
 * photo frame, an inset well, a skeleton. So it is asserted twice, because it
 * has two grounds. It must be a real step under the page (or it is a duplicate
 * of `--bg` and the sheet should have used that), and a clearly readable step
 * under the surface (or the frame it draws is not there at all).
 */
test('--bg-2 is a step below the page and further below a card', () => {
  for (const dark of [true, false]) {
    const v = themeVariables(DEFAULT_ACCENT, dark);

    const [bg] = rgb(v['--bg']);
    const [bg2] = rgb(v['--bg-2']);
    assert.ok(bg2 < bg, `--bg-2 (${v['--bg-2']}) is not deeper than --bg (${v['--bg']})`);

    const underPage = contrast(v['--bg-2'], v['--bg']);
    const underCard = contrast(v['--bg-2'], v['--surface']);
    assert.ok(underPage >= 1.08, `--bg-2 on --bg is ${underPage.toFixed(3)}:1`);
    assert.ok(underCard >= 1.2, `--bg-2 on --surface is ${underCard.toFixed(3)}:1`);
  }
});

/**
 * The floors, on every accent in the spread and in both modes.
 *
 * With the ramp fixed these hold by construction rather than by search, which
 * is exactly why they are still measured: nothing shifts an ink up to its floor
 * any more, so an edit to one number in the ramp table is the difference
 * between a legible page and an illegible one, and nothing but this test is
 * standing there.
 *
 * `--ink` and `--ink-2` carry sentences; `--ink-3` carries a card's brand line
 * and a section note and is allowed to be decorative-adjacent. The hairlines
 * are the inverse test — a rule that contrasts is a rule that shouts, so they
 * are asserted to stay UNDER their ratio — and then the inverse of the inverse,
 * because a rule nobody can see is not a rule either.
 */
test('every accent produces a page that can be read', () => {
  for (const accent of SPREAD) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      const where = `${accent} (${dark ? 'dark' : 'light'})`;

      const ink = contrast(v['--ink'], v['--bg']);
      const ink2 = contrast(v['--ink-2'], v['--bg']);
      const ink3 = contrast(v['--ink-3'], v['--bg']);
      const line = contrast(v['--line'], v['--bg']);
      const line2 = contrast(v['--line-2'], v['--bg']);

      assert.ok(ink >= 10, `${where}: --ink on --bg is ${ink.toFixed(2)}:1`);
      assert.ok(ink2 >= 7, `${where}: --ink-2 on --bg is ${ink2.toFixed(2)}:1`);
      assert.ok(ink3 >= 2.8, `${where}: --ink-3 on --bg is ${ink3.toFixed(2)}:1`);
      assert.ok(line < 1.6, `${where}: --line on --bg is ${line.toFixed(2)}:1, not a hairline`);
      assert.ok(line2 < 1.3, `${where}: --line-2 on --bg is ${line2.toFixed(2)}:1`);
      // The fainter hairline is the fainter one.
      assert.ok(line2 <= line, `${where}: --line-2 is louder than --line`);

      // …and both are drawn on cards as often as on the page, where they are
      // the only thing separating two white areas.
      const onCard = contrast(v['--line'], v['--surface']);
      const onCard2 = contrast(v['--line-2'], v['--surface']);
      assert.ok(onCard >= 1.15, `${where}: --line on a card is ${onCard.toFixed(3)}:1 — invisible`);
      assert.ok(onCard2 >= 1.08, `${where}: --line-2 on a card is ${onCard2.toFixed(3)}:1`);
    }
  }
});

/**
 * The same floors on the DEEPEST neutral ground the inks ever land on.
 *
 * `--bg-2` is that ground — deeper than the page, deeper than a card, and in
 * light mode it is the band as well, so an ink that clears its floor here
 * clears it everywhere the sheet puts it. That is the claim the ramp is built
 * on ("measured against the deepest ground, so the rest is free"), and a claim
 * about every other ground is worth exactly one test on the worst one.
 */
test('the inks clear their floors on the deepest neutral ground', () => {
  for (const dark of [true, false]) {
    const v = themeVariables(DEFAULT_ACCENT, dark);
    const deepest = v['--bg-2'];

    assert.ok(contrast(v['--ink'], deepest) >= 10, `--ink on --bg-2: ${contrast(v['--ink'], deepest).toFixed(2)}:1`);
    assert.ok(contrast(v['--ink-2'], deepest) >= 7, `--ink-2 on --bg-2: ${contrast(v['--ink-2'], deepest).toFixed(2)}:1`);
    assert.ok(contrast(v['--ink-3'], deepest) >= 2.8, `--ink-3 on --bg-2: ${contrast(v['--ink-3'], deepest).toFixed(2)}:1`);
  }
});

test('every accent produces a band that can be read', () => {
  for (const accent of SPREAD) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      const where = `${accent} (${dark ? 'dark' : 'light'})`;
      const band = v['--chrome'];

      assert.ok(contrast(v['--on-chrome'], band) >= 10, `${where}: --on-chrome`);
      assert.ok(contrast(v['--on-chrome-2'], band) >= 7, `${where}: --on-chrome-2`);
      assert.ok(contrast(v['--on-chrome-3'], band) >= 4.5, `${where}: --on-chrome-3`);
      assert.ok(contrast(v['--on-chrome-4'], band) >= 2.8, `${where}: --on-chrome-4`);
      // The band's own rules are held to the same ceiling as the paper's
      // hairlines — which is already stricter than the sheet's blue-grey
      // literals were (`#33405a` on `#111827` measures 1.71:1).
      assert.ok(contrast(v['--chrome-line'], band) <= 1.6, `${where}: --chrome-line`);
      assert.ok(contrast(v['--chrome-line-2'], band) <= 1.3, `${where}: --chrome-line-2`);
    }
  }
});

test('no accent produces a NaN, an out-of-range channel or a malformed value', () => {
  const hex = /^#[0-9a-f]{6}$/;
  const triple = /^\d{1,3} \d{1,3} \d{1,3}$/;
  for (const accent of [...SPREAD, '', null, undefined, 'not a colour', '#abc']) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      for (const [key, value] of Object.entries(v)) {
        const ok = key.endsWith('-rgb') ? triple.test(value) : hex.test(value);
        assert.ok(ok, `${accent} ${key} = ${JSON.stringify(value)}`);
        if (key.endsWith('-rgb')) {
          for (const channel of value.split(' ').map(Number)) {
            assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
          }
        }
      }
    }
  }
});

// --------------------------------------------- 2. the neutrals carry no hue

/**
 * The note itself, stated the only way it can be stated exactly: a grey is a
 * colour whose three channels are the same number. Not "close to the same" —
 * the same, because the moment one of them is derived from anything the shop
 * typed, the paper is tinted again and the owner is looking at a yellow-green
 * page for the second time.
 *
 * This is the test that would have caught the version he complained about, and
 * it is the inverse of the test that used to stand here ("the neutrals are the
 * shop's hue, not a grey"). Both cannot be true; this one is what was asked for.
 */
test('the neutrals carry no hue, for any accent', () => {
  for (const accent of SPREAD) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      const where = `${accent} (${dark ? 'dark' : 'light'})`;

      for (const key of NEUTRAL_KEYS) {
        const [r, g, b] = rgb(v[key]);
        assert.ok(r === g && g === b, `${where}: ${key} = ${v[key]} is tinted, not grey`);
      }

      // The shadow is three channels rather than a hex, and it is the one that
      // used to be the loudest tint on the page (`200 120 100` under coral).
      const shadow = v['--shadow-rgb'].split(' ').map(Number);
      assert.equal(shadow.length, 3);
      assert.ok(
        shadow[0] === shadow[1] && shadow[1] === shadow[2],
        `${where}: --shadow-rgb = ${v['--shadow-rgb']} is a coloured shadow`,
      );
      // …and it is a shadow: near-black, because the sheet spends it at 6%
      // alpha and a mid-grey at 6% is nothing at all.
      assert.ok(shadow[0] <= 40, `${where}: --shadow-rgb = ${v['--shadow-rgb']} is too pale to read as a shadow`);
    }
  }
});

/**
 * Neutral is not enough on its own — every shop has to get the SAME neutral,
 * or the ramp is still being derived from something and the next accent is the
 * next surprise. Twenty-four accents across the wheel, both modes, one page.
 *
 * The accent keys are deliberately not in this comparison: they must differ,
 * and the test below freezes what they are.
 */
test('every shop gets the same paper', () => {
  const reference = themeVariables(SPREAD[0], true);
  const referenceLight = themeVariables(SPREAD[0], false);

  for (const accent of SPREAD) {
    for (const [dark, want] of [[true, reference], [false, referenceLight]]) {
      const v = themeVariables(accent, dark);
      for (const key of [...NEUTRAL_KEYS, '--shadow-rgb']) {
        assert.equal(v[key], want[key], `${accent} (${dark ? 'dark' : 'light'}): ${key} is not every shop's ${key}`);
      }
    }
  }

  // Including the ones with no hue to express in the first place: a greyscale
  // accent used to be a special case (a saturation floor lifted it off dead
  // browser grey). It is not a case at all now.
  assert.equal(themeVariables('#000000', true)['--bg'], themeVariables('#ff00ff', true)['--bg']);
});

// ------------------------------------------------------------- 3. the modes

/**
 * Light is not dark inverted, which is the failure the two-family split exists
 * to prevent: the paper is the same paper in both — white cards on a grey page
 * — and what changes is the BAND. Dark bands the page with the ink itself and
 * puts white on top; light bands it with `--bg-2`, one step deeper than the
 * page, and puts the page's own inks back on top.
 *
 * The light band must be a step DOWN and not the surface, because `--chrome`
 * fills the order-number card that sits inside a white `.success` card, and a
 * white band on a white card is not a band.
 */
test('a mode changes the bands and leaves the paper alone', () => {
  for (const accent of ['#f07878', '#4f46e5', '#c8a24a']) {
    const dark = themeVariables(accent, true);
    const light = themeVariables(accent, false);

    for (const key of ['--bg', '--bg-2', '--surface', '--ink', '--ink-2', '--ink-3',
      '--line', '--line-2', '--shadow-rgb']) {
      assert.equal(light[key], dark[key], `${accent}: ${key} changed with the mode`);
    }

    assert.equal(dark['--chrome'], dark['--ink'], `${accent}: a dark band is the ink`);
    assert.equal(dark['--on-chrome'], '#ffffff');

    assert.equal(light['--chrome'], light['--bg-2'], `${accent}: a light band is the deeper grey`);
    assert.equal(light['--on-chrome'], light['--ink']);
    assert.notEqual(light['--chrome'], light['--surface'], `${accent}: a white band on a white card`);
    // A wash, not a slab: it still has to read as the same page underneath.
    assert.ok(contrast(light['--chrome'], light['--bg']) < 1.6, `${accent}: the pale band shouts`);
  }
});

// -------------------------------------------------------- 4. nothing shifted

/**
 * The regression fence. These are the exact values `themeVariables()` returned
 * before the neutrals were added, captured by running the code as it stood, and
 * unchanged through the neutrals arriving tinted and then losing their tint.
 * shop.css, the ERP's live preview and `monogramFavicon()` all read them. If
 * one of them moves, a shop's colour has been broken, not a page restyled.
 */
const FROZEN = {
  '#F07878': {
    '--accent': '#ef6f6f',
    '--accent-strong': '#e61c1c',
    '--accent-bright': '#f07878',
    '--accent-soft': '#fde9e9',
    '--accent-deep': '#c41616',
    '--accent-ink': '#10131a',
    '--accent-rgb': '239 111 111',
  },
  '#c8a24a': {
    '--accent': '#b38d36',
    '--accent-strong': '#8c6e2a',
    '--accent-bright': '#c8a24a',
    '--accent-soft': '#f6f0e2',
    '--accent-deep': '#745c23',
    '--accent-ink': '#10131a',
    '--accent-rgb': '179 141 54',
  },
};

test('every accent property still returns exactly what it always did', () => {
  for (const [accent, frozen] of Object.entries(FROZEN)) {
    for (const dark of [true, false]) {
      const v = themeVariables(accent, dark);
      for (const [key, value] of Object.entries(frozen)) {
        assert.equal(v[key], value, `${accent} (${dark ? 'dark' : 'light'}): ${key}`);
      }
    }
  }

  // …and the shape `palette()` hands out, which the favicon and the preview
  // destructure by name.
  const p = palette('#c8a24a', true);
  assert.equal(p.accentRaw, '#c8a24a');
  assert.equal(p.accent, '#b38d36');
  assert.equal(p.strong, '#8c6e2a');
  assert.equal(p.bright, '#c8a24a');
  assert.equal(p.soft, '#f6f0e2');
  assert.equal(p.deep, '#745c23');
  assert.equal(p.solidInk, '#10131a');
  assert.equal(p.rgb, '179 141 54');
  assert.equal(palette(null, true).accentRaw, DEFAULT_ACCENT);
});

/**
 * The neutrals reach a node the same way the accent shades always have — no
 * DOM beyond `style.setProperty`, which is what keeps this file importable in
 * a plain node test and usable on the ERP's preview card as well as on `<html>`.
 * `--bg-2` is in the list because a new property that never reaches the node is
 * a property the sheet falls back on silently.
 */
test('applyTheme sets the neutrals on a node, not just the accent', () => {
  const set = new Map();
  const node = { style: { setProperty: (k, value) => set.set(k, value) }, dataset: {} };

  const vars = applyTheme(node, { accent: '#f07878', dark: false });
  assert.equal(node.dataset.theme, 'light');
  for (const key of [...NEUTRAL_KEYS, '--shadow-rgb', '--accent', '--accent-rgb']) {
    assert.equal(set.get(key), vars[key], `${key} did not reach the node`);
  }
  assert.doesNotThrow(() => applyTheme(null, { accent: '#f07878' }));
});
