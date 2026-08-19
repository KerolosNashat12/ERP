/**
 * Correctness tests for the hand-written encoders in src/shared/barcode.js.
 *
 * Pure unit tests — no database, no server — because a wrong bar pattern is a
 * bug regardless of what driver is running underneath. Everything here
 * decodes what the encoder produced using decoders written independently
 * below (not by calling back into the encoder's internals), so a bug that
 * makes the encoder self-consistent but wrong against the published
 * symbologies would still be caught.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeCode128, encodeEan13, ean13CheckDigit, renderBarcode,
  CODE128_QUIET_MODULES, EAN13_QUIET_LEFT, EAN13_QUIET_RIGHT,
} from '../src/shared/barcode.js';
import { ValidationError } from '../src/shared/errors.js';



/* ============================================================ decoders =
 * Written from scratch against the published symbol tables, independently
 * of src/shared/barcode.js's encoding logic (the data tables are the same
 * published constants by necessity — the decode *algorithm* is not reused).
 */

const DECODE_BARS = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
  10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
  11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
  10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
  11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
  11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
  11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
  10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
  11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
  11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
  11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
  10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
  11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
  10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
  11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
  10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
  10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
];
const DECODE_PATTERN_TO_VALUE = new Map(DECODE_BARS.map((n, i) => [String(n), i]));

/** Reconstructs the original text from a raw Code 128 bit string (start +
 * data + checksum + stop, no quiet zone) — the same string `encodeCode128`
 * produces, but this function never looks at the encoder's `values` array. */
function decodeCode128(bits) {
  const stop = bits.slice(-13);
  assert.equal(DECODE_PATTERN_TO_VALUE.get(stop), 106, 'must end on the STOP pattern');
  const body = bits.slice(0, -13);
  assert.equal(body.length % 11, 0, 'every non-stop Code 128 symbol is 11 modules');

  const values = [];
  for (let i = 0; i < body.length; i += 11) {
    const v = DECODE_PATTERN_TO_VALUE.get(body.slice(i, i + 11));
    assert.ok(v !== undefined, `unrecognised Code 128 pattern at module ${i}`);
    values.push(v);
  }
  values.push(106); // stop, for a complete record

  const start = values[0];
  assert.ok([103, 104, 105].includes(start), 'must open on a START symbol');
  const checksum = values[values.length - 2];
  const data = values.slice(1, -2);

  // Checksum, computed independently of the encoder.
  let expected = start;
  for (let i = 0; i < data.length; i += 1) expected += data[i] * (i + 1);
  expected %= 103;
  assert.equal(checksum, expected, 'Code 128 checksum must match the published algorithm');

  let mode = start === 105 ? 'C' : 'B'; // 104 = START B, 105 = START C
  let text = '';
  for (const v of data) {
    if (v === 99) { mode = 'C'; continue; } // CODE C
    if (v === 100) { mode = 'B'; continue; } // CODE B
    if (mode === 'C') {
      text += String(v).padStart(2, '0');
    } else {
      text += String.fromCharCode(v + 32);
    }
  }
  return text;
}

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

/** Reconstructs the 13 digits from a raw EAN-13 bit string. */
function decodeEan13(bits) {
  assert.equal(bits.length, 95, 'EAN-13 is always 95 modules');
  assert.equal(bits.slice(0, 3), '101', 'start guard');
  assert.equal(bits.slice(45, 50), '01010', 'middle guard');
  assert.equal(bits.slice(92, 95), '101', 'end guard');

  let parity = '';
  let left = '';
  for (let i = 0; i < 6; i += 1) {
    const chunk = bits.slice(3 + i * 7, 10 + i * 7);
    const lIdx = EAN_L.indexOf(chunk);
    const gIdx = EAN_G.indexOf(chunk);
    assert.ok(lIdx >= 0 || gIdx >= 0, `unrecognised left digit pattern at position ${i}`);
    if (lIdx >= 0) { parity += 'L'; left += String(lIdx); } else { parity += 'G'; left += String(gIdx); }
  }
  const firstDigit = EAN_PARITY.indexOf(parity);
  assert.ok(firstDigit >= 0, `unrecognised parity sequence "${parity}"`);

  let right = '';
  for (let i = 0; i < 6; i += 1) {
    const chunk = bits.slice(50 + i * 7, 57 + i * 7);
    const rIdx = EAN_R.indexOf(chunk);
    assert.ok(rIdx >= 0, `unrecognised right digit pattern at position ${i}`);
    right += String(rIdx);
  }

  const digits = String(firstDigit) + left + right;
  // Check digit, computed independently of the encoder.
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  const expectedCheck = (10 - (sum % 10)) % 10;
  assert.equal(Number(digits[12]), expectedCheck, 'EAN-13 check digit must match the published algorithm');
  return digits;
}

