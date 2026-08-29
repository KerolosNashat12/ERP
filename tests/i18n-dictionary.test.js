/**
 * THE DICTIONARY ITSELF — the two ways it can be wrong without anybody noticing.
 *
 * ── 1. A key defined twice ──────────────────────────────────────────────────
 * An object literal takes the LAST definition and says nothing. So a feature
 * that adds `photoAdded: 'Photograph added'` at the bottom of the file silently
 * rewrites the toast on a screen written eight months earlier — and the words
 * are plausible, so nobody reports it as a bug. Nineteen keys were duplicated
 * when this test was written. Two of them were actually wrong on screen:
 * deleting a PRODUCT photograph asked «تشيل الصورة دي من الفاتورة؟» — "remove
 * this photo from the INVOICE?" — because the legacy-invoices feature had
 * defined `removePhotoConfirm` after the product editor did.
 *
 * ── 2. A key in one language and not the other ──────────────────────────────
 * `t()`'s last resort is to return the key it was given, and a camelCase key
 * renders as something that looks like a badly-written label rather than as a
 * miss. That is exactly how three screens printed raw API codes in BOTH
 * languages for months (see the 2026-08-20 entry in the changelog). A key
 * present in English and missing in Arabic is the same failure waiting to
 * happen, and it is invisible until an Arabic-speaking shop reads it.
 *
 * Neither of these can be caught by a screenshot, a type checker or a review:
 * both look like ordinary correct code at every line you would look at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The dictionaries in every app that has one, read as SOURCE rather than
 * imported. Importing would hand back an object that has already lost every
 * duplicate — the bug would be invisible to the very test looking for it.
 */
const FILES = [
  'public/js/core/i18n.js',
  'public/shop/js/core/i18n.js',
  'public/platform/js/i18n.js',
  'public/kj/kj.js',
].map((relative) => path.join(here, '..', relative))
  .filter((file) => fs.existsSync(file));

test('there is a dictionary to check, in more than one app', () => {
  // The control. A glob that silently matched nothing would make every
  // assertion below pass on an empty list.
  assert.ok(FILES.length >= 2, `only ${FILES.length} dictionaries found`);
});

/**
 * Every `key:` at the top level of one language's object, WITH duplicates kept.
 *
 * Braces are counted so a nested object (`shots: { … }`) does not contribute
 * its own keys, and strings are skipped so a brace or a colon inside a
 * translation — «الساعة 9:00» — cannot move the depth.
 */
function keysAt(source, openIndex) {
  const keys = [];
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index) + 1 || source.length;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index) + 2;
      continue;
    }
    if (ch === '{') { depth += 1; index += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(source.slice(index));
      if (match) {
        keys.push(match[1]);
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return keys;
}

/** `{ en: [...keys], ar: [...keys] }` for one file, duplicates included. */
function languagesIn(source) {
  const out = {};
  for (const lang of ['en', 'ar']) {
    const marker = new RegExp(`(^|[\\s{,])${lang}\\s*:\\s*\\{`, 'm');
    const found = marker.exec(source);
    if (!found) continue;
    out[lang] = keysAt(source, source.indexOf('{', found.index + found[0].length - 1));
  }
  return out;
}

test('no key is defined twice in the same language', () => {
  const problems = [];
  for (const file of FILES) {
    const languages = languagesIn(fs.readFileSync(file, 'utf8'));
    for (const [lang, keys] of Object.entries(languages)) {
      const seen = new Set();
      const twice = new Set();
      for (const key of keys) {
        if (seen.has(key)) twice.add(key);
        seen.add(key);
      }
      if (twice.size) {
        problems.push(`${path.basename(path.dirname(file))}/${path.basename(file)} [${lang}]: ${[...twice].join(', ')}`);
      }
    }
  }
  assert.deepEqual(problems, [],
    'a later definition silently rewrites an earlier screen\'s words:\n  ' + problems.join('\n  '));
});

test('every key exists in both languages', () => {
  const problems = [];
  for (const file of FILES) {
    const { en, ar } = languagesIn(fs.readFileSync(file, 'utf8'));
    if (!en || !ar) continue;
    const inEn = new Set(en);
    const inAr = new Set(ar);
    const missingAr = [...inEn].filter((key) => !inAr.has(key));
    const missingEn = [...inAr].filter((key) => !inEn.has(key));
    const label = `${path.basename(path.dirname(file))}/${path.basename(file)}`;
    if (missingAr.length) problems.push(`${label}: missing from ar — ${missingAr.join(', ')}`);
    if (missingEn.length) problems.push(`${label}: missing from en — ${missingEn.join(', ')}`);
  }
  assert.deepEqual(problems, [],
    't() falls back to printing the key itself, which looks like a bad label rather than a miss:\n  '
    + problems.join('\n  '));
});

test('the parser actually finds the keys — the control for both tests above', () => {
  /*
   * Both assertions are "this list is empty", which is exactly what a parser
   * that found nothing would produce. So: it must find a large dictionary, and
   * it must find a key that is known to be in it and NOT find one that isn't.
   */
  const erp = FILES.find((file) => file.endsWith('js/core/i18n.js') && file.includes('/js/'));
  const { en, ar } = languagesIn(fs.readFileSync(erp, 'utf8'));
  assert.ok(en.length > 500, `only ${en.length} English keys found — the parser is not reading the file`);
  assert.ok(ar.length > 500, `only ${ar.length} Arabic keys found`);
  assert.ok(en.includes('photoAdded'), 'a key that is definitely there was not found');
  assert.ok(!en.includes('thisKeyDoesNotExistAnywhere'), 'the parser invents keys');

  // And it must be able to SEE a duplicate: the same source with one key
  // repeated has to come back with it twice.
  const doubled = "const d = { en: { alpha: 'a', beta: 'b', alpha: 'c' }, ar: { alpha: 'أ' } };";
  assert.deepEqual(languagesIn(doubled).en, ['alpha', 'beta', 'alpha'],
    'the parser cannot see a duplicate, so the test above can never fail');
});
