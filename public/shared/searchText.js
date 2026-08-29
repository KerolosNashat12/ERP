/**
 * WHAT A PERSON TYPED, AND WHAT THEY MEANT.
 *
 * One module, imported by the server and by both browsers, so that the rule
 * deciding a match is the same rule the suggestion list was ranked by. Two
 * copies of a search rule diverge within a month and the symptom is a shop
 * owner saying "it suggested it and then found nothing".
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * The old rule was `LIKE '%term%'` over six columns. That is exactly right for
 * a scanned barcode and exactly wrong for a person, because a person types:
 *
 *   · `tobacco` at a product stored only as «توباكو»
 *   · «أحمر» at a product stored as «احمر» — same word, different hamza
 *   · «تشانس» at «شانس», «ساعه» at «ساعة», «ليلى» at «ليلي»
 *   · `u'v` — which is «عطر» typed with the keyboard still on English, and
 *     is the single most common failed search in an Egyptian shop
 *   · `tabaco`, `chanle`, `اومو` — a typo, at speed, at a counter
 *   · `١٢٣` — Arabic-Indic digits, straight off a phone keyboard
 *
 * None of those are unusual and none of them matched anything.
 *
 * ── The shape of the answer ─────────────────────────────────────────────────
 * Text is reduced to a KEY: one lowercase, unaccented, hamza-flattened,
 * Western-digit string with the separators removed. The key is computed when a
 * product is saved and stored beside it, because SQL cannot run JavaScript —
 * and the term a person types is put through the identical function before it
 * is compared. Same function, both ends, or the stored key drifts from the
 * query and nothing matches.
 *
 * Everything above a plain substring match is then a LADDER of readings of the
 * term — the term itself, the term with the keyboard layout swapped, the term
 * as a consonant skeleton — tried in order of how confident each one is. That
 * order is the whole design: `candidates()` returns them best-first, and a
 * caller stops at the first that finds anything. A cheap reading that fires
 * before an exact one is not a feature, it is a wrong answer arriving faster.
 */

/* ═══════════════════════════════════════ 1. reducing text to a search key ══ */

/**
 * Marks that carry sound but not identity: fatha, damma, kasra, sukun, shadda,
 * tanween, the dagger alif, and the Quranic marks above them. A shop owner
 * types «عِطر» or «عطر» depending on nothing at all, and they are one word.
 */
const TASHKEEL = /[ً-ْٓ-ٰٕۖ-ۭ]/g;

/** ـــ, the stretching character. Decorative; never part of a word. */
const TATWEEL = /ـ/g;

/**
 * Letters that are the same letter as far as a person searching is concerned.
 *
 * The hamza carriers are the important half: أ إ آ ٱ are all written ا by
 * roughly everybody typing quickly, and Windows' Arabic keyboard makes the
 * plain alif the easy one to reach. ة/ه and ى/ي are the other two everybody
 * gets "wrong" — «ساعه» and «ساعة» are the same word and «ليلى» and «ليلي»
 * are the same name.
 */
const ARABIC_FOLD = new Map(Object.entries({
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا',
  'ة': 'ه',
  'ى': 'ي', 'ئ': 'ي', 'ی': 'ي',
  'ؤ': 'و',
  'ء': '',
  // Persian/Urdu letters that reach an Arabic field through a paste.
  'ک': 'ك', 'گ': 'ك', 'پ': 'ب', 'چ': 'ج', 'ژ': 'ز', 'ڤ': 'ف', 'ﭬ': 'ف',
}));

/** ٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹ are 0123456789. A barcode typed on a phone. */
const digitFold = (ch) => {
  const code = ch.codePointAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06F0 && code <= 0x06F9) return String(code - 0x06F0);
  return ch;
};

/**
 * Direction and formatting marks. Invisible, and they arrive in pasted text
 * from Word, from WhatsApp and from any right-to-left document — a search that
 * fails because of a character nobody can see is unfixable by the person
 * looking at it.
 */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * The key: what two strings are compared as.
 *
 * Separators go entirely, so `LX-08`, `LX 08` and `lx08` are one key and a
 * person reading a code off a label does not have to reproduce its
 * punctuation. That is safe here because the key is only ever compared with
 * another key made the same way.
 */
