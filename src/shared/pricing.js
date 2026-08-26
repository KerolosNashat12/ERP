/**
 * What a piece actually costs today — the offer rule, written once.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 * A discount that the website knows about and the till does not is not a
 * feature, it is a fight at the counter. The shopper photographs 800 on her
 * phone, walks in, and the till says 1000; whoever is standing there has to
 * decide, in front of a queue, which of the shop's own screens is lying. So the
 * offer price is not a website decoration: while an offer runs, it IS the
 * product's price, and every surface asks this one function what that is —
 * the storefront card, the product page, the online order, the POS, the
 * receipt. There is no second spelling of the arithmetic anywhere.
 *
 * ── What an offer is ────────────────────────────────────────────────────────
 * Four columns on `products`, and nothing else:
 *
 *   discount_type       'none' | 'percent' | 'amount'
 *   discount_value      the rate (0–100) or the money off, per piece
 *   discount_starts_on  the first day it applies, or null for "already running"
 *   discount_ends_on    the last day it applies, INCLUSIVE, or null for "until
 *                       somebody turns it off"
 *
 * Per PRODUCT and not per variant, deliberately: a shop owner discounts «فلانتينو
 * ابيض», not the 50ml of it. Every active variant of the product moves by the
 * same rate, so a product whose variants are priced differently keeps the shape
 * of its own price list.
 *
 * ── The rules, and why each one is here ─────────────────────────────────────
 * · A percent is clamped to 0–100. A 120% discount is a shop paying customers
 *   to take stock away, and it is always a typo.
 * · An amount is clamped to the price. The floor is zero, never below it: a
 *   negative price would flow into revenue, tax and profit and quietly poison
 *   every report that touches the sale.
 * · Both are rounded to two decimals the same way money is rounded everywhere
 *   else in this system, by `round2`, so a price shown, a price charged and a
 *   price reported can never differ by a piastre.
 * · An offer that saves nothing is not an offer. If the arithmetic lands back
 *   on the list price — a 0% rate, an amount of zero, a rounding that ate the
 *   difference — the answer is "not on sale", and no badge is drawn. A shelf
 *   full of «خصم ٠٪» stickers is how a shop teaches its customers to ignore
 *   its stickers.
 * · Dates are compared as plain YYYY-MM-DD strings against the shop's own day.
 *   Not timestamps: a shop owner setting an offer "until the 30th" means the
 *   whole of the 30th, in Cairo, not 00:00 UTC on it.
 */
import { round2 } from './money.js';

/** The three answers, in the order they read on the ERP form and the filters. */
export const GENDERS = ['women', 'men', 'unisex'];
export const DEFAULT_GENDER = 'unisex';
export const isGender = (value) => GENDERS.includes(String(value || ''));

export const DISCOUNT_TYPES = ['none', 'percent', 'amount'];
export const isDiscountType = (value) => DISCOUNT_TYPES.includes(String(value || ''));

/** Today where the shop is, as YYYY-MM-DD. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

const day = (value) => {
  const text = String(value || '').trim();
  return text ? text.slice(0, 10) : null;
};

/**
 * Is this product's offer running on `on`?
 *
 * Deliberately separate from the arithmetic below, because two different
 * questions are asked of it: "should this row be counted as on sale" (the
 * filter, the facet count) and "what do we charge" (everything else).
 */
