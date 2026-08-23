/**
 * Money, numbers and dates, formatted the way the ERP formats them.
 *
 * The console and the shop it manages are read by the same person minutes
 * apart, so `12,480.00` must not become `١٢٬٤٨٠٫٠٠` on one screen and not the
 * other. `-u-nu-latn` is the ERP's own choice (public/js/core/format.js) and is
 * kept here byte for byte: Egyptian retail reads Latin digits, on invoices, on
 * price labels and on this console.
 *
 * Currency is never assumed. Every figure that came out of a shop is formatted
 * with that shop's own currency code, and the fleet totals with the code the
 * server said they were summed in.
 */
import { getLanguage } from '../core/i18n.js';

export const locale = () => (getLanguage() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');

const DASH = '—';

/** A number with thousands separators. `int(1234)` -> "1,234". */
export function int(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return DASH;
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(value));
}

export function decimal(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return DASH;
  return new Intl.NumberFormat(locale(), {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Number(value));
}

/**
 * The symbol an Egyptian shop actually writes, rather than the one the ICU
 * data picks: `Intl`'s narrow symbol for EGP is "E£", which appears on no
 * price tag in the country and on no screen in this ERP. The ERP's own
 * settings default to "EGP" in English and "ج.م" in Arabic, and the console
 * says the same. Anything not on this list keeps its ISO code, which is
 * always right and never wrong-looking.
 */
const SYMBOLS = {
  EGP: { en: 'EGP', ar: 'ج.م' },
  USD: { en: '$', ar: '$' },
  EUR: { en: '€', ar: '€' },
  GBP: { en: '£', ar: '£' },
  SAR: { en: 'SAR', ar: 'ر.س' },
  AED: { en: 'AED', ar: 'د.إ' },
  KWD: { en: 'KWD', ar: 'د.ك' },
};

function currencyFormat(value, currency, digits) {
  const code = String(currency || 'EGP').toUpperCase();
  const arabic = getLanguage() === 'ar';
  const symbol = SYMBOLS[code]?.[arabic ? 'ar' : 'en'] || code;
  const figure = decimal(value, digits);
  // Symbol trails the figure in Arabic and leads it in English, exactly as the
  // ERP's own `money()` does — the same number on two screens, written once.
  return arabic ? `${figure} ${symbol}` : `${symbol} ${figure}`;
}

/** Money as it appears in a table or a readout: two decimals, always. */
export function money(value, currency = 'EGP') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return DASH;
  return currencyFormat(value, currency, 2);
}

/**
 * Money in a KPI tile. Whole units only — the tile is read across the room and
 * the piastres are noise there. The exact figure goes in the tile's `title`,
 * and the table underneath carries it to the decimal.
 */
export function moneyBig(value, currency = 'EGP') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return DASH;
  return currencyFormat(value, currency, 0);
}

/** Axis labels: 0, 1.2k, 84k, 1.4M. No currency — the axis is already labelled. */
export function compact(value) {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  const fmt = (v, d) => new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 0, maximumFractionDigits: d,
  }).format(v);
  if (abs >= 1_000_000) return `${fmt(n / 1_000_000, 1)}M`;
  if (abs >= 10_000) return `${fmt(Math.round(n / 1000), 0)}k`;
  if (abs >= 1000) return `${fmt(n / 1000, 1)}k`;
  return fmt(n, 0);
}

/**
 * A file size, in the unit that makes the figure readable. A backup is shown to
 * somebody deciding whether to download it over a phone connection, so "24 MB"
 * is the answer and "25165824" is not.
 */
export function bytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024) return `${int(n)} B`;
  if (n < 1024 * 1024) return `${decimal(n / 1024, n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${decimal(n / 1048576, n < 10485760 ? 1 : 0)} MB`;
  return `${decimal(n / 1073741824, 2)} GB`;
}

export function percent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return DASH;
  return `${decimal(value, digits)}%`;
}

const parse = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "12 Aug" — the x axis and the chart readout. */
export function dayShort(value) {
  const d = parse(value);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(d);
}

export function date(value) {
  const d = parse(value);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: '2-digit' }).format(d);
}

export function dateTime(value) {
  const d = parse(value);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function timeOfDay(value = new Date()) {
  const d = parse(value) || new Date();
  return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(d);
}

/**
 * "3 hours ago", "منذ ٣ ساعات". The owner scans this column for the shop that
 * has gone quiet, so the unit matters more than the precision.
 */
export function relative(value) {
  const d = parse(value);
  if (!d) return null;
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 2_592_000) return rtf.format(Math.round(seconds / 86_400), 'day');
  if (abs < 31_536_000) return rtf.format(Math.round(seconds / 2_592_000), 'month');
  return rtf.format(Math.round(seconds / 31_536_000), 'year');
}

export { DASH };

export default {
  locale, int, decimal, money, moneyBig, compact, bytes, percent, dayShort, date, dateTime, timeOfDay, relative, DASH,
};
