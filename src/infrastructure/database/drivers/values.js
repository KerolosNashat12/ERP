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

/** Integers arrive as BigInt from some drivers; nothing above wants that. */
export function normaliseRowValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
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
