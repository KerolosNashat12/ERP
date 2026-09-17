/**
 * Day, week, month — the arithmetic of what a salary period actually is.
 *
 * The owner's decision was "an amount and a period: day, week or month". That
 * sounds like a label until somebody has to answer "he was paid up to the 15th,
 * what is the next period?" — and then it is arithmetic, and it is the kind of
 * arithmetic that is quietly wrong for a year. A week is seven days INCLUSIVE
 * (Sunday to Saturday is one week, not eight days), and a month is a calendar
 * month, so a period starting on the 31st of January ends on the 27th of
 * February and not on some invented 31st.
 *
 * Everything here is pure and works on `YYYY-MM-DD` strings in UTC, which is
 * how every other date in this system is stored. No `Date` arithmetic leaks out
 * of this file, so nothing above it can be caught by a timezone at midnight.
 *
 * Attendance arrived in a later round — `parseWorkDays`, `workingDaysInMonth`
 * and `dayRate` below — and it is still the smallest honest model of the new
 * question, "what is one day of this salary worth": the monthly equivalent of
 * whatever the employee is paid, divided by however many of THEIR configured
 * work days fall in the calendar month a period starts in. An employee with
 * no schedule configured has no day rate — `null`, not a guess — and
 * `PayrollService.pay()` refuses to compute absence, lateness or overtime
 * without one rather than inventing a number nobody configured.
 */

export const SALARY_PERIODS = ['day', 'week', 'month'];

export const isSalaryPeriod = (value) => SALARY_PERIODS.includes(String(value));

const toParts = (iso) => String(iso).slice(0, 10).split('-').map(Number);
const toUtc = (iso) => {
  const [y, m, d] = toParts(iso);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

/** `iso` shifted by whole days. */
export const addDays = (iso, days) => fromUtc(toUtc(iso) + days * 86_400_000);

/**
 * `iso` shifted by whole months, clamped to the length of the target month.
 * 2026-01-31 + 1 month is 2026-02-28, because there is no 31st of February and
 * silently rolling into March is how a payroll pays somebody twice.
 */
export function addMonths(iso, months) {
  const [year, month, day] = toParts(iso);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
}

/**
 * The last day covered by one period that starts on `start`. INCLUSIVE — it is
 * the day written on the payslip, not the day after.
 *
 *   day    2026-03-09 -> 2026-03-09   (one day is one day)
 *   week   2026-03-09 -> 2026-03-15   (seven days including the first)
 *   month  2026-01-31 -> 2026-02-27   (a calendar month, minus a day)
 */
export function periodEnd(start, period) {
  switch (period) {
    case 'day': return String(start).slice(0, 10);
    case 'week': return addDays(start, 6);
    case 'month': return addDays(addMonths(start, 1), -1);
    default: throw new Error(`Unknown salary period "${period}"`);
  }
}

/** The first day of the period after the one that starts on `start`. */
export const nextPeriodStart = (start, period) => addDays(periodEnd(start, period), 1);

/** `{ start, end }` for the period beginning on `start`. */
export const periodRange = (start, period) => ({
  start: String(start).slice(0, 10),
  end: periodEnd(start, period),
});

/**
 * How many COMPLETE periods fit between `from` and `to` inclusive.
 *
 * Complete is the word that matters: a man paid by the month who started on the
 * 1st and is asked on the 20th is owed nothing yet, not two thirds of a salary.
 * A shop pays for periods that have finished; part-periods are a conversation
 * between two people, not a number this system should invent.
 */
export function completePeriods(from, to, period) {
  if (!from || !to) return 0;
  let count = 0;
  let start = String(from).slice(0, 10);
  let guard = 0;
  while (guard < 4000) {
    guard += 1;
    const end = periodEnd(start, period);
    if (end > String(to).slice(0, 10)) break;
    count += 1;
    start = addDays(end, 1);
  }
  return count;
}

/**
 * The period a payment should default to: the one starting the day after the
 * last period this employee was paid for, or the day they were hired.
 *
 * Returns the period even when it has not finished yet — the screen shows the
 * dates and the person can change them. This is a suggestion, not a rule.
 */
export function nextUnpaidPeriod({ period, lastPaidEnd = null, hiredOn = null, today }) {
  const start = lastPaidEnd
    ? addDays(lastPaidEnd, 1)
    : (hiredOn ? String(hiredOn).slice(0, 10) : String(today).slice(0, 10));
  return periodRange(start, period);
}

/**
 * A day-rate and a month-rate compared honestly — the same arithmetic the
 * wage-bill tile in `PayrollService#roster` uses, pulled out here so the
 * day-rate computation below can share it instead of guessing its own.
 */
export function monthlyEquivalent(amount, period) {
  const n = Number(amount) || 0;
  if (period === 'day') return n * 30;
  if (period === 'week') return (n * 52) / 12;
  return n;
}

/**
 * `'0,1,2,3,4'` -> `[0, 1, 2, 3, 4]`, or `null` for anything that is not a
 * real set of weekdays — blank, garbage, or simply never configured. `null`
 * here is what tells a caller "this employee has no schedule" rather than
 * "this employee works zero days a week", which a bare `[]` would read as.
 */
export function parseWorkDays(value) {
  if (value === null || value === undefined || value === '') return null;
  const days = [...new Set(
    String(value).split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  )].sort((a, b) => a - b);
  return days.length ? days : null;
}

/** The canonical stored form of a work-day set — sorted, deduplicated, comma-joined. */
export const formatWorkDays = (days) => (
  Array.isArray(days) && days.length ? [...new Set(days)].sort((a, b) => a - b).join(',') : null
);

/**
 * A set of absence dates given as an array or a comma-joined string, parsed
 * into a canonical sorted, deduplicated array of `YYYY-MM-DD` strings — the
 * same "canonical stored form" idea as `formatWorkDays`, so the same list
 * typed in a different order or with a date repeated always lands the same
 * way in the database. `null` for anything empty (nothing entered).
 *
 * Throws on anything that isn't a real calendar date (`2026-02-30`, a typo, a
 * non-date string) rather than silently dropping it — a swallowed absence
 * date is a paycheck that is quietly wrong.
 */
export function parseAbsenceDates(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const dates = raw.map((v) => String(v).trim()).filter(Boolean);
  if (!dates.length) return null;
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || fromUtc(toUtc(d)) !== d) {
      throw new Error(`"${d}" is not a valid date`);
    }
  }
  return [...new Set(dates)].sort();
}

