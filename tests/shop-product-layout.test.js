/**
 * The product page's buy box, option picker and photographs — `public/shop`.
 *
 * Four things the owner asked for after looking at his own shop, and the reason
 * each one is worth a test rather than just a commit:
 *
 * 1. THE BUY BOX HAD NO SHARED EDGE. "Add to cart" stretched to whatever was
 *    left of its row while "Save to favourites" underneath hugged its own
 *    words, so the three controls that make up the only decision on the page
 *    were three different lengths. They are one block with one width now, and
 *    the width is capped so a wide desktop gives the column air instead of
 *    giving the button a metre.
 *
 * 2. THE OPTIONS WERE A STAIRCASE. Each chip sized itself to its own label —
 *    nine options, nine widths, no two edges in line. A staircase reads as nine
 *    unrelated things; equal columns read as one choice with nine answers.
 *
 * 3. THE PRICE WAS PRINTED NINE TIMES. Every option carried "1,000 ج.م" under a
 *    heading that already said 1,000 ج.م in the largest type on the page. The
 *    price belongs to an option only when it is not the same as the others —
 *    that rule lives in `views/product.js` and is asserted here from the source,
 *    because there is no DOM in this suite to render it into.
 *
 * 4. THE PHOTOGRAPH WAS CROPPED. The main frame used `cover`, which is right for
 *    a picture composed for the frame and wrong for this shop: supplier shots of
 *    tall bottles on white, where a square crop takes the cap off the top and
 *    the name off the bottom. Fitting can only add white to a picture already on
 *    white; it can never remove the product from it.
 *
 * These are CSS and source assertions, which is a weak kind of test — it cannot
 * see the page. It can see a rule being deleted, and every one of these four was
 * a rule that was never written rather than one that was wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(here, '..', ...parts), 'utf8');
const css = read('public', 'shop', 'shop.css');
/** The stylesheet with its prose removed — a class named in a comment is history, not a rule. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const productJs = read('public', 'shop', 'js', 'views', 'product.js');
const cardsJs = read('public', 'shop', 'js', 'ui', 'cards.js');

/** The declarations inside one selector's block, comments stripped. */
function ruleFor(selector) {
  const index = css.indexOf(`\n${selector} {`);
  assert.ok(index >= 0, `${selector} is not in the stylesheet`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the buy box is one block with one width', async (ctx) => {
  await ctx.test('the actions share a column, so their edges line up', () => {
    const rule = ruleFor('.buy-actions > .btn');
    assert.match(
      rule, /inline-size:\s*100%/,
      'the buy actions must fill their shared column — otherwise "add to cart" and '
      + '"save to favourites" size themselves to their own words and never line up.',
    );
  });

  await ctx.test('and the column is capped, so it cannot run away on a desktop', () => {
    assert.match(
      ruleFor('.buy-box'), /max-inline-size:\s*[\d.]+rem/,
      '.buy-box has no cap — on a wide screen the primary button becomes a metre '
      + 'of gold with a word in the middle of it.',
    );
  });

  await ctx.test('the old two-track row is gone, not merely overridden', () => {
    assert.ok(
      !rules.includes('.buy-row') && !productJs.includes('buy-row'),
      'the `.buy-row` grid is still around; two layouts for one row is how they '
      + 'drift apart again.',
    );
  });
});

