/**
 * One hex in, a whole design out — measured rather than eyeballed.
 *
 * `public/shared/brandTheme.js` is the only place a shop's colour becomes a
 * palette, and since the storefront redesign that includes the NEUTRALS: the
 * paper, the ink, the hairlines and the tint a card's shadow is coloured with
 * are all the accent's own hue, desaturated and moved along lightness. Three
 * things have to be true about that, and none of them survives being assumed:
 *
 *   1. it reproduces the design. The source site is one shop's coral, and with
 *      `#F07878` the derivation has to land on the real values read off it —
 *      otherwise "the same design in your colour" is a claim, not a function;
 *   2. it stays legible for colours the design never saw. A shop can type
 *      `#FFFF00`, `#000000` or a near-white beige into the ERP's colour box,
 *      and every one of those still has to produce a page somebody can read.
 *      The floors are contrast ratios, checked here on every accent below;
 *   3. it did not disturb the accent shades that were already there. Seven
 *      properties predate this file's neutrals and are read by shop.css, the
 *      ERP's live preview and the monogram favicon. Their values are frozen
 *      below, taken from the code as it stood before the neutrals existed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  palette, themeVariables, applyTheme, contrast, DEFAULT_ACCENT,
} from '../public/shared/brandTheme.js';

// ------------------------------------------------------------------ helpers

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Channel-wise closeness, because `#fbf1ed` vs `#fdf3ed` is a match and a string comparison says it is not. */
function assertNear(got, want, tolerance, label) {
  const [a, b] = [rgb(got), rgb(want)];
  const off = Math.max(...a.map((channel, i) => Math.abs(channel - b[i])));
  assert.ok(
    off <= tolerance,
    `${label}: ${got} is ${off}/255 off ${want} (tolerance ${tolerance})`,
  );
}

/**
 * The spread. Not a list of nice brand colours — the point is the ones a nice
 * brand colour would never be: the primaries at full saturation (whose hues
 * carry wildly different luminance at the same HSL lightness), a near-white
 * that has almost no room to go lighter, a near-black with almost none to go
 * darker, and the three greyscale accents that have no hue to derive from.
 */
