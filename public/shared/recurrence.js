/**
 * WHEN A REPEATING COST COMES ROUND — the one copy, read by both sides.
 *
 * This lives in `public/shared/` rather than `src/shared/` for the reason
 * `photoFilename.js` and `searchText.js` do: the SERVER computes what a
 * template owes, and the BROWSER labels the picker and the list with the same
 * vocabulary. A rule written twice diverges within a month, and the symptom
 * here would be a form offering a frequency the engine has never heard of, or
 * a list captioned "every month" beside a cost that arrives every Friday.
 *
 * `src/shared/costs.js` re-exports all of it, so the server keeps importing
 * costs from where it always has. The SQL stays there — a browser has no use
 * for a CREATE TABLE.
 */
// ---------------------------------------------------------------- recurrence

/**
 * HOW OFTEN A TEMPLATE REPEATS.
 *
 * The engine below was monthly to its bones — a `YYYY-MM` key, a day of the
 * month, and a walk that stepped one month at a time. The owner asked for the
 * others: «enhance this function to be have a type (Monthly - weekly - and so
 * on)». Four are built. What each one needs to be pinned to a calendar differs,
 * and that is the whole of the difference between them:
 *
 *   daily     nothing. Every day from the start date.
 *   weekly    a DAY OF THE WEEK. "Every Sunday", not "every 7 days from
 *             whenever I happened to create this", because a shop thinks in
 *             days of the week and a drifting weekday is a bug nobody can name.
 *   monthly   a DAY OF THE MONTH, clamped — unchanged, including its key.
 *   yearly    a day AND a month: a licence renewed every March.
 *
 * ── There is deliberately no CHECK constraint on this column ────────────────
 *
 * It is tempting, and it is a trap this project has already been caught by
 * once: a CHECK on a live table cannot gain a new value without rebuilding the
 * table under a trading shop. A fifth frequency — quarterly, "every N weeks" —
 * would then be a table rebuild rather than one line here. The list lives in
 * `FREQUENCIES`, `normalizeFrequency` is the only door into it, and the server
 * validator and the browser's picker both read it, so an unknown value cannot
 * arrive from outside and an old row with a NULL reads as monthly.
 */
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'];
export const DEFAULT_FREQUENCY = 'monthly';

/**
 * Any input to one of the four, or to monthly.
 *
 * Monthly is the fallback on purpose: every template that existed before this
 * column did is monthly, and a row whose frequency somehow went missing should
 * keep behaving exactly as it did rather than start firing every day.
 */
export const normalizeFrequency = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return FREQUENCIES.includes(key) ? key : DEFAULT_FREQUENCY;
};

/**
 * HOW FAR BACK A TEMPLATE WILL EVER CATCH UP, per frequency.
 *
 * About a year each, which is the owner's own choice. It is not a limit on
 * what gets recorded — it is a limit on how much is offered AT ONCE. The
 * oldest are offered first; posting them makes room for the next batch on the
 * following pass, so nothing is ever lost, only queued.
 *
 * The reason there is a cap at all: a template dated three years ago that
 * nobody generated should not dump a thousand rows into the ledger, and a list
 * of a thousand confirmations is not a list anybody reads. Twelve is a page.
 *
 * (Monthly was 24 before this and is 12 now — same rule as the rest, and the
 * thirteenth month is offered the moment the twelfth is posted.)
 */
export const CATCH_UP = {
  daily: 366,
  weekly: 53,
  monthly: 12,
  yearly: 2,
};

/**
 * The most steps the walk below will ever take.
 *
 * The walk starts at the template's own start date, so a DAILY template that
 * has been running for years steps once per day through the ones already
 * posted before it finds anything to offer. That is string arithmetic against
 * a Set and costs nothing measurable, but it must still be bounded: this is
 * about eleven years of days, and a template older than that stops rather than
 * spins.
 */
const MAX_STEPS = 4000;

const DAY_MS = 86_400_000;
const utc = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Whether a value was actually given, as opposed to being absent.
 *
 * `null`, `undefined` and `''` all become a NUMBER when passed to `Number()` —
 * 0, NaN and 0 — and 0 is a meaningful weekday. Absence has to be tested for
 * before the value is coerced, never after.
 */
const said = (value) => value !== null && value !== undefined && value !== '';

/** 'YYYY-MM' — the identity of one occurrence of a MONTHLY template. */
export const monthKey = (value) => String(value || '').slice(0, 7);

/** Days in a given month, so a "31st" template survives February. */
export const daysInMonth = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/** The day a monthly template falls due in one month, clamped to its length. */
export const occurrenceDate = (key, dayOfMonth) => {
  const day = Math.min(Math.max(Number(dayOfMonth) || 1, 1), daysInMonth(key));
  return `${key}-${String(day).padStart(2, '0')}`;
};

/** The month after `key`. */
export const nextMonthKey = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
};

/** One day of one month of one year, clamped the same way a month is. */
const yearlyDate = (year, month, dayOfMonth) =>
  occurrenceDate(`${year}-${String(month).padStart(2, '0')}`, dayOfMonth);

/**
 * The weekday a weekly template lands on: 0 Sunday … 6 Saturday.
 *
 * Falls back to the weekday of the start date, so a template saved before this
 * column existed — or by an API caller who sent only a frequency — still has
 * an answer, and it is the one the person who typed that date would expect.
 */
