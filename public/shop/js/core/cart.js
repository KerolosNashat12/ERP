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

function clampQty(value) {
  const qty = Math.floor(Number(value));
  if (!Number.isFinite(qty)) return 1;
  return Math.min(Math.max(qty, 1), MAX_QTY);
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

/** Adding the same variant twice adds to the line rather than making a second one. */
export function add(item, qty = 1) {
  const variantId = Number(item.variant_id);
  if (!Number.isInteger(variantId) || variantId <= 0) return;
  const existing = lines.find((line) => line.variant_id === variantId);
  if (existing) existing.qty = clampQty(existing.qty + qty);
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
      qty: clampQty(qty),
    });
  }
  save();
}

export function setQty(variantId, qty) {
  const line = lines.find((entry) => entry.variant_id === Number(variantId));
  if (!line) return;
  if (Number(qty) < 1) return remove(variantId);
  line.qty = clampQty(qty);
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
 * Some of what is in the basket may have sold out or been unpublished since it
 * was added. The server refuses the whole order in that case, naming the item;
 * this drops the offending line so the customer can retry without hunting for it.
 */
export function dropVariant(variantId) {
  remove(variantId);
}
