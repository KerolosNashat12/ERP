/**
 * A repeating cost can repeat weekly, daily or yearly — not only monthly.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The owner, looking at «إضافة تكلفة متكررة»: *"can you please enhance this
 * function to be have a type (Monthly - weekly - and so on)"*. The dialog only
 * ever asked «يوم الشهر», because the engine behind it stepped one month at a
 * time and keyed each entry `YYYY-MM`. A shop pays rent monthly, a cleaner
 * weekly, a licence yearly, and petrol daily; one of those four was supported.
 *
 * ── What each column is for ─────────────────────────────────────────────────
 *   frequency      'daily' | 'weekly' | 'monthly' | 'yearly'
 *   day_of_week    WEEKLY only — 0 Sunday … 6 Saturday
 *   month_of_year  YEARLY only — 1–12, paired with the existing day_of_month
 *
 * ── No CHECK constraint on `frequency`, on purpose ──────────────────────────
 * SQLite would accept one here. It is still wrong: a CHECK on a live table
 * cannot gain a new value without rebuilding the table under a trading shop —
 * this project has already paid for that lesson once, with `exchange_credit`
 * and `sale_payments.method`. A fifth frequency later (quarterly, "every N
 * weeks") is then a table rebuild instead of one line. The list lives in
 * `FREQUENCIES` in `src/shared/costs.js`, `normalizeFrequency` is the only way
 * in, and both the server validator and the browser's picker read it.
 *
 * ── Templates that already exist ────────────────────────────────────────────
 * They get `frequency = 'monthly'` from the DEFAULT and two NULLs, which is
 * exactly what they already were. Nothing about them changes: their day of the
 * month is untouched, their `YYYY-MM` period keys keep the shape every entry
 * they have ever posted carries, and not one of those entries looks unposted
 * afterwards — which is the whole reason monthly's key was left alone rather
 * than tidied into the new scheme.
 *
 * The one behaviour that does change for them: catch-up is 12 occurrences
 * rather than 24. Nothing is lost — the thirteenth is offered the moment the
 * twelfth is posted — and it is the owner's own choice, made when he was asked
 * how far back a repeat should be able to catch up.
 */
export default {
  name: '030-recurring-cost-frequency',

  async up({ hasColumn, addColumn }) {
    if (!(await hasColumn('recurring_costs', 'frequency'))) {
      await addColumn('recurring_costs', 'frequency', "TEXT NOT NULL DEFAULT 'monthly'");
    }
    if (!(await hasColumn('recurring_costs', 'day_of_week'))) {
      await addColumn('recurring_costs', 'day_of_week', 'INTEGER');
    }
    if (!(await hasColumn('recurring_costs', 'month_of_year'))) {
      await addColumn('recurring_costs', 'month_of_year', 'INTEGER');
    }
  },
};