/* ======================================================== round trips == */

test('Code 128 round-trips: letters + short digit run (stays Set B)', () => {
  const enc = encodeCode128('ABC-123');
  assert.equal(decodeCode128(enc.bits), 'ABC-123');
});

test('Code 128 round-trips: a single character', () => {
  const enc = encodeCode128('A');
  assert.equal(decodeCode128(enc.bits), 'A');
});

test('Code 128 round-trips: alternating letters and digits (each digit run < 4, stays Set B)', () => {
  const payload = 'A1B2C3D4E5F6G7H8';
  const enc = encodeCode128(payload);
  assert.equal(decodeCode128(enc.bits), payload);
});

test('Code 128 round-trips: a long digits-only SKU (must switch into Set C)', () => {
  const payload = '90012345678903'; // 14 digits, all in one run
  const enc = encodeCode128(payload);
  // Assert Set C actually got used — this is the width-halving the contract cares
  // about. The whole payload is digits from position 0, so the encoder opens
  // directly on START C (105) rather than switching into C mid-stream (99).
  assert.equal(enc.values[0], 105, 'expected START C for an all-digit payload');
  assert.equal(enc.values.length, 1 + payload.length / 2 + 2, 'each Set C symbol carries a digit pair');
  assert.equal(decodeCode128(enc.bits), payload);
});

test('Code 128 round-trips: an odd-length long digit run (trailing digit falls back to Set B)', () => {
  const payload = '900123456789035'; // 15 digits
  const enc = encodeCode128(payload);
  assert.equal(decodeCode128(enc.bits), payload);
});

test('EAN-13 round-trips: a real EAN-13 (13 digits, check digit verified)', () => {
  const enc = encodeEan13('4006381333931');
  assert.equal(decodeEan13(enc.bits), '4006381333931');
  assert.equal(enc.digits, '4006381333931');
});

test('EAN-13 round-trips: a 12-digit input, check digit computed', () => {
  const enc = encodeEan13('590123412345');
  assert.equal(enc.digits, '5901234123457');
  assert.equal(decodeEan13(enc.bits), '5901234123457');
});

/* ===================================================== checksum by hand = */

test('Code 128 checksum by hand: the classic "PJJ123C" example (Set B throughout)', () => {
  // Values: START B=104, P=48, J=42, J=42, 1=17, 2=18, 3=19, C=35 (value = charCode - 32).
  // checksum = (104 + 48*1 + 42*2 + 42*3 + 17*4 + 18*5 + 19*6 + 35*7) mod 103
  //          = (104 + 48 + 84 + 126 + 68 + 90 + 114 + 245) mod 103
  //          = 879 mod 103 = 55
  const enc = encodeCode128('PJJ123C');
  assert.deepEqual(enc.values.slice(0, 8), [104, 48, 42, 42, 17, 18, 19, 35]);
  assert.equal(enc.values[8], 55, 'hand-computed checksum must match the encoder');
  assert.equal(enc.values[9], 106, 'must be followed by STOP');
  assert.equal(decodeCode128(enc.bits), 'PJJ123C');
});

test('EAN-13 check digit: 400638133393_ -> 1', () => {
  assert.equal(ean13CheckDigit('400638133393'), 1);
  assert.equal(encodeEan13('400638133393').digits, '4006381333931');
});

