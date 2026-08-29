/**
 * THE SEARCH ENGINE'S OWN RULES — the half that is pure text, tested without a
 * database anywhere near it.
 *
 * Every case below is a search that FAILED on this shop's real catalogue
 * before this module existed. None of them are invented: they are what an
 * Egyptian shop actually types into a box.
 *
 * The tests are written against the PROPERTY, not the table. Asserting that
 * «أحمر» maps to a particular string would be a copy of the implementation and
 * would pass just as happily if every word mapped to the same thing. So what
 * is asserted is that the spellings of one word AGREE with each other, and —
 * the control that makes that mean anything — that different words still
 * DISAGREE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  searchKey, searchTokens, indexText, indexBones,
  swapToArabic, swapToLatin, skeleton, editDistance, editBudget,
  candidates, scoreField, scoreFuzzy,
} from '../public/shared/searchText.js';

/* ═════════════════════════════════════════════ 1. one word, many spellings ══ */

test('the hamza a shop owner does not type still finds the product', () => {
  /*
   * أ إ آ ٱ are all typed as bare ا by anybody moving quickly, and Windows'
   * Arabic keyboard puts the plain alif under the easy key. A shop whose
   * product is «أحمر» must be findable by «احمر».
   */
  const spellings = ['أحمر', 'احمر', 'آحمر', 'إحمر', 'أَحْمَر', 'احــمر', 'ٱحمر'];
  const keys = new Set(spellings.map(searchKey));
  assert.equal(keys.size, 1, `one word, ${keys.size} keys: ${[...keys].join(' / ')}`);
});

test('ة/ه and ى/ي are the same letter to somebody searching', () => {
  assert.equal(searchKey('ساعة'), searchKey('ساعه'));
  assert.equal(searchKey('ليلى'), searchKey('ليلي'));
  assert.equal(searchKey('مؤمن'), searchKey('مومن'));
});

test('different Arabic words still have different keys — the control', () => {
  /*
   * Without this, "every spelling agrees" would be satisfied perfectly by a
   * function that returned the empty string for everything.
   */
  const words = ['احمر', 'اخضر', 'ساعه', 'شنطه', 'عطر', 'مسك'];
  assert.equal(new Set(words.map(searchKey)).size, words.length);
});

test('a code survives however its separators were typed', () => {
  const spellings = ['LX-08', 'lx 08', 'LX08', 'lx_08', 'Lx.08'];
  assert.equal(new Set(spellings.map(searchKey)).size, 1);
  // …and is still not the same as a different code.
  assert.notEqual(searchKey('LX08'), searchKey('LX09'));
});

test('a barcode typed on an Arabic phone keypad is the same barcode', () => {
  // ٠-٩ and ۰-۹ reach a form field from every Arabic-locale phone.
  assert.equal(searchKey('٦٢٢١٠٠٠٠٠٠٠١٥'), '6221000000015');
  assert.equal(searchKey('۶۲۲۱'), '6221');
});

test('invisible direction marks in pasted text do not break a search', () => {
  /*
   * These arrive from Word, from WhatsApp and from any right-to-left document.
   * A search that fails because of a character nobody can see is a search
   * nobody can fix by looking at it.
   */
  assert.equal(searchKey('‏توباكو‎'), searchKey('توباكو'));
  assert.equal(searchKey('‫فانيل‬'), searchKey('فانيل'));
});

/* ═══════════════════════════════ 2. the keyboard was on the other language ══ */

test('both keyboard layouts round-trip exactly', () => {
  /*
   * The property that makes the whole tier trustworthy: swapping and swapping
   * back is the identity. It is also what caught a real bug — «لا» sits on one
   * key but is TWO code points, and written as a parallel string it shifted
   * every key after `b` on the bottom row, so `chanel` came back as `chamel`.
   */
  for (const word of ['chanel', 'tobacco', 'dior', 'oud', 'perfume', 'zxcvbnm']) {
    assert.equal(swapToLatin(swapToArabic(word)), word, `${word} did not survive the round trip`);
  }
  for (const word of ['عطر', 'مسك', 'شانيل', 'ديور']) {
    assert.equal(swapToArabic(swapToLatin(word)), word, `${word} did not survive the round trip`);
  }
});

test('«عطر» typed with the keyboard on English is understood', () => {
  // The single most common failed search in an Egyptian shop.
  const typed = swapToLatin('عطر');
  assert.equal(typed, "u'v", 'the layout table has moved');
  const ladder = candidates(typed);
  assert.ok(ladder.some((c) => c.kind === 'layout' && c.key === 'عطر'),
    `"${typed}" was not read as «عطر»: ${JSON.stringify(ladder)}`);
});