export function offerRunning(product = {}, on = today()) {
  const type = String(product.discount_type || 'none');
  if (type !== 'percent' && type !== 'amount') return false;
  if (!(Number(product.discount_value) > 0)) return false;

  const date = day(on) || today();
  const from = day(product.discount_starts_on);
  const to = day(product.discount_ends_on);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/**
 * What one piece costs, and what it cost before.
 *
 * @param {number} listPrice the variant's own `selling_price`
 * @param {object} product   the product row (or anything carrying the four columns)
 * @param {string} [on]      the day to price for; defaults to today
 * @returns {{price: number, listPrice: number, saved: number, percent: number, onSale: boolean}}
 *   `price` is what is charged. `listPrice` is what it was — equal to `price`
 *   when nothing is running, so a caller can print both without a branch.
 *   `percent` is a whole number, rounded, for the badge.
 */
export function offerPrice(listPrice, product = {}, on = today()) {
  const list = round2(Math.max(Number(listPrice) || 0, 0));
  const none = {
    price: list, listPrice: list, saved: 0, percent: 0, onSale: false,
  };
  if (!list || !offerRunning(product, on)) return none;

  const value = Number(product.discount_value) || 0;
  const off = product.discount_type === 'percent'
    ? round2(list * (Math.min(Math.max(value, 0), 100) / 100))
    : round2(Math.min(Math.max(value, 0), list));

  const price = round2(Math.max(list - off, 0));
  const saved = round2(list - price);
  // Rounding can eat a tiny discount whole. Then it is not a sale.
  if (saved <= 0) return none;

  return {
    price,
    listPrice: list,
    saved,
    percent: Math.round((saved / list) * 100),
    onSale: true,
  };
}

/**
 * A product's gender, guessed from what it is called.
 *
 * ── Used for SUGGESTIONS ONLY ───────────────────────────────────────────────
 * Never to write a value on its own. The shop has hundreds of products and
 * classifying them by hand is an evening's work, so the bulk screen reads each
 * name and proposes an answer for a person to glance down and correct. A guess
 * that writes itself into the live website is a guess nobody checks.
 *
 * The vocabulary is perfume counter vocabulary, in the three languages the
 * bottles themselves are printed in — English, French and Arabic — because that
 * is what is actually written on the shelf in this shop: "pour homme",
 * "for men", «رجالي», "sexy men", "femme", «حريمي». Matching is done on a
 * lower-cased, punctuation-stripped copy so "212 SEXY MEN!" and
 * "212-sexy-men" read the same.
 *
 * `unisex` wins when a name says so outright. Otherwise, when a name carries
 * both a masculine and a feminine marker — a gift set with two bottles in it —
 * the honest answer is "I do not know", which is `null`: the row keeps whatever
 * it already had and waits for a person.
 */
const WOMEN = [
  'women', 'woman', 'women s', 'for her', 'her', 'lady', 'ladies', 'female',
  'femme', 'pour femme', 'donna', 'mujer', 'girl',
  'حريمي', 'حريمى', 'نسائي', 'نسائى', 'للنساء', 'ستاتي', 'بناتي', 'وومن', 'وومان', 'فيم',
];
const MEN = [
  'men', 'man', 'men s', 'for him', 'him', 'male', 'homme', 'pour homme',
  'uomo', 'hombre', 'boy', 'gentleman',
  'رجالي', 'رجالى', 'للرجال', 'رجالة', 'مان', 'مين', 'اوم',
];
const UNISEX = [
  'unisex', 'uni sex', 'for all', 'shared',
  'للجنسين', 'يونيسكس', 'يوني سكس', 'للكل',
];

/** Lower-cased, punctuation flattened to spaces, Arabic diacritics dropped. */
function flatten(text) {
  return ` ${String(text || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

const mentions = (haystack, words) => words.some((word) => haystack.includes(` ${word} `));

export function suggestGender(...names) {
  const text = names.filter(Boolean).map(flatten).join(' ');
  if (!text.trim()) return null;
  if (mentions(text, UNISEX)) return 'unisex';
  const women = mentions(text, WOMEN);
  const men = mentions(text, MEN);
  if (women && men) return null; // a set with one of each — a person decides
  if (women) return 'women';
  if (men) return 'men';
  return null;
}

export default {
  GENDERS, DEFAULT_GENDER, isGender, DISCOUNT_TYPES, isDiscountType,
  offerRunning, offerPrice, suggestGender, today,
};