export const weekdayOf = (template) => {
  /*
   * `said()` rather than a bare `Number()`, and this is not fussiness: 0 is
   * SUNDAY and `Number(null)` is also 0. Reading the column with `Number()`
   * alone turns "no weekday saved" into a confident Sunday — so a weekly
   * template created through the API without one would repeat every Sunday
   * instead of on the day its own start date falls. The test beside this one
   * exists because that is exactly what the first version of this did.
   */
  if (said(template?.day_of_week)) {
    const value = Number(template.day_of_week);
    if (Number.isInteger(value) && value >= 0 && value <= 6) return value;
  }
  return new Date(utc(template?.starts_on || '2000-01-01')).getUTCDay();
};

/** The month a yearly template lands in: 1–12, defaulting to the start's own. */
export const monthOf = (template) => {
  if (said(template?.month_of_year)) {
    const value = Number(template.month_of_year);
    if (Number.isInteger(value) && value >= 1 && value <= 12) return value;
  }
  return Number(String(template?.starts_on || '2000-01-01').slice(5, 7)) || 1;
};

/**
 * THE IDENTITY OF ONE OCCURRENCE — what makes posting twice impossible.
 *
 * Paired with the unique index on `(recurring_id, period_key)`, this string is
 * the whole duplicate guard: the database refuses the second row for the same
 * occurrence, so no amount of retrying, no second tab and no two overlapping
 * requests can post one week's rent twice.
 *
 * **Monthly keeps `YYYY-MM` exactly.** That is not a preference, it is a
 * requirement: every entry every existing template has already posted carries
 * that key, and changing the shape would make every one of them look unposted
 * and offer the whole history again. The others take shapes that cannot
 * collide with it or with each other — a date for daily and weekly, where the
 * date IS the occurrence, and a bare year for yearly.
 */
export const periodKeyFor = (frequency, dueOn) => {
  switch (normalizeFrequency(frequency)) {
    case 'daily':
    case 'weekly':
      return String(dueOn);
    case 'yearly':
      return String(dueOn).slice(0, 4);
    default:
      return String(dueOn).slice(0, 7);
  }
};

/** Every shape `periodKeyFor` can produce, for validating one off the wire. */
export const PERIOD_KEY_PATTERN = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** The first date on or after `starts_on` that this template actually falls on. */
export const firstDueOn = (template) => {
  const start = String(template.starts_on);
  switch (normalizeFrequency(template.frequency)) {
    case 'daily':
      return start;
    case 'weekly': {
      // Forward to the wanted weekday. `% 7` is 0 when the start date already
      // IS that day, so a template created on the day it repeats starts today
      // rather than in a week.
      const shift = (weekdayOf(template) - new Date(utc(start)).getUTCDay() + 7) % 7;
      return iso(utc(start) + shift * DAY_MS);
    }
    case 'yearly': {
      const month = monthOf(template);
      const year = Number(start.slice(0, 4));
      const here = yearlyDate(year, month, template.day_of_month);
      return here >= start ? here : yearlyDate(year + 1, month, template.day_of_month);
    }
    default: {
      const here = occurrenceDate(monthKey(start), template.day_of_month);
      return here >= start ? here : occurrenceDate(nextMonthKey(monthKey(start)), template.day_of_month);
    }
  }
};

/** The next date after `dueOn`, for the same template. */
export const nextDueOn = (template, dueOn) => {
  switch (normalizeFrequency(template.frequency)) {
    case 'daily':
      return iso(utc(dueOn) + DAY_MS);
    case 'weekly':
      return iso(utc(dueOn) + 7 * DAY_MS);
    case 'yearly':
      return yearlyDate(Number(String(dueOn).slice(0, 4)) + 1, monthOf(template), template.day_of_month);
    default:
      // From the month it landed in, not from the start date: this is what
      // makes a "31st" template come back to the 31st in March after being
      // clamped to the 28th in February.
      return occurrenceDate(nextMonthKey(monthKey(dueOn)), template.day_of_month);
  }
};

/** Kept for callers that still ask in months; monthly's own cap. */
export const MAX_CATCH_UP_MONTHS = CATCH_UP.monthly;

/**
 * The occurrences this template owes an entry for and has not been given one.
 *
 * Pure: it reads a template, a date and the set of keys already posted, and
 * returns what is missing. It never writes, and NOTHING in this system writes
 * a cost off a template without a person pressing something — see
 * CostService.generate. A recurring cost that quietly invents entries nobody
 * checked is worse than typing rent in every month.
 *
 * Six weeks away therefore looks like this: the shop opens the costs screen
 * and what it missed is waiting at the top, each with its date and the amount
 * the template currently says, to confirm one at a time or all at once.
 * Nothing was posted while nobody was looking, and nothing was skipped either.
 *
 * @param {object} template   a recurring_costs row
 * @param {object} options
 * @param {string} options.asOf      today, YYYY-MM-DD
 * @param {Iterable<string>} options.posted  period_keys this template already has
 * @param {number} [options.max]     override the per-frequency cap
 */
export function dueOccurrences(template, { asOf, posted = [], max = null } = {}) {
  if (!template || !template.is_active) return [];
  const frequency = normalizeFrequency(template.frequency);
  const already = new Set(posted);
  const today = String(asOf || new Date().toISOString().slice(0, 10));
  const limit = Number(max) > 0 ? Number(max) : CATCH_UP[frequency];

  // Never past today, and never past the end date if the owner set one.
  const last = template.ends_on && String(template.ends_on) < today ? String(template.ends_on) : today;

  const out = [];
  let dueOn = firstDueOn(template);
  let steps = 0;
  while (dueOn <= last && out.length < limit && steps < MAX_STEPS) {
    steps += 1;
    const key = periodKeyFor(frequency, dueOn);
    if (!already.has(key)) {
      out.push({
        recurring_id: template.id,
        period_key: key,
        due_on: dueOn,
        amount: Number(template.amount),
        frequency,
      });
    }
    dueOn = nextDueOn(template, dueOn);
  }
  return out;
}