test('a real word is NOT re-read as if the keyboard were wrong', () => {
  /*
   * The guard, and the bug it was written for.
   *
   * «عطر» is a real Arabic word. Read as keystrokes it is `u'v`, whose key is
   * `uv` — and `uv` is a substring of `sauvage`. Without the guard, searching a
   * perfume shop for the Arabic word "perfume" returned Sauvage Elixir and
   * nothing else: confident, specific, and wrong.
   *
   * The guard is that a swap must not LOSE letters. «عطر» is three letters and
   * `uv` is two, because ط sits on the apostrophe key. Text that really was
   * keystrokes does not lose anything.
   */
  assert.ok(!candidates('عطر').some((c) => c.kind === 'layout'),
    'a real Arabic word was re-read as Latin keystrokes');

  // And the control: text that IS wrong-keyboard input still gets its reading.
  const mistyped = swapToArabic('chanel');
  assert.ok(candidates(mistyped).some((c) => c.kind === 'layout' && c.key === 'chanel'),
    `"${mistyped}" should read back as chanel`);
});

test('a product CODE is never re-read as another language', () => {
  // `LX08` swaps to «مء08», and ء is dropped by the hamza folding — a letter
  // short, so the reading is refused. A code offered as a foreign word invites
  // a wrong row into a list somebody is about to click.
  assert.ok(!candidates('LX08').some((c) => c.kind === 'layout'));
});

/* ══════════════════════════════════════ 3. the same name, the other script ══ */

test('an English brand name reaches its Arabic spelling', () => {
  /*
   * Arabic is written consonantally, so a transliterated name keeps its
   * consonants and loses its vowels — and dropping the vowels from the Latin
   * spelling lands on the same few letters.
   */
  const pairs = [
    ['tobacco', 'توباكو'], ['chance', 'تشانس'], ['chanel', 'تشانيل'],
    ['musk', 'مسك'], ['vanille', 'فانيل'], ['dior', 'ديور'], ['sauvage', 'سوفاج'],
  ];
  for (const [latin, arabic] of pairs) {
    assert.equal(skeleton(latin), skeleton(arabic),
      `${latin} and ${arabic} do not reduce to the same shape`);
  }
});

test('different names still have different shapes — the control', () => {
  const names = ['tobacco', 'chanel', 'musk', 'vanille', 'sauvage'];
  assert.equal(new Set(names.map(skeleton)).size, names.length,
    'the skeletons collapse different names together, so the test above proves nothing');
});

test('a two-letter shape is a fragment, not a word, and is matched as a whole', () => {
  /*
   * «عطر» has the skeleton `tr`, which appears INSIDE `strngr` (stronger). As
   * a substring that made a perfume shop answer "perfume" with "Stronger With
   * You". The tier now demands a whole skeleton-word, which is carried on the
   * candidate as `wholeWord` and turned into a space-anchored LIKE.
   */
  const tier = candidates('عطر').find((c) => c.kind === 'skeleton');
  if (tier) assert.equal(tier.wholeWord, true, 'a skeleton is matched as a fragment');

  // `dior` and «ديور» are both the whole word `dr`, so they still find each
  // other under the same rule.
  assert.equal(skeleton('dior'), skeleton('ديور'));
});

/* ═══════════════════════════════════════════════════ 4. and if they mistyped ══ */

test('a transposition costs one edit, not two', () => {
  // Swapping two adjacent letters is what fast typing produces. Plain
  // Levenshtein charges two for it, which pushes a one-mistake word past every
  // sensible threshold.
  assert.equal(editDistance('sotck', 'stock'), 1);
  assert.equal(editDistance('porduct', 'product'), 1);
});

test('the edit budget refuses to guess at short words', () => {
  /*
   * At three letters, one edit reaches most of a catalogue. A suggestion list
   * that answers `oud` with forty products is worse than one that answers it
   * with four.
   */
  assert.equal(editBudget('oud'), 0);
  assert.equal(editBudget('musk'), 1);
  assert.equal(editBudget('tobacco'), 2);
  assert.equal(editBudget('mademoiselle'), 3);
});