test('the option picker is a set of choices, not a staircase', async (ctx) => {
  await ctx.test('the chips sit in equal columns', () => {
    const rule = ruleFor('.variants');
    assert.match(rule, /display:\s*grid/, '.variants is not a grid, so chips size to their labels');
    assert.match(
      rule, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/,
      'the columns must be equal and self-fitting: a breakpoint deciding how many '
      + 'options fit per row is a breakpoint that will be wrong for some shop.',
    );
  });

  await ctx.test('the chip is padded logically, so a swatch keeps its side', () => {
    const rule = ruleFor('.variant');
    assert.ok(
      !/\bpadding:\s*[^;]*var\(--sp-\d\)\s+var\(--sp-\d\)\s+var\(--sp-\d\)\s+var\(--sp-\d\)/.test(rule),
      'four-value physical padding on `.variant` puts the swatch\'s breathing room '
      + 'on the wrong side of the chip the moment the page mirrors.',
    );
    assert.match(rule, /padding-inline:/, '.variant should be padded with logical properties');
  });

  await ctx.test('a price is shown only where it actually differs', () => {
    assert.match(
      productJs, /pricesVary/,
      'the picker prints a price on every chip again — under a heading that '
      + 'already says it, in the largest type on the page.',
    );
    assert.match(
      productJs, /new Set\(prices\.map\(Number\)\)\.size > 1/,
      'the "do the options differ" test must compare the values themselves, not '
      + 'how many there are.',
    );
  });

  await ctx.test('the chosen option is named, not merely outlined', () => {
    assert.match(
      productJs, /field-chosen/,
      'nothing writes the chosen option into the field label — which leaves "which '
      + 'one am I buying" answerable only by spotting which of nine borders is darker.',
    );
  });

  await ctx.test("the heading is the shop's own word for the attribute", () => {
    /**
     * `variant_label` is a shorthand somebody typed. The ERP already holds the
     * real thing — an attribute named الحجم with values named ٣٠ مل — and the
     * storefront read none of it, so nine options sat under a generic heading.
     */
    assert.match(
      productJs, /attributeGroups/,
      'the picker no longer groups by the shop\'s own attributes, so the page is '
      + 'back to nine transliterated words with nothing over them.',
    );
    assert.match(
      productJs, /groupName/,
      "the attribute's own name must head its row — that is the whole point of "
      + 'reading the attributes at all.',
    );
    assert.match(
      productJs, /labelPicker/,
      'the fallback for a shop that has not set attributes up is gone; that is '
      + 'most shops on their first day.',
    );
  });
});

test('a product photograph is fitted, never cropped', async (ctx) => {
  await ctx.test('the main frame fits', () => {
    assert.match(
      ruleFor('.gallery-main .photo > img'), /object-fit:\s*contain/,
      'the gallery crops again: a square crop of a tall bottle removes the cap and '
      + 'the name, which are the two things somebody opened the page to see.',
    );
  });

  await ctx.test('and so does the thumbnail that promises it', () => {
    assert.match(
      ruleFor('.thumb img'), /object-fit:\s*contain/,
      'a cropped thumbnail promises a picture that clicking it does not show.',
    );
  });

  await ctx.test('an empty frame says it is empty', () => {
    assert.match(
      ruleFor('.gallery-main .photo-empty'), /border:\s*[\d.]+px dashed/,
      'a product with no photograph shows a full screen of blank white, which the '
      + 'owner read as the page having failed rather than the piece having no photo.',
    );
  });
});

