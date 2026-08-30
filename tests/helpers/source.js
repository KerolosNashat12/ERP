/**
 * Shared machinery for the SOURCE tests — the ones that read the front end as
 * text because the behaviour they fence cannot be reproduced in a headless
 * browser (a camera, a gallery, a tenant prefix on an `<img src>`).
 *
 * It lives here rather than in either test because a rule written twice
 * diverges within a month, and `codeOnly` in particular has already been
 * wrong once in a way that made a test pass on a broken file. One copy, so a
 * fix to it fixes every test that leans on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The three front-end trees: the ERP shell, the storefront, the console. */
const roots = ['public/js', 'public/shop/js', 'public/platform/js']
  .map((rel) => path.join(here, '..', '..', rel))
  .filter((dir) => fs.existsSync(dir));

/** Every .js file under the front-end trees. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * Scanning raw source for `capture:` is not good enough, and this file is the
 * proof: the fix that removed the attribute replaced it with a long comment
 * explaining why — a comment containing the literal text `capture:
 * 'environment'`. The first version of this test passed only because a
 * backtick happened to sit in front of that occurrence and the pattern
 * demanded whitespace. One reworded sentence and the test would have failed on
 * a correct file, for ever, with a message accusing it of the opposite of what
 * it does.
 *
 * A test that can be broken by prose is a test people learn to ignore. So the
 * prose goes first, and what is left is code.
 */
const codeOnly = (source) => {
  /*
   * Walked character by character rather than done with two regexes, because
   * the regex version was WORSE THAN NOTHING and this file is the proof.
   *
   * A regex for "slash-star, anything, star-slash" finds a comment opening
   * inside a STRING literal. Every file input in this ERP declares an accept
   * of image-slash-star — and that value contains a slash followed by a star.
   * So the stripper treated the rest of the file as one long
   * comment and deleted it, including the `capture:` line sitting two rows
   * below. The test went green on a file that forced the camera, which is the
   * exact failure it exists to prevent, and it was introduced by "hardening"
   * it. Only the reversion check caught it.
   *
   * So: strings and template literals are skipped as strings, comments are
   * skipped as comments, and neither can start inside the other.
   */
  let out = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        // A backslash escapes the next character, including the quote.
        if (source[i] === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
        out += source[i];
        i += 1;
      }
      out += source[i] ?? '';
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

/** Every .js file across the three front ends. */
export const FRONT_END_FILES = roots.flatMap((dir) => walk(dir));
export { walk, codeOnly, roots };