export function searchKey(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKD')                      // é → e + combining accent
    .replace(/[̀-ͯ]/g, '')        // …and the accent goes
    .replace(INVISIBLE, '')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .split('')
    .map((ch) => ARABIC_FOLD.get(ch) ?? digitFold(ch))
    .join('')
    .toLowerCase()
    // Everything that is not a letter or a digit. `\p{L}` keeps Arabic,
    // which is the entire reason this is a Unicode property escape and not
    // `[a-z0-9]`.
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The same reduction, but keeping single spaces between words.
 *
 * Used for the stored key, where the words of a product's two names, its code,
 * its SKUs and its barcodes are joined — without the spaces, the end of one
 * name and the start of the next would form a word that is in neither.
 */
export function searchKeyWords(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(INVISIBLE, '')
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .split('')
    .map((ch) => ARABIC_FOLD.get(ch) ?? digitFold(ch))
    .join('')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The pieces of a phrase, each reduced to its own key.
 *
 * Why not just `searchKey` the whole phrase: that removes the spaces too, and
 * «توباكو فانيل» would become one word `توباكوفانيل`. A search for «فانيل»
 * would still find it by substring — but so would a search for «كوفان», which
 * is a fragment spanning the join and is in neither word.
 *
 * Why not `searchKeyWords`: that keeps the spaces but ALSO turns the hyphen
 * inside `LX-08` into one, so the code becomes two words `lx` and `08` and a
 * person typing the code off the label finds nothing.
 *
 * So: split on whitespace, key each piece — separators vanish inside a token
 * and survive between them. `LX-08 Tobacco Vanille` → `['lx08','tobacco','vanille']`.
 */
export function searchTokens(value) {
  return String(value ?? '')
    .split(/\s+/)
    .map((piece) => searchKey(piece))
    .filter(Boolean);
}

/**
 * Everything known about one thing, as the single string its row is searched
 * through. Leading and trailing spaces are deliberate: they let a caller ask
 * "does any WORD start with this" as a plain `LIKE '% term%'`, with no special
 * case for the first word.
 */
export const indexText = (...parts) => {
  const tokens = parts.flatMap((part) => searchTokens(part));
  return tokens.length ? ` ${[...new Set(tokens)].join(' ')} ` : '';
};

/** The same, as consonant skeletons — the cross-script column. */
export const indexBones = (...parts) => {
  const bones = parts
    .flatMap((part) => String(part ?? '').split(/\s+/))
    .map((piece) => skeleton(piece))
    .filter((piece) => piece.length >= 2);
  return bones.length ? ` ${[...new Set(bones)].join(' ')} ` : '';
};

/* ══════════════════════════════ 2. the keyboard was on the wrong language ══ */

/**
 * The Windows Arabic (101) layout, which is what every shop PC in Egypt has.
 *
 * A person types «عطر» without looking, the keyboard is still on English, and
 * the box fills with `u'v`. They see nonsense, delete it, switch language and
 * type again — or, more often, conclude the search is broken. The reverse
 * happens just as much: typing `chance` with the keyboard on Arabic gives
 * «زhؤkءث»-looking output.
 *
 * Both directions are built from this one table, so they cannot disagree.
 */
/*
 * The letters are an ARRAY per row, not a string, and that is not styling.
 *
 * The `b` key carries «لا» — one key, two code points. Written as a string and
 * walked character by character, that one key eats two positions and every key
 * after it on the row is silently off by one: `n` became «ا» instead of «ى»,
 * `m` became «ى» instead of «ة», and a name typed on the wrong keyboard came
 * back one letter wrong with nothing to show why. The length check below would
 * now catch it; the array is what stops it happening.
 */
const EN_TO_AR_ROWS = [
  ['qwertyuiop[]', ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج', 'د']],
  ["asdfghjkl;'", ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط']],
  ['zxcvbnm,./', ['ئ', 'ء', 'ؤ', 'ر', 'لا', 'ى', 'ة', 'و', 'ز', 'ظ']],
];

const EN_TO_AR = new Map();
const AR_TO_EN = new Map();
for (const [latin, letters] of EN_TO_AR_ROWS) {
  /*
   * A row whose two halves disagree is a typo in the table above, and it fails
   * LOUDLY at import rather than quietly mapping half a keyboard. This is the
   * check that would have caught the «لا» shift the moment it was written.
   */
  if (latin.length !== letters.length) {
    throw new Error(`keyboard row "${latin}" has ${latin.length} keys and ${letters.length} letters`);
  }
  for (let i = 0; i < latin.length; i += 1) {
    EN_TO_AR.set(latin[i], letters[i]);
    // First writer wins: «لا» maps back to `b`, and the standalone «ا» already
    // came from `h`. A later row must not steal an earlier key.
    if (!AR_TO_EN.has(letters[i])) AR_TO_EN.set(letters[i], latin[i]);
  }
}

/** `u'v` → «عطر». Characters with no key on the layout are left alone. */
export const swapToArabic = (term) => String(term ?? '')
  .split('')
  .map((ch) => EN_TO_AR.get(ch.toLowerCase()) ?? ch)
  .join('');

/**
 * Arabic sequences that are ONE key, longest first. Only «لا» today — the `b`
 * key — but the shape is a list because a layout is a table, not a special case.
 */
const AR_MULTI = [...AR_TO_EN.keys()]
  .filter((letters) => letters.length > 1)
  .sort((a, b) => b.length - a.length);

/**
 * «عطر» → `u'v`. The mirror, for a keyboard left on Arabic.
 *
 * The multi-character keys have to be tried BEFORE the single ones or the
 * swap is not reversible: «لا» is one keystroke (`b`), and read letter by
 * letter it comes back as «ل»+«ا» = `gh`, so `tobacco` swapped and swapped
 * back returned `toghacco`. The round-trip test is what caught that.
 *
 * Reading a genuine Arabic «لا» as `b` is not a risk: that only happens for
 * text being examined AS keystrokes, and `candidates()` throws away any
 * reading that loses letters — which a real Arabic word containing «لا»
 * always does.
 */
export const swapToLatin = (term) => {
  const text = String(term ?? '');
  let out = '';
  for (let i = 0; i < text.length;) {
    const multi = AR_MULTI.find((letters) => text.startsWith(letters, i));
    if (multi) { out += AR_TO_EN.get(multi); i += multi.length; continue; }
    out += AR_TO_EN.get(text[i]) ?? text[i];
    i += 1;
  }
  return out;
};

/** Does this string contain Arabic letters? Decides which swap is worth trying. */
export const hasArabic = (value) => /[؀-ۿ]/.test(String(value ?? ''));

/** Does it contain Latin letters? */
export const hasLatin = (value) => /[a-z]/i.test(String(value ?? ''));

/* ══════════════════════════════════ 3. the same word in the other script ══ */

/**
 * A CONSONANT SKELETON — the cheapest thing that lets `tobacco` find «توباكو».
 *
 * Arabic is written consonantally: the vowels a reader supplies are not on the
 * page. So a brand name transliterated into Arabic keeps its consonants and
 * loses its vowels, and the reverse reading — dropping the vowels from the
 * Latin spelling — lands on the same few letters:
 *
 *     tobacco  → t b c c  → tbk      (c reads as k, doubles collapse)
 *     توباكو    → ت ب ك    → tbk      (و and ا are the vowels, dropped)
 *
 * WHAT THIS IS NOT: a transliteration scheme. It cannot spell a word back, it
 * throws away distinctions Arabic makes (س and ص are both `s`), and it will
 * occasionally collide — `bag` and `big` are both `bg`. That is acceptable
 * ONLY because of where it sits: `candidates()` returns it LAST, so a skeleton
 * match is what a search falls back to when every more confident reading has
 * already found nothing. A collision then shows a person one extra row; the
 * alternative is showing them an empty list.
 */
const ARABIC_CONSONANT = new Map(Object.entries({
  'ب': 'b', 'ت': 't', 'ث': 't', 'ج': 'j', 'ح': 'h', 'خ': 'k',
  'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 's',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': '', 'غ': 'g',
  'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'و': '', 'ي': '', 'ا': '',
}));

/** Latin digraphs that are ONE Arabic letter, so they must be read as one. */
const LATIN_DIGRAPHS = [
  ['sh', 's'], ['ch', 's'], ['th', 't'], ['ph', 'f'], ['gh', 'g'],
  ['kh', 'k'], ['ck', 'k'], ['qu', 'k'],
];

/**
 * Arabic digraphs — the same idea in the other direction. Arabic has no letter
 * for /tʃ/, so a name with `ch` in it is written «تش»: Chance is «تشانس»,
 * Chanel is «تشانيل». Read as two letters that is `t` then `s`, which matches
 * nothing, and it is the single reason `chance` did not find «تشانس» on the
 * first cut of this file.
 */
const ARABIC_DIGRAPHS = [['تش', 's']];

const LATIN_CONSONANT = new Map(Object.entries({
  b: 'b', c: 'k', d: 'd', f: 'f', g: 'j', h: 'h', j: 'j', k: 'k',
  l: 'l', m: 'm', n: 'n', p: 'b', q: 'k', r: 'r', s: 's', t: 't',
  v: 'f', x: 'ks', z: 'z',
  // The vowels and the semi-vowels, dropped: they are exactly what the two
  // scripts disagree about.
  a: '', e: '', i: '', o: '', u: '', w: '', y: '',
}));

/**
 * The skeleton of a key, in either script. Digits survive unchanged — a code
 * is not a word and must not be vowel-stripped into a different code.
 */
export function skeleton(value) {
  const key = searchKey(value);
  if (!key) return '';
  let out = '';
  for (let i = 0; i < key.length;) {
    const pair = key.slice(i, i + 2);
    const digraph = LATIN_DIGRAPHS.find(([from]) => from === pair)
      || ARABIC_DIGRAPHS.find(([from]) => from === pair);
    if (digraph) { out += digraph[1]; i += 2; continue; }
    const ch = key[i];
    if (ch >= '0' && ch <= '9') { out += ch; i += 1; continue; }
    /*
     * `c` is /k/ in `cat` and /s/ in `chance`, and the difference is the next
     * letter. Arabic spells the two with different letters (ك and س), so
     * collapsing both to `k` here makes `chance` unreachable from «تشانس».
     */
    if (ch === 'c') {
      const next = key[i + 1];
      out += (next === 'e' || next === 'i' || next === 'y') ? 's' : 'k';
      i += 1;
      continue;
    }
    out += ARABIC_CONSONANT.get(ch) ?? LATIN_CONSONANT.get(ch) ?? ch;
    i += 1;
  }
  // Doubled letters are a spelling choice, not a sound: `tobacco` and «توباكو»
  // must not differ by one `k`.
  return out.replace(/(.)\1+/g, '$1');
}

/* ═══════════════════════════════════════════════ 4. and if they mistyped ══ */

/**
 * Damerau-Levenshtein — insert, delete, substitute, and TRANSPOSE.
 *
 * The transposition is not a nicety. `sotck`, `porduct`, «العطر» typed as
 * «العرط» — swapping two adjacent letters is what fast typing produces, and
 * plain Levenshtein charges two edits for it, which pushes a one-mistake word
 * past every sensible threshold.
 *
 * Bounded: it stops as soon as an entire row exceeds `max`, so comparing a
 * term against a few hundred products costs almost nothing. Returns
 * `max + 1` for "further away than you cared about".
 */
export function editDistance(a, b, max = 3) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  if (!s.length) return t.length > max ? max + 1 : t.length;
  if (!t.length) return s.length > max ? max + 1 : s.length;

  let prev2 = null;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const row = new Array(t.length + 1);
    row[0] = i;
    let best = row[0];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let value = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[t.length] > max ? max + 1 : prev[t.length];
}

/**
 * How wrong a word of this length is allowed to be.
 *
 * Fixed at one edit for short words on purpose: at three letters, two edits
 * reaches most of the catalogue, and a suggestion list that answers `oud` with
 * forty products is worse than one that answers it with four.
 */
export const editBudget = (term) => {
  const n = String(term ?? '').length;
  if (n <= 3) return 0;
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  return 3;
};

/* ═════════════════════════════════════════════════ 5. the ladder of tries ══ */

/**
 * Every reading of what a person typed, BEST FIRST.
 *
 * The order is the design. A caller walks this list and stops at the first
 * reading that finds anything, so a term that is genuinely a product code is
 * never answered by a skeleton match that happened to be cheaper to compute.
 *
 *   1. `exact`     — the key itself. What they typed, cleaned up.
 *   2. `layout`    — the same keystrokes with the keyboard on the other
 *                    language. Only offered when the raw term is entirely in
 *                    the "wrong" script for what it would become, so a real
 *                    Arabic word is never re-read as Latin gibberish.
 *   3. `skeleton`  — the consonants, for the same name written in the other
 *                    script. Only when the term is long enough for its
 *                    skeleton to mean anything.
 *
 * Each entry carries `kind`, so a result can say WHY it matched — which is
 * what lets the suggestion list tell a person "you had the keyboard on
 * English" instead of silently showing them something they did not type.
 */
/** How many letters (not digits) a key carries. See the layout guard below. */
const letters = (key) => (String(key).match(/\p{L}/gu) || []).length;

export function candidates(term) {
  const raw = String(term ?? '').trim();
  const key = searchKey(raw);
  const out = [];
  /*
   * TOKENS, not one key — because a person types more than one word.
   *
   * `searchKey('tobacco vanille')` is `tobaccovanille`, which appears in no
   * stored row: the index deliberately keeps words apart so that a fragment
   * spanning two of them cannot match. So a term of several words is several
   * keys, and a row has to carry ALL of them. Without this, typing a product's
   * full name — the most natural thing anybody does with a search box —
   * returned nothing at all.
   *
   * A single-word term produces a single-element list, so nothing else in this
   * file has to know the difference.
   */
  if (key) out.push({ kind: 'exact', key, tokens: searchTokens(raw), term: raw });

  if (key) {
    /*
     * `u'v` → «عطر»: only worth trying when nothing they typed was Arabic, and
     * only when the swap KEPT every letter.
     *
     * That second condition is what stops `LX08` being re-read as «م08»: `x`
     * lands on ء, which the hamza folding above removes, so the swap comes back
     * a letter short. A swap that loses letters was not a word typed on the
     * wrong keyboard — it was a product code, and offering a reading of it
     * invites a wrong row into a list a person is about to click.
     */
    if (!hasArabic(raw) && hasLatin(raw)) {
      const swapped = searchKey(swapToArabic(raw));
      if (swapped && swapped !== key && hasArabic(swapped) && letters(swapped) >= letters(key)) {
        out.push({
          kind: 'layout', key: swapped, tokens: searchTokens(swapToArabic(raw)), term: swapToArabic(raw),
        });
      }
    }
    /*
     * …and the mirror, for a keyboard left on Arabic — under the SAME
     * letter-preserving guard, which is not symmetry for its own sake.
     *
     * «عطر» is a real Arabic word. Read as keystrokes it is `u'v`, whose key is
     * `uv`, and `uv` is a substring of `sauvage` — so without this guard,
     * searching for the Arabic word for "perfume" in a shop that sells perfume
     * returned Sauvage Elixir and nothing else. A wrong answer, arrived at
     * confidently.
     *
     * The guard catches it because «عطر» is three letters and `uv` is two: ط
     * sits on the apostrophe key, which is punctuation and does not survive
     * into a key. Real wrong-keyboard input does survive — «ؤاشىثم» is six
     * letters and reads back as `chanel`, also six — because every letter of it
     * came from a letter key in the first place. Losing letters is the
     * signature of text that was never keystrokes.
     */
    if (hasArabic(raw) && !hasLatin(raw)) {
      const swapped = searchKey(swapToLatin(raw));
      if (swapped && swapped !== key && hasLatin(swapped) && letters(swapped) >= letters(key)) {
        out.push({
          kind: 'layout', key: swapped, tokens: searchTokens(swapToLatin(raw)), term: swapToLatin(raw),
        });
      }
    }
  }

  /*
   * Three characters is the floor. Below it a skeleton is one or two
   * consonants and matches most of a catalogue — which is not a search
   * result, it is a list.
   */
  const bones = key.length >= 3 ? skeleton(raw) : '';
  if (bones && bones.length >= 2) {
    /*
     * `wholeWord` is what keeps this tier honest, and it was added because the
     * tier without it was actively wrong.
     *
     * «عطر» — the Arabic word for perfume — has the skeleton `tr`. As a
     * SUBSTRING that appears inside `strngr` (stronger), so searching a perfume
     * shop for "perfume" returned "Stronger With You" and nothing else: a
     * confident, specific, wrong answer. Two consonants are not a word, they
     * are a fragment of one.
     *
     * So a skeleton has to match a whole skeleton-word. `dior`/«ديور» both
     * reduce to `dr` and still find each other, because `dr` IS the whole word
     * on both sides — while `tr` inside `strngr` is not, and the search
     * correctly returns nothing rather than something.
     */
    out.push({
      kind: 'skeleton',
      key: bones,
      // Per WORD, so «توم فورد» and `tom ford` still meet each other. A word
      // whose skeleton is a single consonant is dropped: it would match most
      // of a catalogue and contributes nothing to an AND.
      tokens: raw.split(/\s+/).map((word) => skeleton(word)).filter((b) => b.length >= 2),
      term: raw,
      wholeWord: true,
    });
  }

  return out;
}

/* ══════════════════════════════════════════════════════════ 6. the score ══ */

/**
 * How well a term matches one piece of text, 0 to 1, and WHY.
 *
 * The bands do not overlap and are wide apart, so the reason for a match
 * always outranks the closeness of it: any exact code match sorts above every
 * prefix match, which sorts above every substring, and so on down. A scoring
 * function that let a very close fuzzy match overtake a weak exact one would
 * put a guess above a scan, which is the one thing a shop counter cannot have.
 *
 *   1.00   the whole field IS the term            LX08 → LX08
 *   0.90+  the field starts with it               «توباكو فانيل» → «توباكو»
 *   0.75+  a WORD inside it starts with it        «توباكو فانيل» → «فانيل»
 *   0.60+  it appears somewhere inside            «فاني»
 *   0.40+  the keyboard was on the wrong language
 *   0.30+  the same name in the other script
 *   0.20+  a typo, scaled by how big the typo was
 *   0      no.
 *
 * Within a band, shorter fields win: a term that is most of a short name is a
 * better answer than the same term buried in a long one.
 */
export function scoreField(termKey, fieldKey, { kind = 'exact' } = {}) {
  if (!termKey || !fieldKey) return { score: 0, reason: null };

  const closeness = Math.min(1, termKey.length / Math.max(fieldKey.length, 1));

  if (kind === 'exact') {
    if (fieldKey === termKey) return { score: 1, reason: 'exact' };
    if (fieldKey.startsWith(termKey)) return { score: 0.9 + (closeness * 0.09), reason: 'prefix' };
    if (fieldKey.includes(` ${termKey}`)) return { score: 0.75 + (closeness * 0.14), reason: 'word' };
    if (fieldKey.includes(termKey)) return { score: 0.6 + (closeness * 0.14), reason: 'contains' };
    return { score: 0, reason: null };
  }
  if (kind === 'layout') {
    if (fieldKey.includes(termKey)) {
      return { score: 0.4 + (closeness * 0.19), reason: 'layout' };
    }
    return { score: 0, reason: null };
  }
  if (kind === 'skeleton') {
    if (fieldKey === termKey) return { score: 0.38, reason: 'script' };
    if (fieldKey.includes(termKey)) return { score: 0.3 + (closeness * 0.07), reason: 'script' };
    return { score: 0, reason: null };
  }
  return { score: 0, reason: null };
}

/**
 * The typo tier, kept separate because it is the only one that costs real work
 * and so is only ever run over rows the cheap tiers have already failed on.
 *
 * Compared WORD BY WORD, not against the whole field: `chanle` should reach
 * «شانيل» inside «عطر شانيل الاصلي», and the distance from `chanle` to that
 * whole string is enormous.
 */
export function scoreFuzzy(termTokens, fieldWords) {
  /*
   * PER WORD, and every word has to land. A term is a list of tokens here for
   * the same reason it is everywhere else in this file — and the reason it
   * matters most in this tier is that the tier is the loosest one.
   *
   * Keyed as one string, "Red Lipstick" becomes `redlipstick`, which is three
   * edits from `lipstick` and therefore inside the budget for an eleven-letter
   * word. So a product renamed from "Red Lipstick" to "Crimson Lipstick" went
   * on being found by its old name for ever — a rename that never took effect,
   * with nothing to show why.
   *
   * Per word, `red` gets a budget of 0 (see `editBudget`: three letters are
   * too few to guess at), fails to match anything, and the term correctly
   * returns nothing.
   */
  const tokens = Array.isArray(termTokens) ? termTokens : [termTokens];
  if (!tokens.length) return { score: 0, reason: null };

  let total = 0;
  for (const token of tokens) {
    const budget = editBudget(token);
    if (!budget) return { score: 0, reason: null };
    let best = budget + 1;
    for (const word of fieldWords) {
      // A word far longer than the token cannot be a typo OF the token.
      if (Math.abs(word.length - token.length) > budget) continue;
      const distance = editDistance(token, word, budget);
      if (distance < best) best = distance;
      if (best === 1) break;
    }
    if (best > budget) return { score: 0, reason: null };
    // 1 edit scores higher than 2. Never reaches the substring band above.
    total += 0.2 + ((budget - best + 1) / (budget + 1)) * 0.09;
  }
  return { score: total / tokens.length, reason: 'typo' };
}

export default {
  searchKey, searchKeyWords, searchTokens, indexText, indexBones, swapToArabic, swapToLatin, hasArabic, hasLatin,
  skeleton, editDistance, editBudget, candidates, scoreField, scoreFuzzy,
};
