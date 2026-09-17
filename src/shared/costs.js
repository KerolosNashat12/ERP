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
  -- The day-rate schedule, all optional: an employee with none of this set is
  -- exactly what this table looked like before this round, and payroll works
  -- for him exactly as it always did — a flat amount per period, nothing more.
  -- 'work_days' is only meaningful once it is READ, so it is stored as the
  -- plainest thing that survives a CSV export and a hand edit: a
  -- comma-separated list of weekdays, 0 Sunday … 6 Saturday — 'الأحد للخميس'
  -- is '0,1,2,3,4'. Parsed by shared/payroll.js, never trusted raw.
  work_days           TEXT,
  daily_hours         REAL,
  -- Overtime is either a flat rate per hour ('fixed', overtime_rate_value in
  -- EGP) or a multiple of the employee's own derived hourly rate
  -- ('multiplier', e.g. 1.5) — the owner wanted both. Enforced in the service
  -- layer, not a CHECK: see the note on CHECK and live tables in migration 022.
  overtime_rate_type  TEXT,
  overtime_rate_value REAL,
  -- Set the day this employee left. NULL means still working here. Left
  -- deliberately separate from 'is_active' rather than replacing it: closing
  -- an employee sets both (is_active = 0 and left_on = that date) so every
  -- existing "active employees only" query keeps meaning what it always meant,
  -- while 'left_on' answers the one question 'is_active' cannot — since when.
  left_on       TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees(is_active, name);

-- بطاقة، صورة، فيش جنائي، شهادة جامعية، استمارة طبية، وغيرها — the paperwork a
-- shop keeps on file for each person. A separate table rather than columns on
-- 'employees', because there can be more than one of a kind (a renewed
-- criminal-record certificate should not erase the old one's history) and
-- because most employees will have none of this on day one. The photograph of
-- each document is an attachment — see AttachmentService's 'employee_document'
-- owner type — exactly the same mechanism a cost's bill photo uses.
CREATE TABLE IF NOT EXISTS employee_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id   INTEGER NOT NULL REFERENCES employees(id),
  doc_type      TEXT    NOT NULL CHECK (doc_type IN
                 ('id_card','photo','criminal_record','degree','medical_form','other')),
  -- Required (and shown) mainly for 'other' — a custom document needs a name
  -- to mean anything in a list, and the fixed types already have one: doc_type.
  label         TEXT,
  issued_on     TEXT,
  expires_on    TEXT,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id);
-- The renewal reminder reads this: every document with an expiry date at all,
-- ordered by how soon. Partial, because most documents (a photo, an ID scan)
-- never expire and have no business in this index.
CREATE INDEX IF NOT EXISTS idx_employee_documents_expiry
  ON employee_documents(expires_on) WHERE expires_on IS NOT NULL;

CREATE TABLE IF NOT EXISTS recurring_costs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER NOT NULL REFERENCES cost_categories(id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id),
  description   TEXT,
  amount        REAL    NOT NULL CHECK (amount > 0),
  payment_method TEXT   NOT NULL DEFAULT 'cash',
  -- How often this repeats: daily, weekly, monthly or yearly. Deliberately NO
  -- CHECK constraint - a CHECK on a live table cannot gain a new value without
  -- rebuilding the table under a trading shop, and a fifth frequency should be
  -- one line rather than an afternoon. FREQUENCIES and normalizeFrequency
  -- below are the guard, and an old row with no value reads as monthly.
  -- Added to existing databases by migration 030.
  frequency     TEXT    NOT NULL DEFAULT 'monthly',
  -- 1–31, clamped to the length of each month when the date is computed, so a
  -- rent due "on the 31st" lands on the 28th of February rather than nowhere.
  -- Used by MONTHLY and by YEARLY. The other two ignore it.
  day_of_month  INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  -- WEEKLY only: 0 Sunday … 6 Saturday. NULL elsewhere, and NULL on a weekly
  -- template reads as the weekday of its own start date.
  day_of_week   INTEGER,
  -- YEARLY only: 1–12, the month it falls in. NULL elsewhere, and NULL on a
  -- yearly template reads as the month of its own start date.
  month_of_year INTEGER,
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
  -- WHICH OCCURRENCE of the template this row IS. Its shape follows the
  -- template's frequency and is minted by periodKeyFor(): 'YYYY-MM-DD' for a
  -- daily or weekly one, 'YYYY-MM' for a monthly one, 'YYYY' for a yearly one.
  -- Paired with the unique index below, this is what makes generating twice
  -- produce one row and not two — the database refuses the second, so no
  -- amount of retrying, no second tab and no overlapping request can post the
  -- same occurrence again.
  period_key     TEXT,
  -- A salary payment is a cost row. These three say whose, and for when.
  employee_id    INTEGER REFERENCES employees(id),
  period_start   TEXT,
  period_end     TEXT,
  -- The attendance breakdown behind a salary payment's 'amount' — NULL on
  -- every other cost, and NULL on a salary payment too when nobody entered
  -- absence, lateness or overtime for it (the old, plain "he was handed X"
  -- payment keeps working exactly as before). 'amount' stays the single
  -- number every report sums — these six are only ever shown alongside it, on
  -- the payment itself, as the arithmetic that produced it.
  gross_amount      REAL,
  absence_days      REAL,
  absence_deduction REAL,
  late_hours        REAL,
  late_deduction    REAL,
  overtime_hours    REAL,
  overtime_pay      REAL,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_costs_date     ON costs(spent_on DESC, id DESC);
-- Every costs total in this system is bounded by date(spent_on) — the ledger
-- screen, the dashboard tile, and both lifetime reports — and date() wrapping
-- the column makes idx_costs_date above unusable for it. This is the
-- expression itself, with the amount carried so a month's total never leaves
-- the index: 0.83ms to 0.06ms for one month of a five-thousand-row ledger.
-- Added to existing databases by migration 016.
CREATE INDEX IF NOT EXISTS idx_costs_spent_day ON costs(date(spent_on), amount);
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

/*
 * The recurrence engine lives in `public/shared/recurrence.js` so the browser
 * can read the same rules — see the note at the top of that file. It is
 * re-exported here because everything on the server that thinks about costs
 * imports this module, and there is no reason to make each of them know where
 * the arithmetic happens to live.
 */
export {
  FREQUENCIES,
  DEFAULT_FREQUENCY,
  normalizeFrequency,
  CATCH_UP,
  MAX_CATCH_UP_MONTHS,
  monthKey,
  daysInMonth,
  occurrenceDate,
  nextMonthKey,
  weekdayOf,
  monthOf,
  periodKeyFor,
  PERIOD_KEY_PATTERN,
  firstDueOn,
  nextDueOn,
  dueOccurrences,
} from '../../public/shared/recurrence.js';

export default { COSTS_SQL, COST_CATEGORY_SEED, SALARY_CATEGORY_CODE };
