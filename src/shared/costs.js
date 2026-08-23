/**
 * What the shop spends, and the templates that repeat — defined once.
 *
 * Lives in `shared/` for the reason `attachments.js` and `supplierPayments.js`
 * do: `schema.js` is the shape a NEW database is created with, and a migration
 * has to carry an EXISTING one to it. Both import these strings, so the two can
 * never drift apart by a column.
 *
 * ── The four tables, and why there are four and not five ────────────────────
 *
 *   cost_categories   كهرباء، مياه، ضرايب، إيجار… Seeded bilingual, and the
 *                     owner adds his own: a hard-coded list is a list he
 *                     cannot extend, and every shop spends money on something
 *                     nobody thought of.
 *
 *   costs             One row per act of spending. This is the ledger the
 *                     reports subtract from profit, and it is the ONLY place
 *                     money-out-that-is-not-stock is stored.
 *
 *   recurring_costs   A TEMPLATE — rent, every month — not a cost. It writes
 *                     nothing on its own; see `dueOccurrences()` below and
 *                     CostService.generate for what turns one into rows, and
 *                     when.
 *
 *   employees         A name, a job, a phone, a salary and how often it is
 *                     paid. Deliberately NOT `users`: the delivery man has a
 *                     salary and no login, and a system that requires an
 *                     account before it will pay somebody is wrong about how a
 *                     shop works.
 *
 * There is no fifth table for salary payments, and that is the important
 * decision in this file. **A salary payment IS a cost row** — one with
 * `employee_id`, `period_start` and `period_end` filled in. A separate
 * `salary_payments` table mirrored into `costs` would be two rows for one
 * event: two things to keep in step, two places to edit, and a report that
 * double-counts the day somebody sums both. One row cannot be counted twice,
 * cannot drift from itself, and is edited in exactly one place no matter which
 * screen you opened it from.
 *
 * ── "A cost belongs to a branch" ────────────────────────────────────────────
 *
 * `warehouse_id`. In this system a "branch" is the `warehouses` row — the shop
 * location that stock, sales and purchase orders already point at. It is not a
 * tenant: tenants are separate DATABASES on the platform, so two of them can
 * never appear in one report and comparing them is the console's job, not this
 * one's. A single-shop install has exactly one location and every cost lands
 * on it; a shop that opens a second one starts comparing on the day it adds
 * the row, with no migration and no new column.
 */

/** Both the schema and migration 012 apply exactly this. */
export const COSTS_SQL = `
CREATE TABLE IF NOT EXISTS cost_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  name_en       TEXT    NOT NULL,
  name_ar       TEXT,
  -- 'salary' marks the one category payroll writes into. There is exactly one,
  -- it is seeded, and it cannot be deleted — the salary screen needs somewhere
  -- to put the money and must not have to invent it.
  kind          TEXT    NOT NULL DEFAULT 'general' CHECK (kind IN ('general','salary')),
  display_order INTEGER NOT NULL DEFAULT 100,
  is_system     INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cost_categories_order ON cost_categories(display_order, name_en);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  job_title     TEXT,
  phone         TEXT,
  salary_amount REAL    NOT NULL DEFAULT 0 CHECK (salary_amount >= 0),
  -- What the salary amount is FOR. A cleaner is paid by the day, a driver by
  -- the week, a shop assistant by the month, and the same number means three
  -- different things depending on which.
  salary_period TEXT    NOT NULL DEFAULT 'month' CHECK (salary_period IN ('day','week','month')),
  warehouse_id  INTEGER REFERENCES warehouses(id),
  hired_on      TEXT,
  notes         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(is_active, name);

CREATE TABLE IF NOT EXISTS recurring_costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES cost_categories(id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id),
  description   TEXT,
  amount        REAL    NOT NULL CHECK (amount > 0),
  payment_method TEXT   NOT NULL DEFAULT 'cash',
  -- 1–31, clamped to the length of each month when the date is computed, so a
  -- rent due "on the 31st" lands on the 28th of February rather than nowhere.
  day_of_month  INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on     TEXT    NOT NULL,
  ends_on       TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  stopped_at    TEXT,
  stopped_by    INTEGER REFERENCES users(id),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_costs(is_active, starts_on);

CREATE TABLE IF NOT EXISTS costs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id    INTEGER NOT NULL REFERENCES cost_categories(id),
  warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id),   -- the branch
  spent_on       TEXT    NOT NULL,                             -- YYYY-MM-DD
  amount         REAL    NOT NULL CHECK (amount > 0),
  description    TEXT,
  reference      TEXT,                                         -- meter number, receipt number
  payment_method TEXT    NOT NULL DEFAULT 'cash',
  source         TEXT    NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','recurring','salary')),
  recurring_id   INTEGER REFERENCES recurring_costs(id) ON DELETE SET NULL,
  -- 'YYYY-MM': which month of the template this row IS. Paired with the unique
  -- index below, this is what makes generating twice produce one row and not
  -- two — the database refuses the second, so no amount of retrying, no second
  -- tab and no overlapping request can post the same month again.
  period_key     TEXT,
  -- A salary payment is a cost row. These three say whose, and for when.
  employee_id    INTEGER REFERENCES employees(id),
  period_start   TEXT,
  period_end     TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_costs_date     ON costs(spent_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_costs_category ON costs(category_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_costs_branch   ON costs(warehouse_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_costs_employee ON costs(employee_id, period_end DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_costs_recurring_period
  ON costs(recurring_id, period_key) WHERE recurring_id IS NOT NULL AND period_key IS NOT NULL
`;

