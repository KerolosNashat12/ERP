/**
 * Round 22: the day-rate schedule, attendance at pay time, and the paperwork.
 *
 * Three things, none of which touch a single existing row:
 *
 *  1. Five new columns on `employees` — a weekly work-day pattern, daily
 *     hours and an overtime rate — all nullable, all NULL on every employee
 *     that exists today. An employee with none of this set is exactly what
 *     this table looked like before this round, and `PayrollService.pay()`
 *     keeps paying him a flat amount per period exactly as it always did.
 *     The schedule only matters the moment somebody enters absence, lateness
 *     or overtime for a payment, and *that* refuses with a clear message
 *     rather than guessing — see `shared/payroll.js#dayRate`.
 *
 *  2. `left_on` on `employees` — deliberately separate from `is_active`
 *     rather than replacing it, so "closing" a person (leaving) sets both and
 *     every existing "active employees only" query keeps its old meaning.
 *
 *  3. `employee_documents`, a new table, plus six nullable columns on `costs`
 *     that hold the attendance arithmetic behind a salary payment when there
 *     is any — both already in `shared/costs.js` for a fresh install, carried
 *     to an existing database here the same way migration 022 carried the
 *     product-offer columns: `addColumn`, guarded, no CHECK (SQLite cannot add
 *     one to a live table — the service layer is the real gate, as it already
 *     is for `salary_period`).
 *
 * No permission grants here: employee documents are read and written under
 * the `employees.view` / `employees.update` codes that already exist —
 * managing somebody's paperwork is the same right as editing their record,
 * the same way a salary payment's photo is.
 */
export default {
  name: '034-employee-schedule-and-documents',

  async up({
    hasColumn, addColumn, hasTable, ddl, getDb,
  }) {
    // ---------------------------------------------------- employees: schedule
    if (!await hasColumn('employees', 'work_days')) {
      await addColumn('employees', 'work_days', 'TEXT');
    }
    if (!await hasColumn('employees', 'daily_hours')) {
      await addColumn('employees', 'daily_hours', 'REAL');
    }
    if (!await hasColumn('employees', 'overtime_rate_type')) {
      await addColumn('employees', 'overtime_rate_type', 'TEXT');
    }
    if (!await hasColumn('employees', 'overtime_rate_value')) {
      await addColumn('employees', 'overtime_rate_value', 'REAL');
    }
    if (!await hasColumn('employees', 'left_on')) {
      await addColumn('employees', 'left_on', 'TEXT');
    }

    // -------------------------------------------------------- costs: breakdown
    for (const column of [
      'gross_amount', 'absence_days', 'absence_deduction',
      'late_hours', 'late_deduction', 'overtime_hours', 'overtime_pay',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      if (!await hasColumn('costs', column)) {
        // eslint-disable-next-line no-await-in-loop
        await addColumn('costs', column, 'REAL');
      }
    }

    // -------------------------------------------------------- the paperwork
    if (!await hasTable('employee_documents')) {
      await ddl(`
        CREATE TABLE employee_documents (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id   INTEGER NOT NULL REFERENCES employees(id),
          doc_type      TEXT    NOT NULL CHECK (doc_type IN
                         ('id_card','photo','criminal_record','degree','medical_form','other')),
          label         TEXT,
          issued_on     TEXT,
          expires_on    TEXT,
          notes         TEXT,
          created_by    INTEGER REFERENCES users(id),
          created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `);
    }
    const db = getDb();
    await db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_employee_documents_employee ON employee_documents(employee_id)',
    ).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_employee_documents_expiry
        ON employee_documents(expires_on) WHERE expires_on IS NOT NULL
    `).run();
  },
};