/** The canonical stored form of an absence-date set — sorted, deduplicated, comma-joined. */
export const formatAbsenceDates = (dates) => (
  Array.isArray(dates) && dates.length ? [...new Set(dates)].sort().join(',') : null
);

/**
 * How many of `workDays` fall inside the calendar month `isoDate` sits in.
 * "من الاحد للخميس" for March 2026 is 22 — not a flat "5 × 4 weeks", because
 * months are not four weeks long and a shop's day rate should not be a
 * fraction out every month that has a fifth Sunday.
 */
export function workingDaysInMonth(workDays, isoDate) {
  const [year, month] = String(isoDate).slice(0, 10).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (workDays.includes(weekday)) count += 1;
  }
  return count;
}

/**
 * One day of this employee's salary, in the calendar month `periodStart`
 * falls in — or `null` when there is nothing to divide by: no work-day
 * schedule configured, or (in principle, never in practice) a month with none
 * of the configured days in it. `null` is the honest answer and the caller's
 * job to refuse on, not a value to fall back from.
 */
export function dayRate(employee, periodStart) {
  const workDays = parseWorkDays(employee?.work_days);
  if (!workDays) return null;
  const days = workingDaysInMonth(workDays, periodStart);
  if (!days) return null;
  return monthlyEquivalent(employee?.salary_amount, employee?.salary_period) / days;
}

export default {
  SALARY_PERIODS, isSalaryPeriod, addDays, addMonths, periodEnd, nextPeriodStart,
  periodRange, completePeriods, nextUnpaidPeriod, monthlyEquivalent,
  parseWorkDays, formatWorkDays, workingDaysInMonth, dayRate,
  parseAbsenceDates, formatAbsenceDates,
};
