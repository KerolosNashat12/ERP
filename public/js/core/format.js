/** Locale-aware formatting for money, numbers and dates. */
import { getLanguage, tCode } from './i18n.js';
import { session } from './store.js';

/**
 * Arabic uses the `-u-nu-latn` extension so figures stay in Latin digits.
 * Egyptian retail invoices, price labels and scanners all use Latin numerals,
 * and mixing Arabic-Indic digits into a printed receipt causes reading errors.
 */
const locale = () => (getLanguage() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');

export function money(value, { withSymbol = true } = {}) {
  const number = Number(value || 0);
  const formatted = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(number);
  if (!withSymbol) return formatted;
  const symbol = getLanguage() === 'ar'
    ? (session.settings?.['company.currency_symbol_ar'] || 'ج.م')
    : (session.settings?.['company.currency_symbol_en'] || 'EGP');
  return getLanguage() === 'ar' ? `${formatted} ${symbol}` : `${symbol} ${formatted}`;
}

export function number(value, decimals = 0) {
  return new Intl.NumberFormat(locale(), {
    minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, 3),
  }).format(Number(value || 0));
}

export function percent(value) {
  return `${number(value, 1)}%`;
}

/**
 * Photo and file sizes. Kilobytes up to a megabyte, because that is the range
 * staff are checking — "118 KB" tells them the compression worked, "0.1 MB"
 * does not.
 */
export function fileSize(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${number(size)} B`;
  if (size < 1024 * 1024) return `${number(Math.round(size / 1024))} KB`;
  return `${number(Math.round((size / (1024 * 1024)) * 10) / 10, 1)} MB`;
}

export function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: '2-digit' }).format(parsed);
}

export function dateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(parsed);
}

export const isoDate = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

export const daysAgoIso = (n) => isoDate(new Date(Date.now() - n * 86_400_000));

export const startOfMonthIso = () => `${isoDate().slice(0, 8)}01`;

/** Formats a value according to a report column type. */
export function byType(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    /*
     * A word the server chose from a fixed list, translated here. The server
     * must never send a sentence for a person to read: it does not know which
     * language this browser is in, and a report exported in Arabic with English
     * words down one column is how that mistake looks.
     */
    case 'code': return tCode(String(value), String(value));
    case 'money': return money(value);
    case 'number': return number(value, 0);
    case 'percent': return percent(value);
    case 'date': return date(value);
    case 'datetime': return dateTime(value);
    default: return String(value);
  }
}