test('a typo scores BELOW every real match, always', () => {
  /*
   * The property the whole ranking rests on. A scanned code must never come
   * second behind a close guess — the person at the till would put the wrong
   * bottle in the bag.
   */
  const exact = scoreField('lx08', 'lx08').score;
  const prefix = scoreField('toba', ' tobacco vanille ').score;
  const contains = scoreField('bacco', ' tobacco vanille ').score;
  const layout = scoreField('عطر', ' عطر شرقي ', { kind: 'layout' }).score;
  const typo = scoreFuzzy(['tabaco'], ['tobacco', 'vanille']).score;

  assert.ok(exact > prefix, 'a prefix outranks an exact match');
  assert.ok(prefix > contains, 'a substring outranks a prefix');
  assert.ok(contains > layout, 'a keyboard guess outranks a real substring match');
  assert.ok(layout > typo, 'a typo outranks a keyboard reading');
  assert.ok(typo > 0, 'a typo scores nothing at all, so the tier is dead');
});

test('a term of several words is only a typo if EVERY word is close', () => {
  /*
   * The bug this shape was written for. Keyed as one string, "Red Lipstick"
   * becomes `redlipstick`, which is three edits from `lipstick` and inside the
   * budget for an eleven-letter word — so a product renamed from "Red
   * Lipstick" to "Crimson Lipstick" went on being found by its old name for
   * ever.
   */
  const words = ['crimson', 'lipstick'];
  assert.equal(scoreFuzzy(['red', 'lipstick'], words).score, 0,
    '"red lipstick" still matches a product with no "red" in it');
  // The control: a genuine typo in one word of two still lands.
  assert.ok(scoreFuzzy(['crimsno', 'lipstick'], words).score > 0,
    'a real two-word typo no longer matches, so the rule is too strict');
});

test('a closer typo beats a further one', () => {
  const near = scoreFuzzy(['tobacc'], ['tobacco']).score;
  const far = scoreFuzzy(['tobaco'], ['tobacco']).score;
  assert.ok(near >= far);
});

/* ═════════════════════════════════════════════════ 5. the ladder's ordering ══ */

test('the readings come back best-first, and an exact one is always first', () => {
  /*
   * This ordering IS the design: a caller walks the list and stops at the first
   * reading that finds anything. A cheap reading that fired before a confident
   * one would not be a faster answer, it would be a wrong one.
   */
  for (const term of ['tobacco', 'LX08', 'عطر', "u'v", 'محفظة']) {
    const kinds = candidates(term).map((c) => c.kind);
    if (!kinds.length) continue;
    assert.equal(kinds[0], 'exact', `"${term}" does not try itself first`);
    const layoutAt = kinds.indexOf('layout');
    const skeletonAt = kinds.indexOf('skeleton');
    if (layoutAt >= 0 && skeletonAt >= 0) {
      assert.ok(layoutAt < skeletonAt, `"${term}" guesses the script before the keyboard`);
    }
  }
});

test('punctuation alone is not a search', () => {
  for (const term of ['', '   ', '%', '___', '!!!', '?']) {
    assert.deepEqual(candidates(term), [], `"${term}" produced a reading`);
  }
});

/* ═══════════════════════════════════════════ 6. what gets stored for a row ══ */

test('the stored text keeps words apart but joins a code back together', () => {
  /*
   * Both halves matter and they pull in opposite directions. Without the word
   * separation, «توباكو فانيل» becomes one word and a search for «كوفان» — a
   * fragment spanning the join, in neither word — would match. Without joining
   * inside a token, `LX-08` becomes two words and a person typing the code off
   * the label finds nothing.
   */
  assert.deepEqual(searchTokens('LX-08 Tobacco Vanille'), ['lx08', 'tobacco', 'vanille']);

  const text = indexText('LX-08', 'Tobacco Vanille', 'توباكو فانيل');
  assert.ok(text.includes(' lx08 '), 'the code was split');
  assert.ok(text.includes(' tobacco '), 'a word is not addressable');
  assert.ok(!text.includes('tobaccovanille'), 'the words ran together');
  assert.ok(text.startsWith(' ') && text.endsWith(' '),
    'without the outer spaces, a word-prefix match needs a special case for the first word');
});

test('the stored text de-duplicates, so a repeated word is stored once', () => {
  const text = indexText('Dior', 'Dior Sauvage', 'Dior');
  assert.equal(text.split(' ').filter((w) => w === 'dior').length, 1);
});

test('the skeleton column holds only what could be another script', () => {
  const bones = indexBones('Tobacco Vanille', 'توباكو فانيل');
  // One entry, because the two spellings reduce to the same shape — which is
  // the entire point of the column.
  assert.equal(bones.trim().split(' ').filter((b) => b === 'tbk').length, 1);
});
