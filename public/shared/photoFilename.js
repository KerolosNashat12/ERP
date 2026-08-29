/**
 * The one rule that turns a photograph's filename into a product code.
 *
 * WHY IT IS SHARED, and not two small functions in two files: the bulk photo
 * screen asks the server "which of these files do I know?" and then uploads the
 * matched ones. If the browser's idea of what code a file carries differed from
 * the server's by one character, the screen would show a person a green tick
 * beside a file and then file it against nothing, or against something else.
 * There is exactly one rule and both ends import it.
 *
 * ── What a shop's files are actually called ────────────────────────────────
 * Nobody renames two hundred photographs. What comes off a phone, a camera and
 * a Windows folder looks like this, and all four of these are the same product:
 *
 *     VS-1042.jpg
 *     VS-1042 (2).jpg        ← Windows, on a copy
 *     vs-1042_3.JPG          ← a camera, or a second shot
 *     VS-1042-2.jpeg         ← a person numbering them by hand
 *
 * So: drop the folder, drop the extension, drop a trailing duplicate number,
 * trim. What is left is compared EXACTLY (case aside) against real product
 * codes, SKUs and barcodes — never fuzzily. A near match that filed a
 * photograph of one product against another would be worse than no match at
 * all, because the shop would never know to go and look.
 *
 * ── The one thing this rule cannot do, stated rather than hidden ───────────
 * A product whose code genuinely ends in a hyphen and a digit — `BAG-2` — has
 * that digit read as a duplicate number, and `BAG-2.jpg` is looked up as
 * `BAG`. It is ambiguous in principle: nothing in the filename says which one
 * a person meant. The screen resolves it the only honest way — it looks up
 * BOTH readings, and shows which one it used — see `codeCandidates()`.
 */

/** Everything after the last dot, when that looks like a file extension. */
const EXTENSION = /\.[a-z0-9]{1,5}$/i;

/** ` (2)`, `_2`, `-2`, ` 2` and `  copy` at the very end of a name. */
const DUPLICATE_SUFFIX = /(?:[\s._-]*\((\d{1,3})\)|[\s._-](\d{1,3})|[\s._-]*copy(?:\s*\d{1,3})?)$/i;

/** A leading folder path, from a dropped directory or a `webkitRelativePath`. */
const FOLDER = /^.*[\\/]/;

/** The filename with its folder and extension removed. Nothing else. */
export function stemOf(filename) {
  return String(filename ?? '')
    .replace(FOLDER, '')
    .replace(EXTENSION, '')
    .trim();
}

/**
 * The code this filename most likely carries: the stem with one trailing
 * duplicate marker removed. `VS-1042 (2)` → `VS-1042`.
 *
 * One marker, not all of them: `VS-1042-2-3` is far more likely to be a code
 * with hyphens in it than a photograph numbered twice.
 */
export function codeFromFilename(filename) {
  const stem = stemOf(filename);
  const trimmed = stem.replace(DUPLICATE_SUFFIX, '').trim();
  // A stem that is ENTIRELY a duplicate marker (`(2).jpg`) leaves nothing, and
  // an empty code must not be looked up — it would match every product whose
  // code is somehow blank.
  return trimmed || stem;
}

/**
 * Both readings of a filename, best first — the honest answer to `BAG-2.jpg`.
 *
 * THE LITERAL STEM COMES FIRST. `BAG-2.jpg` is looked up as `BAG-2` before it
 * is looked up as `BAG`, because a filename that IS a product's code exactly is
 * not a guess, and the stripped reading is. A shop whose codes end in a number
 * therefore works with no special handling at all; a shop that numbers its
 * shots — `VS-1042-1`, `VS-1042-2`, `VS-1042-3` — finds nothing under the
 * literal reading and lands on the stripped one, which is what it meant.
 *
 * The one case both readings match is a shop that has BOTH `BAG` and `BAG-2` as
 * real codes, and there the literal one is unarguably the better answer.
 *
 * De-duplicated, so a name with no trailing number yields one candidate and
 * costs the lookup nothing extra.
 */
export function codeCandidates(filename) {
  const stem = stemOf(filename);
  const stripped = codeFromFilename(filename);
  return stripped === stem ? [stem].filter(Boolean) : [stem, stripped].filter(Boolean);
}

/**
 * Where a photograph sits among several of the same product: the trailing
 * number, or 1 when there isn't one.
 *
 * Used to order an upload, so `SKU-1.jpg SKU-2.jpg SKU-3.jpg` become the first,
 * second and third photograph of that product — and the first one becomes the
 * main photo, which is the one the shop's card shows. Getting this backwards
 * would put the shot of the barcode on the front of the card.
 */
export function sequenceOf(filename) {
  const match = DUPLICATE_SUFFIX.exec(stemOf(filename));
  if (!match) return 1;
  const digits = match[1] ?? match[2];
  return digits ? Number(digits) : 1;
}

export default { stemOf, codeFromFilename, codeCandidates, sequenceOf };
