/**
 * Hand-written 1D barcode encoders: Code 128 (with automatic Set B / Set C
 * switching) and EAN-13. No npm dependency — this app is copied onto an
 * offline shop PC and gets bundled by a serverless tracer that has already
 * silently dropped a dependency once, so the encoders live here as plain
 * arithmetic over the published symbologies.
 *
 * A barcode that renders but encodes the wrong payload is worse than one that
 * fails outright: it is discovered at the till by a customer. So every table
 * below is transcribed from the published symbol tables (ISO/IEC 15417 for
 * Code 128, the EAN-13 / GS1 General Specifications for EAN-13) rather than
 * derived, and `renderBarcode` never guesses — an un-encodable payload is a
 * `ValidationError`, never a silently-wrong bar pattern.
 */
import { ValidationError } from './errors.js';

const PX_PER_MM = 96 / 25.4; // CSS/SVG reference pixel, used only to pick a proportion.

/* ------------------------------------------------------------------ util */

/** Run-length-encode a string of '0'/'1' into an array of module widths. The
 * first width is always a bar (the symbologies below both start with '1'),
 * the second a space, and so on, alternating. */
function rleWidths(bits) {
  const widths = [];
  let i = 0;
  while (i < bits.length) {
    let j = i;
    while (j < bits.length && bits[j] === bits[i]) j += 1;
    widths.push(j - i);
    i = j;
  }
  return widths;
}

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/* =============================================================== Code 128 */
/**
 * The 107 Code 128 symbols (values 0-102 data, 103/104/105 = START A/B/C,
 * 106 = STOP), each an 11-bit bar/space pattern (13 bits for STOP, which has
 * an extra terminating bar). Every symbol starts with a bar ('1'), which is
 * what makes a flat run-length-encode of the concatenated bit string valid
 * for the whole symbol stream. Source: the published ISO/IEC 15417 symbol
 * table (cross-checked against the well-known worked example "PJJ123C" — see
 * tests/barcode.test.js).
 */
const BARS = [
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

const CODE128_CODE_C = 99;
const CODE128_CODE_B = 100;
const CODE128_START_B = 104;
const CODE128_START_C = 105;
const CODE128_STOP = 106;
export const CODE128_QUIET_MODULES = 10; // AIM ISO/IEC 15417: quiet zone >= 10x

/** True while `text[i..]` keeps being a run of ASCII digits; returns its length. */
function digitRunAt(text, i) {
  let len = 0;
  while (i + len < text.length && text[i + len] >= '0' && text[i + len] <= '9') len += 1;
  return len;
}

/**
 * Splits `text` into alternating Set B / Set C segments. A run of 4+ digits
 * switches to Set C (each symbol then carries a whole digit pair — half the
 * width of two Set B symbols), which matters on a 40mm label. Shorter digit
 * runs stay in Set B: switching costs one symbol, so below 4 digits there is
 * nothing to gain. An odd-length run keeps its trailing digit for Set B.
 */
function segmentCode128(text) {
  const n = text.length;
  const segments = [];
  let i = 0;
  while (i < n) {
    const runLen = digitRunAt(text, i);
    if (runLen >= 4) {
      const usable = runLen - (runLen % 2);
      segments.push({ set: 'C', chars: text.slice(i, i + usable) });
      i += usable;
      continue;
    }
    const start = i;
    i += 1;
    while (i < n && digitRunAt(text, i) < 4) i += 1;
    segments.push({ set: 'B', chars: text.slice(start, i) });
  }
  return segments;
}

/**
 * Encodes `payload` as Code 128. Only printable ASCII (space through `~`,
 * i.e. Set B's range) is supported — Code 128's Set A (control characters)
 * has no use on a product label and is deliberately left out.
 *
 * Returns { values, bits, moduleCount, text } where `bits` is the full
 * concatenated bar/space bitstring (start + data + checksum + stop, no quiet
 * zone) and `values` is the raw symbol value sequence, kept for testing the
 * checksum independently of the bit patterns.
 */
export function encodeCode128(payload) {
  const text = String(payload ?? '');
  if (!text) throw new ValidationError('Code 128 needs a payload to encode');
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code > 0x7e || ch.length > 1) {
      throw new ValidationError(
        `Code 128 cannot encode "${ch}" in "${text}" — only printable ASCII (space to ~) is supported`,
      );
    }
  }

  const segments = segmentCode128(text);
  const values = [];
  let currentSet = segments[0].set;
  values.push(currentSet === 'C' ? CODE128_START_C : CODE128_START_B);
  for (const seg of segments) {
    if (seg.set !== currentSet) {
      values.push(seg.set === 'C' ? CODE128_CODE_C : CODE128_CODE_B);
      currentSet = seg.set;
    }
    if (seg.set === 'C') {
      for (let k = 0; k < seg.chars.length; k += 2) values.push(Number(seg.chars.slice(k, k + 2)));
    } else {
      for (const ch of seg.chars) values.push(ch.codePointAt(0) - 32);
    }
  }

  // Checksum: start value plus each data value times its 1-indexed position,
  // mod 103 — the published Code 128 algorithm (verified by hand in
  // tests/barcode.test.js against the classic "PJJ123C" example).
  let checksum = values[0];
  for (let i = 1; i < values.length; i += 1) checksum += values[i] * i;
  checksum %= 103;
  values.push(checksum);
  values.push(CODE128_STOP);

  const bits = values.map((v) => String(BARS[v])).join('');
  return { values, bits, moduleCount: bits.length, text };
}

/* ================================================================ EAN-13 */
/**
 * L-code (left, odd parity), G-code (left, even parity) and R-code (right)
 * 7-module patterns for digits 0-9. R is the bitwise complement of L.
 * Source: GS1 General Specifications / the standard EAN-13 symbol table.
 */
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];

