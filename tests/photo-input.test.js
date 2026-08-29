/**
 * A FILE INPUT MUST NOT REMOVE THE PHOTO LIBRARY.
 *
 * The bug, reported from a phone: tapping «إضافة صورة» on the add-invoice
 * screen opened the camera and nothing else. There was no way to attach a
 * photograph already in the gallery — and a shop owner photographs a
 * supplier's invoice when it arrives and files it later, or is sent one on
 * WhatsApp. His words: «انا محتاج هنا اضيف صور من الجاليري عادي مش لازم افتح
 * واصور دلوقتي».
 *
 * The cause was one attribute, `capture="environment"`, added on the
 * reasonable-sounding assumption that somebody adding a bill is standing in
 * front of it. `capture` does not mean "offer the camera first". On iOS it
 * means "the camera is the ONLY source": the sheet that would have offered
 * Photo Library never appears at all.
 *
 * This is a SOURCE test rather than a behavioural one on purpose. The
 * behaviour cannot be reproduced in a headless browser — there is no camera
 * and no gallery — so what is fenced instead is the one line that caused it,
 * everywhere a file input exists. That is enough: the attribute is the whole
 * bug, and it is the kind of thing somebody adds back in good faith.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = ['public/js', 'public/shop/js', 'public/platform/js']
  .map((rel) => path.join(here, '..', rel))
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
const FILES = roots.flatMap((dir) => walk(dir));

test('there are front-end files to check — the control', () => {
  // Both assertions below are "nothing matched", which is exactly what an
  // empty file list would produce.
  assert.ok(FILES.length > 20, `only ${FILES.length} files found`);
  assert.ok(FILES.some((f) => f.endsWith('core/proof.js')), 'proof.js was not reached');
});

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
const codeOnly = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

test('no file input forces the camera', () => {
  /*
   * Matched as a real attribute — a property in an element spec, or an HTML
   * attribute. `app.js` has a comment about the capture PHASE, which an
   * unqualified search for the word would flag for ever; comments are stripped
   * above, and the shape is still required here so a variable named `capture`
   * in some future file is not mistaken for one.
   */
  const ATTRIBUTE = /(^|[\s{,])capture\s*:\s*['"`]|<input[^>]*\scapture[=\s>]/;
  const offenders = [];
  for (const file of FILES) {
    const source = codeOnly(fs.readFileSync(file, 'utf8'));
    if (ATTRIBUTE.test(source)) offenders.push(path.relative(path.join(here, '..'), file));
  }
  assert.deepEqual(offenders, [],
    'capture= makes the camera the only source on iOS — the Photo Library sheet '
    + 'never appears, and a photograph taken earlier cannot be attached at all');
});

test('stripping the comments does not blind the check — the control', () => {
  /*
   * Both halves. The stripper must remove an attribute-looking phrase from
   * PROSE, and must leave a real one alone — otherwise the test above passes
   * on a file that genuinely forces the camera, which is worse than the false
   * positive it was written to avoid.
   */
  const prose = "/*\n * It used to say `capture: 'environment'`, which was wrong.\n */\nconst a = 1;";
  assert.ok(!/capture\s*:/.test(codeOnly(prose)), 'a comment still trips the scan');

  const real = "const input = h('input', {\n  type: 'file',\n  capture: 'environment',\n});";
  assert.match(codeOnly(real), /capture\s*:/, 'a real attribute was stripped away with the comments');

  const lineComment = "// capture: 'environment' used to be here\nconst b = 2;";
  assert.ok(!/capture\s*:/.test(codeOnly(lineComment)), 'a // comment still trips the scan');
});

test('the picker that takes invoice pages accepts more than one file', async () => {
  /*
   * A paper invoice is several pages and they are all in the gallery together.
   * Selecting them one at a time, through a separate sheet each time, is the
   * work this is meant to remove — so the multi-page list asks for `multiple`
   * and has somewhere to put the extras.
   */
  const source = fs.readFileSync(path.join(here, '..', 'public/js/views/legacyInvoices.js'), 'utf8');
  assert.match(source, /multiple:\s*true/, 'invoice pages cannot be picked in one go');
  assert.match(source, /onExtra/, 'extra pictures have nowhere to go and would be dropped');

  const picker = fs.readFileSync(path.join(here, '..', 'public/js/core/proof.js'), 'utf8');
  assert.match(picker, /onExtra/, 'the picker cannot hand back the files past the first');
  assert.match(picker, /accept:\s*async/, 'a spawned page cannot be filled from an already-chosen file');
  // And a picker with nowhere to put them must SAY so rather than drop them.
  assert.match(picker, /onePhotoOnlyHere/,
    'extra pictures are discarded silently when the caller holds only one');
});

test('every file input still accepts pictures', () => {
  /*
   * The other half. Removing `capture` must not have removed `accept` with it:
   * without `accept="image/*"` a phone offers every document on the device and
   * the person has to find a photograph among them.
   */
  const missing = [];
  for (const file of FILES) {
    const source = fs.readFileSync(file, 'utf8');
    // Each `type: 'file'` spec object, up to its closing brace-ish region.
    const specs = source.split(/type:\s*'file'/).slice(1);
    for (const spec of specs) {
      const head = spec.slice(0, 400);
      /*
       * A literal `'image/*'`, or a named list of image types — the console's
       * asset picker declares `ALLOWED_IMAGE_TYPES.join(',')`, which is
       * deliberately STRICTER than `image/*` (png, jpeg, webp only) and would
       * be a false positive for a test that only knew about the literal.
       */
      const declares = /accept:\s*['"`]image/.test(head)
        || /accept:\s*[A-Z_]*IMAGE[A-Z_]*\s*\.join/.test(head);
      if (!declares) missing.push(path.relative(path.join(here, '..'), file));
    }
  }
  assert.deepEqual([...new Set(missing)], [],
    'a file input does not say it wants pictures, so a phone will offer every file on it');
});
