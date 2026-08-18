/**
 * Value normalisation shared by both drivers.
 *
 * The two drivers disagree about the edges of SQLite's type system: one returns
 * `BigInt` for integers, the other a `number`; one rejects `undefined`, the
 * other silently binds NULL; neither accepts a JavaScript boolean. Normalising
 * in one place means the repositories and services above never have to know
 * which driver they are talking to.
 */

/** SQLite has no boolean, and `undefined` is not a bindable value anywhere. */
export function normaliseBindValue(value) {
  if (value === undefined) return null;
  // Product photos bind a Buffer. Both drivers take a Uint8Array as a BLOB, so
  // it must reach them untouched — this case is listed first and explicitly so
  // that a later `typeof`/`instanceof` test cannot quietly mangle the bytes.
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * True when the caller passed a single object of named parameters
 * (`@name` placeholders) rather than positional arguments.
 */
export function isNamedParams(params) {
  if (params.length !== 1) return false;
  const [first] = params;
  return (
    first !== null
    && typeof first === 'object'
    && !Array.isArray(first)
    && !(first instanceof Date)
    && !ArrayBuffer.isView(first)
  );
}

export function normaliseParams(params) {
  if (isNamedParams(params)) {
    const out = {};
    for (const [key, value] of Object.entries(params[0])) {
      out[key] = normaliseBindValue(value);
    }
    return out;
  }
  return params.map(normaliseBindValue);
}

/**
 * Integers arrive as BigInt from some drivers; nothing above wants that.
 *
 * BLOBs disagree in the same way: the file driver hands back a Uint8Array and
 * the networked one an ArrayBuffer. Both become a Buffer here, so a photo read
 * back is byte-for-byte what was written whichever driver is live, and the
 * serving endpoint can hand it straight to `res.end()`.
 */
export function normaliseRowValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

export function normaliseRow(row) {
  if (row === null || row === undefined) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = normaliseRowValue(value);
  }
  return out;
}

export const toCount = (value) => (value === null || value === undefined ? 0 : Number(value));
