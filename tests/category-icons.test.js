/**
 * The icon a category wears when the shop has not uploaded a picture.
 *
 * The owner's instruction had two halves — «ممكن تبقي صور ونضيف صور للفئات
 * وانت خلي الـdefault من عندك ايقونات لو الادمين مضفش صور» — and this is the
 * second one: the guess. A shop names its categories in Arabic, sometimes in
 * English, occasionally in both, and a match table is the kind of thing that
 * silently stops working the day somebody edits a word in it.
 *
 * What is asserted is not "this name gives this path" — that would be a copy
 * of the table, and would pass just as happily if every entry were the same
 * icon. It is that the RIGHT names agree with each other and DIFFER from the
 * others, which is the property that makes the feature worth having.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryIconPath } from '../public/shop/js/ui/placeholders.js';

const icon = (name_ar, name_en = '') => categoryIconPath({ name_ar, name_en });

/** The shapes a real shop's category list takes, grouped by what they mean. */
const FAMILIES = {
  perfume: [['عطور'], ['عطر رجالي'], ['البرفانات'], ['', 'Perfume'], ['', 'Fragrance'], ['', 'EDP']],
  wallet: [['محافظ'], ['محفظة جلد'], ['', 'Wallets'], ['', 'Purse']],
  watch: [['ساعات'], ['ساعة حريمي'], ['', 'Watches'], ['', 'Timepieces']],
  glasses: [['نظارات'], ['نظارة شمس'], ['', 'Sunglasses'], ['', 'Eyewear']],
  bag: [['شنط'], ['حقائب'], ['', 'Handbags'], ['', 'Clutch']],
  jewellery: [['اكسسوارات'], ['مجوهرات'], ['', 'Accessories'], ['', 'Necklaces']],
  care: [['بادي سبلاش'], ['كريمات'], ['', 'Body Splash'], ['', 'Lotion']],
};

test('every name for the same thing gets the same icon', () => {
  for (const [family, names] of Object.entries(FAMILIES)) {
    const paths = new Set(names.map(([ar, en]) => icon(ar, en)));
    assert.equal(paths.size, 1,
      `"${family}" is drawn ${paths.size} different ways: ${names.map(([a, e]) => a || e).join(', ')}`);
  }
});

test('different things get different icons', () => {
  /*
   * The control the test above cannot be trusted without. One icon for
   * everything would satisfy "all names agree" perfectly.
   */
  const byFamily = Object.fromEntries(
    Object.entries(FAMILIES).map(([family, names]) => [family, icon(...names[0])]),
  );
  const distinct = new Set(Object.values(byFamily));
  assert.equal(distinct.size, Object.keys(FAMILIES).length,
    `${Object.keys(FAMILIES).length} kinds of category share ${distinct.size} icons`);
});

test('a category nothing matches still gets something to draw', () => {
  /*
   * The case that must never be an empty frame: a shop selling something this
   * table has never heard of. It gets the neutral tag, and — the part that
   * matters — it is not the same as any real match, so a mystery category
   * cannot be mistaken for perfume.
   */
  const unknown = icon('حاجة غريبة خالص', 'Something Else Entirely');
  assert.ok(unknown && unknown.length > 10, 'an unmatched category has no icon at all');
  for (const [family, names] of Object.entries(FAMILIES)) {
    assert.notEqual(unknown, icon(...names[0]), `an unknown category is being drawn as ${family}`);
  }
});

test('the match reads BOTH names, so one language is enough', () => {
  // An Arabic shop that also typed an English name, and the reverse.
  assert.equal(icon('عطور', 'Perfume'), icon('', 'Perfume'));
  assert.equal(icon('عطور', ''), icon('عطور', 'Perfume'));
  // And case never matters — a shop types "WALLETS" as often as "Wallets".
  assert.equal(icon('', 'WALLETS'), icon('', 'wallets'));
});

test('a substring match finds the word inside a real category name', () => {
  /*
   * Shops do not name a category "Perfume". They name it «عطور رجالي أوتليت»
   * or "Men's Perfumes — Outlet", which is why the table matches substrings
   * rather than whole names.
   */
  assert.equal(icon('عطور رجالي أوتليت'), icon('عطور'));
  assert.equal(icon('', "Men's Perfumes — Outlet"), icon('', 'Perfume'));
  assert.equal(icon('محافظ جلد طبيعي'), icon('محافظ'));
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SAME VOCABULARY, READ OFF A PRODUCT.

   A bare product card used to draw a perfume bottle — every product, every
   shop, because the shop this was built for sells perfume. On the platform's
   second customer that stopped being "no picture yet" and became a picture of
   the wrong thing: a wallet shop with a bottle on every card it had not
   photographed.
   ═══════════════════════════════════════════════════════════════════════════ */

test('a bare product is drawn as what it IS, not as a bottle', async () => {
  const { productIconPath, categoryIconPath } = await import('../public/shop/js/ui/placeholders.js');

  /*
   * Named against the category that means the same thing, rather than against
   * a copy of the path table. That is the property worth holding: a shelf tile
   * and a bare card that both mean "wallets" draw the same shape, so a page
   * with several of each reads as one design. It also means a word added to
   * the vocabulary for a category reaches the product cards on the same
   * commit, by construction rather than by somebody remembering.
   */
  const pairs = [
    ['محفظة جلد بني', 'محافظ'],
    ['Very Sexy Body Mist', 'Body Splash'],
    ['سلسلة فضة', 'مجوهرات'],
    ['Aviator Sunglasses', 'Sunglasses'],
    ['ساعة يد رجالي', 'ساعات'],
    ['Chanel No 5 EDP', 'Perfume'],
  ];
  for (const [productName, categoryName] of pairs) {
    assert.equal(
      productIconPath(productName),
      categoryIconPath({ name_ar: categoryName, name_en: categoryName }),
      `"${productName}" is not drawn the same way as the shelf it belongs on`,
    );
  }

  // The control: these are not all one icon.
  assert.ok(new Set(pairs.map(([name]) => productIconPath(name))).size >= 5,
    'every product is drawn the same way, so the match above proves nothing');
});

test('a product whose name means nothing gets the neutral mark, not a guess', async () => {
  const { productIconPath, categoryIconPath } = await import('../public/shop/js/ui/placeholders.js');
  const neutral = categoryIconPath({ name_ar: 'حاجات تانية', name_en: 'Miscellaneous' });
  for (const name of ['Item 4021', 'صنف جديد', '', null, undefined]) {
    assert.equal(productIconPath(name), neutral,
      `"${name}" was guessed at instead of drawn neutrally`);
  }
  // And the neutral mark is not a bottle — a shop that sells no perfume should
  // never see one. Asserted against perfume specifically, because that is the
  // shape this used to draw for absolutely everything.
  assert.notEqual(neutral, categoryIconPath({ name_ar: 'عطور', name_en: 'Perfume' }));
});
