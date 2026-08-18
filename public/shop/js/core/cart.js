/**
 * The basket — kept in `localStorage` so closing the tab, losing signal on the
 * metro or simply refreshing does not throw the shopping away.
 *
 * What is stored is a SNAPSHOT for display: the variant id, the quantity, and
 * the name, price and photo as they were when the item was added. The server
 * is told only the variant ids and quantities and prices every line itself, so
 * a stale — or edited — price here can never become the price charged. This
 * copy exists purely so the cart can paint instantly without a round trip.
 */

const STORAGE_KEY = 'mm.shop.cart.v1';
const MAX_QTY = 99;

const listeners = new Set();
let lines = load();

function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Anything in localStorage is user input: another tab, an old version of
    // this file, or somebody with the dev tools open. Rebuild each line from
    // known fields rather than trusting the object that came back.
    return parsed
      .map((line) => ({
        variant_id: Number(line.variant_id),
        product_id: Number(line.product_id) || null,
        name_en: String(line.name_en || ''),
        name_ar: String(line.name_ar || ''),
        label: line.label ? String(line.label) : '',
        price: Number(line.price) || 0,
        tax_rate: Number(line.tax_rate) || 0,
        image_id: Number(line.image_id) || null,
        qty: clampQty(line.qty),
      }))
      .filter((line) => Number.isInteger(line.variant_id) && line.variant_id > 0);
  } catch {
    return [];
  }
}

/**
 * `max` is what the shop actually has of this variant — null, undefined or a
 * non-number all mean "no known cap", which is the honest reading of a product
 * that is not stock-tracked and of a cart line whose stock has not been looked
 * up yet. A cap of 0 or less still floors at 1: dropping the line is the
 * caller's decision (`applyLimits` makes it), not a side effect of arithmetic.
 */
function ceiling(max) {
  const n = Math.floor(Number(max));
  if (!Number.isFinite(n)) return MAX_QTY;
  return Math.min(Math.max(n, 1), MAX_QTY);
}

function clampQty(value, max) {
  const qty = Math.floor(Number(value));
  if (!Number.isFinite(qty)) return 1;
  return Math.min(Math.max(qty, 1), ceiling(max));
}

function save() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch { /* a full or disabled store must not break checkout */ }
  listeners.forEach((fn) => fn(lines));
}

export const getLines = () => lines.map((line) => ({ ...line }));
export const count = () => lines.reduce((sum, line) => sum + line.qty, 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const subtotal = () => round2(lines.reduce((sum, line) => sum + round2(line.price * line.qty), 0));

/**
 * VAT, line by line and rounded the same way the server does it — the shop's
 * prices are net and `WebOrderService` adds tax per line. Summing the rounded
 * line taxes (rather than taxing the basket total) is what makes the figure on
 * the summary identical to the figure on the order that comes back.
 */
export const taxTotal = () => round2(lines.reduce(
  (sum, line) => sum + round2(round2(line.price * line.qty) * (line.tax_rate / 100)), 0));

/** What the goods cost the customer, tax in — the number delivery is measured against. */
export const goodsTotal = () => round2(subtotal() + taxTotal());
export const isEmpty = () => lines.length === 0;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/**
 * Adding the same variant twice adds to the line rather than making a second one.
 *
 * `max` caps the result at what the shop has left, so a customer who adds three
 * and then three more of something there are only five of ends up with five,
 * here, rather than at the end of checkout. Returns the quantity the line
 * actually holds, so the caller can say so if it is less than was asked for.
 */
export function add(item, qty = 1, max = null) {
  const variantId = Number(item.variant_id);
  if (!Number.isInteger(variantId) || variantId <= 0) return 0;
  const existing = lines.find((line) => line.variant_id === variantId);
  if (existing) existing.qty = clampQty(existing.qty + qty, max);
  else {
    lines.push({
      variant_id: variantId,
      product_id: Number(item.product_id) || null,
      name_en: String(item.name_en || ''),
      name_ar: String(item.name_ar || ''),
      label: item.label ? String(item.label) : '',
      price: Number(item.price) || 0,
      tax_rate: Number(item.tax_rate) || 0,
      image_id: Number(item.image_id) || null,
      qty: clampQty(qty, max),
    });
  }
  save();
  return lines.find((line) => line.variant_id === variantId)?.qty || 0;
}

export function setQty(variantId, qty, max = null) {
  const line = lines.find((entry) => entry.variant_id === Number(variantId));
  if (!line) return;
  if (Number(qty) < 1) return remove(variantId);
  line.qty = clampQty(qty, max);
  save();
}

export function remove(variantId) {
  lines = lines.filter((line) => line.variant_id !== Number(variantId));
  save();
}

export function clear() {
  lines = [];
  save();
}

/** Exactly what `POST /api/shop/orders` wants — ids and quantities, no prices. */
export const toOrderLines = () => lines.map((line) => ({ variant_id: line.variant_id, quantity: line.qty }));

/**
 * Reconcile the basket with what the shop has RIGHT NOW.
 *
 * This basket came out of `localStorage`, so it may be days old, may have been
 * built when there were ten of something, and may have been hand-edited by
 * somebody with the dev tools open. `limits` maps variant_id to the number
 * available: null (or a variant that is simply absent, because its product has
 * since been unpublished) means no known cap and the line is left alone for the
 * server to rule on; 0 means it is gone and the line goes with it.
 *
 * Returns the lines that were changed — clamped or dropped — so the view can
 * tell the customer once, calmly, instead of silently rewriting their basket.
 */
export function applyLimits(limits) {
  if (!limits || typeof limits.get !== 'function') return [];
  const changed = [];
  const kept = [];

  for (const line of lines) {
    const max = limits.get(line.variant_id);
    if (max === null || max === undefined || !Number.isFinite(Number(max))) {
      kept.push(line);
      continue;
    }
    const cap = Math.max(Math.floor(Number(max)), 0);
    if (cap <= 0) {
      changed.push({ ...line, qty: 0 });
      continue;
    }
    if (line.qty > cap) {
      changed.push({ ...line, qty: cap });
      line.qty = cap;
    }
    kept.push(line);
  }

  if (changed.length) {
    lines = kept;
    save();
  }
  return changed;
}

/**
 * Some of what is in the basket may have sold out or been unpublished since it
 * was added. The server refuses the whole order in that case, naming the item;
 * this drops the offending line so the customer can retry without hunting for it.
 */
export function dropVariant(variantId) {
  remove(variantId);
}