/**
 * The categories a shop starts with, in both languages.
 *
 * Seeded, not hard-coded: they are ordinary rows, so the owner renames them,
 * hides the ones he does not use and adds his own. Only the salary one is
 * `is_system` — payroll needs a category to write into and must not be able to
 * lose it.
 */
export const COST_CATEGORY_SEED = [
  { code: 'RENT', name_en: 'Rent', name_ar: 'إيجار', kind: 'general', is_system: 0 },
  { code: 'ELECTRICITY', name_en: 'Electricity', name_ar: 'كهرباء', kind: 'general', is_system: 0 },
  { code: 'WATER', name_en: 'Water', name_ar: 'مياه', kind: 'general', is_system: 0 },
  { code: 'TAXES', name_en: 'Taxes', name_ar: 'ضرايب', kind: 'general', is_system: 0 },
  { code: 'SALARIES', name_en: 'Salaries', name_ar: 'مرتبات', kind: 'salary', is_system: 1 },
  { code: 'EQUIPMENT', name_en: 'Equipment', name_ar: 'معدات', kind: 'general', is_system: 0 },
  { code: 'MAINTENANCE', name_en: 'Maintenance', name_ar: 'صيانة', kind: 'general', is_system: 0 },
  { code: 'TELECOM', name_en: 'Internet & phone', name_ar: 'إنترنت وتليفون', kind: 'general', is_system: 0 },
  { code: 'TRANSPORT', name_en: 'Transport & shipping', name_ar: 'مواصلات وشحن', kind: 'general', is_system: 0 },
  { code: 'SUPPLIES', name_en: 'Shop supplies', name_ar: 'مستلزمات المحل', kind: 'general', is_system: 0 },
  { code: 'MARKETING', name_en: 'Marketing', name_ar: 'دعاية وإعلان', kind: 'general', is_system: 0 },
  { code: 'OTHER', name_en: 'Other', name_ar: 'مصاريف أخرى', kind: 'general', is_system: 0 },
].map((row, index) => ({ ...row, display_order: (index + 1) * 10 }));

/** The one category payroll writes into. */
export const SALARY_CATEGORY_CODE = 'SALARIES';

// ---------------------------------------------------------------- recurrence

/** 'YYYY-MM' — the identity of one occurrence of a monthly template. */
export const monthKey = (iso) => String(iso || '').slice(0, 7);

/** Days in a given month, so a "31st" template survives February. */
export const daysInMonth = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/** The day a template falls due in one month, clamped to that month's length. */
export const occurrenceDate = (key, dayOfMonth) => {
  const day = Math.min(Math.max(Number(dayOfMonth) || 1, 1), daysInMonth(key));
  return `${key}-${String(day).padStart(2, '0')}`;
};

/** The month after `key`. */
export const nextMonthKey = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
};

/**
 * How far back a template will ever look, in months.
 *
 * Nobody away for six weeks meets this. It is the guard against a template
 * dated three years ago that nobody generated: the answer to that is not 36
 * rows dumped into the ledger at once, it is the oldest 24 offered, posted,
 * and the rest offered on the next pass — a list a person can still read.
 */
export const MAX_CATCH_UP_MONTHS = 24;

/**
 * The months this template owes an entry for and has not been given one.
 *
 * Pure: it reads a template, a date and the set of months already posted, and
 * returns what is missing. It never writes, and NOTHING in this system writes
 * a cost off a template without a person pressing something — see
 * CostService.generate. A recurring cost that quietly invents entries nobody
 * checked is worse than typing rent in every month.
 *
 * Six weeks away therefore looks like this: the shop opens the costs screen
 * and the months it missed are waiting at the top, each with its date and the
 * amount the template currently says, to confirm one at a time or all at once.
 * Nothing was posted while nobody was looking, and nothing was skipped either.
 *
 * @param {object} template   a recurring_costs row
 * @param {object} options
 * @param {string} options.asOf      today, YYYY-MM-DD
 * @param {Iterable<string>} options.posted  period_keys this template already has
 */
export function dueOccurrences(template, { asOf, posted = [], maxMonths = MAX_CATCH_UP_MONTHS } = {}) {
  if (!template || !template.is_active) return [];
  const already = new Set(posted);
  const today = String(asOf || new Date().toISOString().slice(0, 10));
  const out = [];

  let key = monthKey(template.starts_on);
  const lastKey = monthKey(template.ends_on && template.ends_on < today ? template.ends_on : today);

  // A bounded walk: at most one iteration per month between the start and
  // today, and it stops at `maxMonths` findings.
  let guard = 0;
  while (key <= lastKey && out.length < maxMonths && guard < 600) {
    guard += 1;
    const dueOn = occurrenceDate(key, template.day_of_month);
    const withinWindow = dueOn >= String(template.starts_on)
      && (!template.ends_on || dueOn <= String(template.ends_on))
      && dueOn <= today;
    if (withinWindow && !already.has(key)) {
      out.push({
        recurring_id: template.id,
        period_key: key,
        due_on: dueOn,
        amount: Number(template.amount),
      });
    }
    key = nextMonthKey(key);
  }
  return out;
}

export default { COSTS_SQL, COST_CATEGORY_SEED, SALARY_CATEGORY_CODE, dueOccurrences };
