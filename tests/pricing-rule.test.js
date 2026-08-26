/**
 * The offer rule, on its own — `src/shared/pricing.js`.
 *
 * ── Why this file is first ──────────────────────────────────────────────────
 * Because every other surface delegates to it. The storefront card, the product
 * page, the online order, the till and the exported workbook all call
 * `offerPrice()`, so a mistake here is not a mistake on one screen: it is the
 * shop charging the wrong amount everywhere at once, consistently, which is the
 * hardest kind of wrong to notice.
 *
 * The cases below are the ones that decide money: what a percent does to an
 * awkward number, what happens when somebody types 150 into a percent box, when
 * an offer starts and when it stops, and the rounding case where a discount is
 * real in arithmetic and worth nothing in piastres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  offerPrice, offerRunning, suggestGender, GENDERS, isGender, today,
} = await import('../src/shared/pricing.js');

const percent = (value, extra = {}) => ({ discount_type: 'percent', discount_value: value, ...extra });
const amount = (value, extra = {}) => ({ discount_type: 'amount', discount_value: value, ...extra });

test('a percent comes off the price, rounded like money', () => {
  assert.equal(offerPrice(1000, percent(20)).price, 800);
  assert.equal(offerPrice(3200, percent(15)).price, 2720);

  // 33.333...% of 99.99 is 33.3266...; money is two decimals and the discount is
  // rounded before it is subtracted, never after, so the price is a price.
  const awkward = offerPrice(99.99, percent(33.333));
  assert.equal(awkward.price, 66.66);
  assert.equal(awkward.saved, 33.33);
  assert.equal(Math.round(awkward.price * 100) / 100, awkward.price, 'never more than two decimals');
});

test('an amount comes off the price, and can never take it below zero', () => {
  assert.equal(offerPrice(1000, amount(150)).price, 850);
  // More off than the piece costs: free, not negative. A negative price would
  // flow into revenue, tax and profit and poison every report it touched.
  const overshoot = offerPrice(200, amount(500));
  assert.equal(overshoot.price, 0);
  assert.equal(overshoot.saved, 200);
  assert.equal(overshoot.percent, 100);
});

test('a percent over 100 is a typo, and is clamped rather than obeyed', () => {
  assert.equal(offerPrice(1000, percent(150)).price, 0, '150% off is 100% off, never a refund');
  assert.equal(offerPrice(1000, percent(-20)).onSale, false, 'a negative rate is not an offer');
});

test('an offer that saves nothing is not an offer', async (ctx) => {
  await ctx.test('a zero rate', () => {
    assert.equal(offerPrice(1000, percent(0)).onSale, false);
    assert.equal(offerPrice(1000, amount(0)).onSale, false);
  });

  await ctx.test('and a rate so small that rounding eats it whole', () => {
    // 0.001% of 10 is a hundredth of a piastre. Rounded, nothing comes off —
    // so no badge, no struck-through price, and no "خصم ٠٪" sticker.
    const dust = offerPrice(10, percent(0.001));
    assert.equal(dust.onSale, false);
    assert.equal(dust.price, 10);
    assert.equal(dust.listPrice, 10);
  });

  await ctx.test('a product with no price is not on offer either', () => {
    assert.equal(offerPrice(0, percent(50)).onSale, false);
  });
});

test('the dates decide, inclusively at both ends', async (ctx) => {
  const window = percent(10, { discount_starts_on: '2026-09-01', discount_ends_on: '2026-09-30' });

  await ctx.test('before it starts, nothing happens', () => {
    assert.equal(offerRunning(window, '2026-08-31'), false);
    assert.equal(offerPrice(1000, window, '2026-08-31').price, 1000);
  });

  await ctx.test('the first day counts', () => {
    assert.equal(offerRunning(window, '2026-09-01'), true);
    assert.equal(offerPrice(1000, window, '2026-09-01').price, 900);
  });

  await ctx.test('and so does the last — a shop that says "until the 30th" means the 30th', () => {
    assert.equal(offerRunning(window, '2026-09-30'), true);
    assert.equal(offerPrice(1000, window, '2026-09-30').price, 900);
  });

  await ctx.test('the day after, it is over, with no cleanup needed', () => {
    assert.equal(offerRunning(window, '2026-10-01'), false);
    assert.equal(offerPrice(1000, window, '2026-10-01').price, 1000);
  });

  await ctx.test('an open-ended offer runs until somebody stops it', () => {
    const forever = percent(10);
    assert.equal(offerRunning(forever, '2020-01-01'), true);
    assert.equal(offerRunning(forever, '2099-01-01'), true);
  });

  await ctx.test('a start with no end starts and stays', () => {
    const fromSeptember = percent(10, { discount_starts_on: '2026-09-01' });
    assert.equal(offerRunning(fromSeptember, '2026-08-31'), false);
    assert.equal(offerRunning(fromSeptember, '2030-01-01'), true);
  });

  await ctx.test('today, with nothing passed in, is a real day', () => {
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

test('what is reported back is enough to draw the whole thing', () => {
  const result = offerPrice(1000, percent(25));
  assert.deepEqual(result, {
    price: 750, listPrice: 1000, saved: 250, percent: 25, onSale: true,
  });

  // And a product with no offer answers with the same shape, so a caller can
  // print both numbers without a branch.
  const plain = offerPrice(1000, { discount_type: 'none' });
  assert.equal(plain.price, plain.listPrice);
  assert.equal(plain.onSale, false);
});

// ===========================================================================

test('the gender guess reads a perfume counter, in three languages', async (ctx) => {
  await ctx.test('English, as it is printed on the bottle', () => {
    assert.equal(suggestGender('212 Sexy Men'), 'men');
    assert.equal(suggestGender('Valentino Donna for Women'), 'women');
    assert.equal(suggestGender('CK One Unisex'), 'unisex');
  });

  await ctx.test('French, which half this shelf is in', () => {
    assert.equal(suggestGender('Dior Sauvage Pour Homme'), 'men');
    assert.equal(suggestGender('La Vie Est Belle Femme'), 'women');
  });

  await ctx.test('and Arabic, which is what the shop actually types', () => {
    assert.equal(suggestGender('عطر رجالي فاخر'), 'men');
    assert.equal(suggestGender('برفيوم حريمي'), 'women');
    assert.equal(suggestGender('عود للجنسين'), 'unisex');
  });

  await ctx.test('punctuation and case are not signals', () => {
    assert.equal(suggestGender('212-SEXY-MEN!'), 'men');
    assert.equal(suggestGender('  pour   FEMME  '), 'women');
  });

  await ctx.test('a name that says nothing gets no answer — not a guess', () => {
    assert.equal(suggestGender('Valentino Uomo Intense'), 'men', 'uomo is a signal');
    assert.equal(suggestGender('Bleu Encre 50ml'), null);
    assert.equal(suggestGender(''), null);
    assert.equal(suggestGender(null), null);
  });

  await ctx.test('a name with both markers is refused rather than decided', () => {
    // A gift set with his and hers in it. Two signals is not more information,
    // it is a question for a person.
    assert.equal(suggestGender('Gift Set for Men and Women'), null);
    assert.equal(suggestGender('طقم رجالي و حريمي'), null);
  });

  await ctx.test('a substring is not a word', () => {
    // The failure this whole matcher is shaped around: "menthe" contains "men",
    // and a shop full of mint fragrances filed as menswear is how a filter
    // stops being trusted.
    assert.equal(suggestGender('Eau de Menthe'), null);
    assert.equal(suggestGender('Womanhood'), null, 'and neither is a longer word containing one');
  });

  await ctx.test('unisex wins outright when a name claims it', () => {
    assert.equal(suggestGender('Unisex Oud for Men'), 'unisex');
  });
});

test('the three genders are the three the database allows', () => {
  assert.deepEqual(GENDERS, ['women', 'men', 'unisex']);
  assert.equal(isGender('women'), true);
  assert.equal(isGender('other'), false);
  assert.equal(isGender(''), false);
  assert.equal(isGender(null), false);
});
