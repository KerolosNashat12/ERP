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
      productJs, /priceVaries/,
      'variantPicker prints a price on every chip again — under a heading that '
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

  await ctx.test('nothing animates it on its own', () => {
    /**
     * A marquee looks alive in a screenshot and is miserable to use: every
     * target is moving, so clicking the brand you spotted means chasing it. If
     * one is ever added, this is the test that should be argued with first.
     */
    const rail = ruleFor('.rail-track');
    assert.ok(
      !/animation/.test(rail),
      'the brands rail animates itself — a moving row of links is a row of links '
      + 'that has to be caught before it can be clicked.',
    );
    assert.match(rail, /overflow-x:\s*auto/, 'the rail must scroll by finger, wheel and keyboard');
  });

  await ctx.test('the arrows disappear when there is nothing to scroll to', () => {
    assert.match(
      cardsJs, /button\.hidden = !scrollable/,
      'a shop with six brands would get arrows that do nothing.',
    );
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