const SPREAD = [
  '#f07878', // the design's coral
  '#c8a24a', // the platform default gold
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

// -------------------------------------------------- 1. it reproduces the design

/**
 * The tokens on the left are the source site's real computed values (see the
 * design brief). The tolerances are per channel, out of 255: 4 is 1.6% of the
 * range, under a JPEG's own rounding error and far under anything an eye
 * resolves on two large flat fields side by side.
 */
test('a coral accent reproduces the design it was calibrated on', () => {
  const v = themeVariables('#F07878', true);

  assertNear(v['--bg'], '#fdf3ed', 4, '--bg (the paper)');
  assertNear(v['--ink'], '#3d2b1f', 6, '--ink');
  assertNear(v['--line'], '#f0d8d0', 4, '--line (the hairline)');

  // The shadow is spent as `rgb(var(--shadow-rgb) / .06)`, so it is three
  // numbers rather than a hex — the design's are `rgba(200,120,100,.06)`.
  const shadow = v['--shadow-rgb'].split(' ').map(Number);
  assert.equal(shadow.length, 3);
  const wanted = [200, 120, 100];
  shadow.forEach((channel, i) => assert.ok(
    Math.abs(channel - wanted[i]) <= 6,
    `--shadow-rgb: ${v['--shadow-rgb']} vs ${wanted.join(' ')}`,
  ));

  // --ink-3 is the one value that deliberately sits darker than the design's.
  // The site's own muted ink `#C4A090` measures 2.19:1 on its own paper, which
  // is under this file's 2.8 floor for it; legibility is non-negotiable and a
  // pixel-exact match is not, so the tone is the design's and the lightness is
  // the floor's. It must still be the same warm tan, not a brown.
  assertNear(v['--ink-3'], '#c4a090', 28, '--ink-3 (muted ink, lifted to the floor)');
  assert.ok(contrast(v['--ink-3'], v['--bg']) >= 2.8);
  assert.ok(contrast('#c4a090', '#fdf3ed') < 2.8, 'the design\'s own muted ink is under the floor');
});

test('the coral shop\'s cards are white paper and its band is its own ink', () => {
  const v = themeVariables('#F07878', true);
  assert.equal(v['--surface'], '#ffffff');
  assert.equal(v['--chrome'], v['--ink']); // the design's deep-brown footer
  assert.equal(v['--on-chrome'], '#ffffff');
});

// ------------------------------------------------------- 2. it stays legible

/**
 * The floors, on every accent in the spread and in both modes.
 *
 * `--ink` and `--ink-2` carry sentences; `--ink-3` carries a card's brand line
 * and a section note and is allowed to be decorative-adjacent. The hairlines
 * are the inverse test — a rule that contrasts is a rule that shouts, so they
 * are asserted to stay UNDER their ratio.
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
      assert.ok(line2 < 1.6, `${where}: --line-2 on --bg is ${line2.toFixed(2)}:1`);
      // The fainter hairline is the fainter one.
      assert.ok(line2 <= line, `${where}: --line-2 is louder than --line`);
    }
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
      assert.ok(contrast(v['--chrome-line-2'], band) <= 1.6, `${where}: --chrome-line-2`);
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

/**
 * A greyscale shop has expressed no hue, so it gets the design's own warm cream
 * rather than a page of browser grey — the decision is written down in the file
 * and this is what holds it there. `#000000`, `#ffffff` and `#808080` all say
 * the same thing about hue, so they all get the same neutrals.
 */
test('an achromatic accent gets warm paper, not a dead grey one', () => {
  const black = themeVariables('#000000', true);
  const white = themeVariables('#ffffff', true);
  const grey = themeVariables('#808080', true);

  assert.equal(black['--bg'], white['--bg']);
  assert.equal(black['--bg'], grey['--bg']);
  assert.equal(black['--ink'], grey['--ink']);

  for (const key of ['--bg', '--ink', '--line', '--ink-3']) {
    const [r, g, b] = rgb(black[key]);
    assert.ok(r > g && g > b, `${key} = ${black[key]} is not warm (it is grey or cool)`);
    assert.ok(r - b >= 3, `${key} = ${black[key]} has no tint at all`);
  }
});

// --------------------------------------------- 3. the neutrals carry the hue

/**
 * The whole point, stated as a comparison rather than a colour: a red shop's
 * ink has more red in it than blue, a blue shop's has more blue than red, and
 * neither is the other's. If this test passes with the neutrals hard-coded,
 * the neutrals are not hard-coded.
 */
test('the neutrals are the shop\'s hue, not a grey', () => {
  const red = themeVariables('#e02b2b', true);
  const blue = themeVariables('#2b4be0', true);
  const green = themeVariables('#2bb04b', true);

  for (const key of ['--bg', '--ink', '--ink-2', '--ink-3', '--line', '--line-2']) {
    const [rr, , rb] = rgb(red[key]);
    assert.ok(rr > rb, `red shop: ${key} = ${red[key]} is not redder than it is blue`);

    const [br, , bb] = rgb(blue[key]);
    assert.ok(bb > br, `blue shop: ${key} = ${blue[key]} is not bluer than it is red`);

    const [, gg, gb] = rgb(green[key]);
    assert.ok(gg > gb, `green shop: ${key} = ${green[key]} is not greener than it is blue`);

    assert.notEqual(red[key], blue[key], `${key} is the same for a red and a blue shop`);
  }

  // The shadow a card casts is tinted too — the design's is `200 120 100`, a
  // warm brown under coral, and it has to be a cool one under indigo.
  const [sr, , sb] = themeVariables('#4f46e5', true)['--shadow-rgb'].split(' ').map(Number);
  assert.ok(sb > sr, 'an indigo shop casts a warm shadow');
});

// ------------------------------------------------------------- 4. the modes

/**
 * Light is not dark inverted, which is the failure this whole two-family split
 * exists to prevent: the paper is the same paper in both, and what changes is
 * the BAND — near-black under a dark shop, a pale wash of the same hue under a
 * light one, each with ink measured against it.
 */
test('a mode changes the bands and leaves the paper alone', () => {
  for (const accent of ['#f07878', '#4f46e5', '#c8a24a']) {
    const dark = themeVariables(accent, true);
    const light = themeVariables(accent, false);

    for (const key of ['--bg', '--surface', '--ink', '--ink-2', '--ink-3', '--line', '--line-2', '--shadow-rgb']) {
      assert.equal(light[key], dark[key], `${accent}: ${key} changed with the mode`);
    }

    assert.equal(dark['--chrome'], dark['--ink'], `${accent}: a dark band is the ink`);
    assert.equal(dark['--on-chrome'], '#ffffff');
    // A light shop's band is paler than its own paper's ink and darker than
    // the paper — a wash, not a slab — and it does not get white text on it.
    assert.notEqual(light['--chrome'], light['--ink']);
    assert.notEqual(light['--on-chrome'], '#ffffff');
    assert.ok(contrast(light['--chrome'], light['--bg']) < 1.6, `${accent}: the pale band shouts`);
  }
});

// -------------------------------------------------------- 5. nothing shifted

/**
 * The regression fence. These are the exact values `themeVariables()` returned
 * before the neutrals were added, captured by running the code as it stood.
 * shop.css, the ERP's live preview and `monogramFavicon()` all read them, and
 * "additive" is only a claim until something fails when it stops being true.
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
 */
test('applyTheme sets the neutrals on a node, not just the accent', () => {
  const set = new Map();
  const node = { style: { setProperty: (k, value) => set.set(k, value) }, dataset: {} };

  const vars = applyTheme(node, { accent: '#f07878', dark: false });
  assert.equal(node.dataset.theme, 'light');
  for (const key of ['--bg', '--surface', '--ink', '--ink-2', '--ink-3', '--line', '--line-2',
    '--shadow-rgb', '--chrome', '--on-chrome', '--on-chrome-2', '--on-chrome-3', '--on-chrome-4',
    '--chrome-line', '--chrome-line-2', '--accent', '--accent-rgb']) {
    assert.equal(set.get(key), vars[key], `${key} did not reach the node`);
  }
  assert.doesNotThrow(() => applyTheme(null, { accent: '#f07878' }));
});