test('the brands rail scrolls when it is pushed and holds still when it is not', async (ctx) => {
  await ctx.test('it is a rail, not the old wall of pills', () => {
    assert.ok(
      !rules.includes('.brand-strip') && !rules.includes('.brand-pill'),
      'the wrapped pill strip is still in the stylesheet; sixty of them filled six '
      + 'rows and gave a shopper nothing to catch on.',
    );
  });

  await ctx.test('it drifts, and it stops the moment somebody goes near it', () => {
    /**
     * The objection to a moving row of links is that every target is moving, so
     * clicking the brand you spotted means chasing it. The drift is only
     * defensible because these four lines are here: pointer over it, keyboard
     * focus inside it, a finger on it, or a wheel turned, and it halts. Delete
     * any one of them and the row becomes the thing the objection describes.
     */
    for (const guard of ['pointerenter', 'focusin', 'touchstart', 'wheel']) {
      assert.match(
        cardsJs, new RegExp(`'${guard}'`),
        `the rail no longer pauses on ${guard} — a moving row of links has to be `
        + 'caught before it can be clicked.',
      );
    }
    assert.match(
      cardsJs, /prefers-reduced-motion/,
      'the drift ignores a reader who asked their system for less motion.',
    );
    assert.match(
      cardsJs, /document\.hidden/,
      'the drift keeps running in a background tab, on somebody\'s phone battery.',
    );
    assert.match(
      ruleFor('.rail-track'), /overflow-x:\s*auto/,
      'the rail must still scroll by finger, wheel and keyboard',
    );
  });

  await ctx.test('the second copy that makes the loop seamless is hidden from readers', () => {
    assert.match(
      cardsJs, /'aria-hidden': 'true'[\s\S]{0,80}cloneNode/,
      'the cloned half of the rail is announced too, so the shop appears to stock '
      + 'twice as many brands as it does.',
    );
    assert.match(
      cardsJs, /link\.tabIndex = -1/,
      'the clones are still in the tab order — Tab would walk sixty brands twice.',
    );
  });

  await ctx.test('the arrows disappear when there is nothing to scroll to', () => {
    assert.match(
      cardsJs, /button\.hidden = !scrollable/,
      'a shop with six brands would get arrows that do nothing.',
    );
  });

  await ctx.test('the second copy is only made when there is something to loop', () => {
    /**
     * The shop that had ONE brand showed it twice. The clone exists so the
     * drift can wrap without reaching an end — and a row that fits on screen
     * has no end to reach and never drifts, so its copy is pure duplication
     * sitting in plain sight next to the original. Obvious in hindsight;
     * invisible in testing, because every fixture had enough brands to scroll.
     */
    assert.match(
      cardsJs, /if \(track\.scrollWidth <= track\.clientWidth \+ FITS\) return false/,
      'the rail clones itself unconditionally again — a shop with one brand will '
      + 'show that brand twice.',
    );
    assert.match(
      cardsJs, /clones\.remove\(\)/,
      'nothing removes the copy when the window grows and one row starts to fit, '
      + 'so the duplicate comes back on a wide screen.',
    );
  });

  await ctx.test('and a rail with nothing to scroll centres what it has', () => {
    assert.match(
      cardsJs, /classList\.toggle\('is-static', !scrollable\)/,
      'a rail of two cards is pinned to one edge of a full-width band, which '
      + 'reads as a layout mistake rather than as a short shelf.',
    );
    assert.match(ruleFor('.rail-track.is-static'), /justify-content:\s*center/);
  });

  await ctx.test('a brand wears its logo where the shop recorded one', () => {
    assert.match(
      cardsJs, /row\.logo_url/,
      '`brands.logo_url` has been in the schema all along and the storefront still '
      + 'ignores it.',
    );
    assert.match(
      cardsJs, /img\.addEventListener\('error'/,
      'a logo that fails to load must fall back to the letter rather than leaving '
      + "the browser's broken-image glyph in a shop window.",
    );
  });
});

test('the home page is one design, not three', async (ctx) => {
  /**
   * It used to be a grid of category tiles, a wrapped strip of brand pills and
   * two grids of products — three ways of saying "here are some things",
   * stacked. They are one object and one shelf now: the same white card with
   * the same hairline, the same corner and the same round face, on a rail that
   * runs the full width of its band.
   */
  await ctx.test('a category tile and a brand card are the same object', () => {
    const rule = ruleFor('.tile,\n.brand-card');
    assert.match(rule, /border:\s*1px solid var\(--line\)/);
    assert.match(rule, /border-radius:\s*var\(--radius\)/);
    assert.match(
      ruleFor('.tile-badge,\n.brand-card-face'), /inline-size:\s*104px/,
      'the two faces are different sizes again, which is what made the same page '
      + 'look like two designs.',
    );
  });

  await ctx.test('a product card carries the same edge', () => {
    assert.match(
      ruleFor('.card'), /border:\s*1px solid var\(--line\)/,
      'three white objects on a white band with only a soft shadow between them '
      + 'read as three different designs.',
    );
  });

  await ctx.test('every shelf on the home page is a rail', () => {
    const home = read('public', 'shop', 'js', 'views', 'home.js');
    assert.ok(
      !home.includes('productGrid'),
      'a grid is back on the home page beside the rails; the point of this pass '
      + 'was that the page says "here are some things" exactly one way.',
    );
    // Only the brands move on their own — see the note in home.js.
    assert.match(home, /drift: false/);
  });
});