/** Which of L/G each of the 6 left-hand digits uses, indexed by the first
 * (implied, unencoded) digit 0-9. */
const EAN_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

export const EAN13_QUIET_LEFT = 11; // GS1 spec: 11 modules left, 7 right.
export const EAN13_QUIET_RIGHT = 7;

/** Standard EAN-13 check digit for the first 12 digits (odd positions x1,
 * even positions x3, mod 10, complement to 10). */
export function ean13CheckDigit(twelveDigits) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = Number(twelveDigits[i]);
    sum += d * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Encodes `payload` as EAN-13. Accepts 12 digits (the check digit is
 * computed) or 13 digits (the supplied check digit is verified). Anything
 * else is rejected with a ValidationError naming exactly what is wrong, so a
 * bad payload never silently prints as a different, valid-looking code.
 *
 * Only the last 12 digits are physically encoded in bars — the first digit
 * is implied by which L/G pattern combination the left-hand six digits use,
 * exactly as on any real EAN-13 barcode (the leading digit is printed to the
 * left of the bars, not inside them).
 */
export function encodeEan13(payload) {
  const raw = String(payload ?? '').trim();
  if (!raw) throw new ValidationError('EAN-13 needs a payload to encode');
  if (!/^[0-9]+$/.test(raw)) {
    throw new ValidationError(`EAN-13 can only encode digits — "${raw}" contains non-digit characters`);
  }
  if (raw.length !== 12 && raw.length !== 13) {
    throw new ValidationError(`EAN-13 needs 12 digits (check digit computed) or 13 digits (check digit verified) — got ${raw.length}`);
  }

  const data12 = raw.slice(0, 12);
  const computed = ean13CheckDigit(data12);
  let digits;
  if (raw.length === 12) {
    digits = data12 + String(computed);
  } else {
    const supplied = Number(raw[12]);
    if (supplied !== computed) {
      throw new ValidationError(
        `EAN-13 check digit is wrong: "${raw}" supplies ${supplied} but ${data12} computes to ${computed}`,
      );
    }
    digits = raw;
  }

  const firstDigit = Number(digits[0]);
  const parity = EAN_PARITY[firstDigit];
  const left = digits.slice(1, 7);
  const right = digits.slice(7, 13);

  let bits = '101'; // start guard
  for (let i = 0; i < 6; i += 1) {
    const d = Number(left[i]);
    bits += parity[i] === 'L' ? EAN_L[d] : EAN_G[d];
  }
  bits += '01010'; // middle guard
  for (let i = 0; i < 6; i += 1) bits += EAN_R[Number(right[i])];
  bits += '101'; // end guard

  return { digits, bits, moduleCount: bits.length };
}

/* ================================================================ render */

/**
 * Renders a barcode as a self-contained SVG string. `symbology` is
 * 'code128' or 'ean13'. `heightMm` sets the bar height; `showText` prints the
 * payload (Code 128) or the 13 digits (EAN-13) beneath the bars. Quiet zones
 * (blank margin either side of the bars, required for a scanner to find the
 * start/stop of the symbol) are always included and are never part of the
 * printed content.
 */
export function renderBarcode(payload, { symbology = 'code128', heightMm = 12, showText = true, moduleWidthPx = 2 } = {}) {
  const sym = String(symbology || 'code128').toLowerCase();
  let bits;
  let text;
  let quietLeft;
  let quietRight;

  if (sym === 'code128') {
    const enc = encodeCode128(payload);
    bits = enc.bits;
    text = enc.text;
    quietLeft = CODE128_QUIET_MODULES;
    quietRight = CODE128_QUIET_MODULES;
  } else if (sym === 'ean13') {
    const enc = encodeEan13(payload);
    bits = enc.bits;
    text = enc.digits;
    quietLeft = EAN13_QUIET_LEFT;
    quietRight = EAN13_QUIET_RIGHT;
  } else {
    throw new ValidationError(`Unknown barcode symbology "${symbology}" — expected "code128" or "ean13"`);
  }

  const widths = rleWidths(bits);
  const moduleCount = bits.length;
  const totalModules = quietLeft + moduleCount + quietRight;
  const barHeightPx = Math.max(1, Math.round(Number(heightMm) * PX_PER_MM)) || Math.round(12 * PX_PER_MM);
  const textHeightPx = showText ? Math.round(barHeightPx * 0.22) + 6 : 0;
  const totalWidthPx = totalModules * moduleWidthPx;
  const totalHeightPx = barHeightPx + textHeightPx;

  const rects = [];
  let x = quietLeft * moduleWidthPx;
  let isBar = true; // the bit patterns above always start with a bar
  for (const w of widths) {
    const wpx = w * moduleWidthPx;
    if (isBar) rects.push(`<rect x="${x}" y="0" width="${wpx}" height="${barHeightPx}" fill="#000"/>`);
    x += wpx;
    isBar = !isBar;
  }

  const textEl = showText
    ? `<text x="${totalWidthPx / 2}" y="${totalHeightPx - 1}" text-anchor="middle" `
      + `font-family="monospace" font-size="${Math.max(8, textHeightPx - 2)}" fill="#000">${escapeXml(text)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidthPx} ${totalHeightPx}" `
    + `width="${totalWidthPx}" height="${totalHeightPx}">`
    + `<rect x="0" y="0" width="${totalWidthPx}" height="${totalHeightPx}" fill="#fff"/>`
    + `${rects.join('')}${textEl}</svg>`;
}

export default { encodeCode128, encodeEan13, ean13CheckDigit, renderBarcode };
