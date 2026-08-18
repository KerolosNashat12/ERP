/** Money and numbers, in whichever language is on screen. */
import { getLanguage } from './i18n.js';
import { shop } from './store.js';

/**
 * `-u-nu-latn` keeps Arabic figures in Latin digits. That is not a
 * simplification: Egyptian price tags, receipts and delivery slips are printed
 * in Latin numerals, and a customer reading ١٬٨٥٠ on the site and 1,850 on the
 * invoice has to stop and check they are the same number.
 */
const locale = () => (getLanguage() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-EG');

const symbol = () => (getLanguage() === 'ar'
  ? (shop.config?.currencySymbol?.ar || 'ج.م')
  : (shop.config?.currencySymbol?.en || 'EGP'));

/**
 * Prices are shown whole unless the piastres actually matter. A boutique price
 * tag reads "1,850 EGP", not "1,850.00 EGP", and the extra zeros make a grid of
 * prices harder to scan at a glance on a phone.
 */
export function money(value, { withSymbol = true } = {}) {
  const amount = Number(value || 0);
  const hasFraction = Math.abs(amount % 1) > 0.004;
  const formatted = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(amount);
  if (!withSymbol) return formatted;
  // The symbol trails the figure in Arabic and leads it in English, which is
  // how each language actually writes a price.
  return getLanguage() === 'ar' ? `${formatted} ${symbol()}` : `${symbol()} ${formatted}`;
}

/** "1,850" or "1,850 – 2,150" — one price or a range across variants. */
export function priceRange(from, to) {
  const low = Number(from || 0);
  const high = Number(to ?? from ?? 0);
  if (!(high > low)) return money(low);
  return `${money(low, { withSymbol: false })} – ${money(high)}`;
}

export function number(value) {
  return new Intl.NumberFormat(locale()).format(Number(value || 0));
}

export function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long', day: 'numeric' }).format(parsed);
}
