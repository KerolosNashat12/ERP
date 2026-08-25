/**
 * The header row — `public/shop/shop.css`.
 *
 * The owner did exactly the right thing: he wrote a real description of his
 * shop in Settings, the one field that most improves how a shop reads in a
 * search result. On the storefront that description is the brand strapline, and
 * on the desktop header it sits in an `auto` grid track beside a `1fr` search
 * box. An `auto` track takes its max-content first and the `fr` track lives on
 * whatever is left, so a good long sentence did not wrap and did not clip — it
 * ate the search field. Measured on the live shop: brand 592px, search 26px, a
 * round blob where a customer types.
 *
 * `text-overflow: ellipsis` was already on both lines and did not save it: an
 * ellipsis decides what happens once a width is settled, it does not settle
 * one. That is the whole lesson, and it is the same shape as the grid bug this
 * project already fixed once on the reports screen — a track's automatic size
 * comes from its contents unless something says otherwise.
 *
 * Two rules now say otherwise, and this file is what keeps them:
 *   - the brand block is capped, because a shop name and a strapline are a mark
 *     of fixed size, not elastic prose;
 *   - the search box has a floor, so nothing else on that row can starve it
 *     either — including whatever gets added to the header next year.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, '..', 'public', 'shop', 'shop.css'), 'utf8');

/** The declarations inside one selector's block, comments stripped. */
function ruleFor(selector) {
  const index = css.indexOf(`\n${selector} {`) >= 0
    ? css.indexOf(`\n${selector} {`)
    : css.indexOf(`\n${selector} `);
  assert.ok(index >= 0, `${selector} is not in the stylesheet`);
  const open = css.indexOf('{', index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

test('a long shop description cannot eat the header', async (ctx) => {
  await ctx.test('the brand block is capped', () => {
    const rule = ruleFor('.brand-text');
    assert.match(
      rule, /max-width:\s*\d+ch/,
      '.brand-text has no max-width — a long strapline will take the search box\'s '
      + 'width again, because the brand grid track is sized by its contents.',
    );
    // Still allowed to shrink: the cap is a ceiling, not a floor.
    assert.match(rule, /min-width:\s*0/, '.brand-text must still be allowed to shrink');
  });

  await ctx.test('the search box has a floor it cannot be pushed below', () => {
    /**
     * `minmax(0, 1fr)` is what let this happen: a track that may be squeezed to
     * nothing eventually is. The floor must be written `min(<size>, 100%)` so
     * that it yields on a narrow window instead of becoming a sideways scroll.
     */
    const desktop = css.slice(css.indexOf('@media (min-width: 900px)'));
    const columns = desktop.match(/grid-template-columns:\s*([^;]+);/);
    assert.ok(columns, 'the desktop header row declares no columns');
    assert.match(
      columns[1], /minmax\(\s*min\([^)]*\)\s*,\s*1fr\s*\)/,
      `the search track is "${columns[1].trim()}" — it needs a floor, written as `
      + 'min(<size>, 100%) so the floor cannot cause an overflow.',
    );
    assert.doesNotMatch(
      columns[1], /minmax\(\s*0\s*,\s*1fr\s*\)/,
      'the search track can still be squeezed to zero width',
    );
  });

  await ctx.test('the two lines still clip rather than wrap', () => {
    // The cap replaces neither: a capped box with wrapping text is a header
    // that changes height as a shop edits its own description.
    for (const selector of ['.brand-name', '.brand-word']) {
      const rule = ruleFor(selector);
      assert.match(rule, /white-space:\s*nowrap/, `${selector} may wrap`);
      assert.match(rule, /text-overflow:\s*ellipsis/, `${selector} has no ellipsis`);
      assert.match(rule, /overflow:\s*hidden/, `${selector} does not clip`);
    }
  });
});
