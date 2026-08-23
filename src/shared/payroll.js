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
 * Explicitly NOT here, because the owner ruled them out of this round:
 * attendance, overtime, absence, advances, deductions. What is here is the
 * smallest honest model of "he is paid X every Y" — and the door is left open:
 * a deduction, when it comes, is another row against the same period, not a
 * change to any of this.
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

export default {
  SALARY_PERIODS, isSalaryPeriod, addDays, addMonths, periodEnd, nextPeriodStart,
  periodRange, completePeriods, nextUnpaidPeriod,
};