test('EAN-13 check digit: 590123412345_ -> 7', () => {
  assert.equal(ean13CheckDigit('590123412345'), 7);
  assert.equal(encodeEan13('590123412345').digits, '5901234123457');
});

/* =============================================================== SVG === */

function barRects(svg) {
  // Only the black bars — the white background rect is excluded by its fill.
  return [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)" height="([\d.]+)" fill="#000"\/>/g)]
    .map((m) => ({ x: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }));
}

test('Code 128 SVG: bar widths are integral multiples of one module, quiet zones present', () => {
  const moduleWidthPx = 2;
  const svg = renderBarcode('ABC-123', { symbology: 'code128', moduleWidthPx, showText: false });
  const rects = barRects(svg);
  assert.ok(rects.length > 0);
  for (const r of rects) {
    assert.equal(r.width % moduleWidthPx, 0, `bar width ${r.width} must be a whole number of modules`);
  }
  const totalWidthMatch = /width="([\d.]+)"/.exec(svg);
  const totalWidthPx = Number(totalWidthMatch[1]);
  const quietPx = CODE128_QUIET_MODULES * moduleWidthPx;
  assert.ok(rects[0].x >= quietPx, `first bar at x=${rects[0].x} must sit past the left quiet zone (${quietPx})`);
  const last = rects[rects.length - 1];
  assert.ok(last.x + last.width <= totalWidthPx - quietPx,
    `last bar must end before the right quiet zone (total ${totalWidthPx}, quiet ${quietPx})`);
});

test('EAN-13 SVG: bar widths are integral multiples of one module, asymmetric quiet zones present', () => {
  const moduleWidthPx = 3;
  const svg = renderBarcode('4006381333931', { symbology: 'ean13', moduleWidthPx, showText: true });
  const rects = barRects(svg);
  assert.ok(rects.length > 0);
  for (const r of rects) assert.equal(r.width % moduleWidthPx, 0);
  const totalWidthPx = Number(/width="([\d.]+)"/.exec(svg)[1]);
  assert.ok(rects[0].x >= EAN13_QUIET_LEFT * moduleWidthPx);
  const last = rects[rects.length - 1];
  assert.ok(last.x + last.width <= totalWidthPx - EAN13_QUIET_RIGHT * moduleWidthPx);
  assert.ok(svg.includes('4006381333931'), 'human-readable digits must be present when showText is true');
});

test('showText=false omits the human-readable line', () => {
  const svg = renderBarcode('ABC-123', { symbology: 'code128', showText: false });
  assert.ok(!svg.includes('<text'));
});

/* ========================================================= validation == */

test('EAN-13 rejects letters', () => {
  assert.throws(() => encodeEan13('ABC'), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /digits/i);
    return true;
  });
});

test('EAN-13 rejects 12 digits + wrong supplied check digit (13 digits, last one incorrect)', () => {
  // 400638133393 computes to check digit 1 (see above) — supply 9 instead.
  assert.throws(() => encodeEan13('4006381333939'), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /check digit/i);
    assert.match(e.message, /9/);
    assert.match(e.message, /computes to 1/);
    return true;
  });
});

test('EAN-13 rejects 14 digits', () => {
  assert.throws(() => encodeEan13('40063813339311'), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.match(e.message, /12 digits.*13 digits|got 14/i);
    return true;
  });
});

test('EAN-13 rejects, and messages are distinct for each failure', () => {
  const messages = new Set();
  for (const bad of ['ABC', '4006381333939', '40063813339311']) {
    try { encodeEan13(bad); assert.fail(`expected ${bad} to be rejected`); } catch (e) {
      assert.ok(e instanceof ValidationError);
      messages.add(e.message);
    }
  }
  assert.equal(messages.size, 3, 'each rejection must produce a distinct message');
});

test('Code 128 rejects an empty payload', () => {
  assert.throws(() => encodeCode128(''), ValidationError);
});

test('Code 128 rejects non-ASCII / control characters', () => {
  assert.throws(() => encodeCode128('café'), ValidationError); // é is outside space..~
});

test('unknown symbology is rejected', () => {
  assert.throws(() => renderBarcode('ABC', { symbology: 'pdf417' }), ValidationError);
});
