/**
 * الموظفين والمرتبات — the people the shop pays, and what it actually paid them.
 *
 * ── Why this is not `users` ─────────────────────────────────────────────────
 * The owner's decision, and it is the right one: a delivery man and a cleaner
 * have a salary and no login. Requiring a user account before somebody can be
 * paid would mean either inventing accounts for people who will never sign in,
 * or leaving them off the books. Two lists, on purpose. Nothing here touches
 * `users` and nothing here is a personal record beyond what a shop needs in
 * order to pay somebody: a name, a job, a phone, an amount, how often.
 *
 * ── Why this service owns almost nothing ────────────────────────────────────
 * **A salary payment is a cost row.** `pay()` calls `CostService.create()` and
 * that is the whole of it — there is no salary_payments table, no mirror, no
 * second amount to keep in step. Which answers the two questions the brief
 * asked directly:
 *
 *   · It cannot appear twice in a report, because there is only one row. Every
 *     cost total in this system is `SUM(costs.amount)` over a date range, and
 *     wages are inside it exactly once, next to the rent.
 *   · It cannot be editable in one screen and not the other, because both
 *     screens edit the same row through the same service and the same
 *     validation. Open it from the costs page or from the employee: same row,
 *     same rules, same audit entry.
 *
 * ── Attendance, arriving in a later round ───────────────────────────────────
 * Absence, lateness and overtime were ruled out of the first round and are in
 * this one, added the way the original note said they would be: another row
 * against the same employee and period, not a change to this model. A salary
 * payment is still one `costs` row — `pay()` below just works out what that
 * row's `amount` should be before writing it, from a day rate derived from the
 * employee's own configured work-day schedule (`shared/payroll.js#dayRate`).
 * An employee with no schedule configured has no day rate, and asking for
 * absence, lateness or overtime without one is refused rather than guessed.
 *
 * Advances remain out of scope: a payment against a period not yet finished is
 * still just `pay()` with a `period_start` in the future, so nothing here
 * needs to change for it to arrive later either.
 */
import repositories from '../infrastructure/repositories/index.js';
import { CrudService, referencedBy } from './CrudService.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import {
  SALARY_PERIODS, isSalaryPeriod, completePeriods, nextUnpaidPeriod, periodEnd, addDays,
  monthlyEquivalent, parseWorkDays, formatWorkDays, dayRate,
} from '../shared/payroll.js';
import costService from './CostService.js';
import attachmentService from './AttachmentService.js';

const today = () => new Date().toISOString().slice(0, 10);

export const OVERTIME_RATE_TYPES = ['fixed', 'multiplier'];

export class EmployeeService extends CrudService {
  constructor() {
    super({
      repository: repositories.employees,
      module: 'employees',
      entityType: 'employee',
      labelField: 'name',
      codePrefix: 'EMP',
      // Somebody who has been paid is never deleted, only deactivated: the
      // wages are in the costs ledger and in last month's profit, and a row
      // they point at has to keep existing to name them.
      isReferenced: referencedBy('costs', 'employee_id'),
    });
  }

  async beforeSave(data, existing = null) {
    const payload = { ...data };
    if (payload.salary_period !== undefined && !isSalaryPeriod(payload.salary_period)) {
      throw new ValidationError(`A salary period is one of: ${SALARY_PERIODS.join(', ')}`);
    }
    if (payload.salary_amount !== undefined && payload.salary_amount !== null) {
      payload.salary_amount = round2(Number(payload.salary_amount));
      if (payload.salary_amount < 0) throw new ValidationError('A salary cannot be negative');
    }

    // The schedule: which days he works, and how many hours on each. Stored
    // in its canonical form — parsed and re-joined — so 'e.g. "4,1,0,2,3"
    // typed once reads back sorted forever, and so a caller cannot store
    // '1,7' and have it silently mean something on the 8th weekday there
    // isn't one of.
    if (payload.work_days !== undefined) {
      const days = payload.work_days === null || payload.work_days === ''
        ? null : parseWorkDays(payload.work_days);
      if (payload.work_days && !days) {
        throw new ValidationError('Work days must be weekday numbers 0–6 (0 = Sunday), comma-separated');
      }
      payload.work_days = formatWorkDays(days);
    }
    if (payload.daily_hours !== undefined && payload.daily_hours !== null && payload.daily_hours !== '') {
      payload.daily_hours = round2(Number(payload.daily_hours));
      if (!(payload.daily_hours > 0) || payload.daily_hours > 24) {
        throw new ValidationError('Daily hours must be more than 0 and at most 24');
      }
    }

    // The overtime rate: a flat EGP/hour, or a multiple of the derived hourly
    // rate — the owner wanted both available, per employee.
    if (payload.overtime_rate_type !== undefined && payload.overtime_rate_type !== null
      && payload.overtime_rate_type !== '' && !OVERTIME_RATE_TYPES.includes(payload.overtime_rate_type)) {
      throw new ValidationError(`Overtime rate type is one of: ${OVERTIME_RATE_TYPES.join(', ')}`);
    }
    if (payload.overtime_rate_value !== undefined && payload.overtime_rate_value !== null
      && payload.overtime_rate_value !== '') {
      payload.overtime_rate_value = round2(Number(payload.overtime_rate_value));
      if (payload.overtime_rate_value < 0) throw new ValidationError('An overtime rate cannot be negative');
    }

    // Open and close: leaving sets both `left_on` and `is_active` together, so
    // a query that has always filtered on `is_active` alone (every roster,
    // every dropdown) keeps working without being told about `left_on` at
    // all. Reactivating (clearing `left_on`) does NOT force `is_active` back
    // on by itself — that is a second, deliberate answer, not a side effect
    // of the first.
    if (payload.left_on !== undefined) {
      payload.left_on = payload.left_on || null;
      const hiredOn = payload.hired_on !== undefined ? payload.hired_on : existing?.hired_on;
      if (payload.left_on && hiredOn && payload.left_on < String(hiredOn).slice(0, 10)) {
        throw new ValidationError('An employee cannot have left before they were hired');
      }
      if (payload.left_on) payload.is_active = 0;
    }

    return payload;
  }
}

export class PayrollService {
  constructor(deps = {}) {
    this.employees = deps.employees || repositories.employees;
    this.costs = deps.costs || costService;
  }

  /**
   * The three things an owner asks about wages, in one answer:
   * who is on the books, what each was paid in this window, and who is owed.
   */
  async roster({ dateFrom = null, dateTo = null, activeOnly = false, asOf = null } = {}) {
    const when = asOf || today();
    const rows = await this.employees.withPayments({
      monthFrom: dateFrom, monthTo: dateTo, activeOnly,
    });
    const enriched = rows.map((row) => {
      const owed = this.#owed(row, when);
      return {
        ...row,
        paid_total: round2(row.paid_total),
        paid_in_range: round2(row.paid_in_range),
        ...owed,
      };
    });
    return {
      rows: enriched,
      summary: {
        employees: enriched.length,
        active: enriched.filter((row) => row.is_active).length,
        paid_in_range: round2(enriched.reduce((sum, row) => sum + row.paid_in_range, 0)),
        owed: round2(enriched.filter((row) => row.is_active).reduce((sum, row) => sum + row.owed_amount, 0)),
        monthly_wage_bill: round2(enriched
          .filter((row) => row.is_active)
          .reduce((sum, row) => sum + this.#monthlyEquivalent(row), 0)),
      },
    };
  }

  /**
   * What is owed, and what it deliberately is not.
   *
   * COMPLETE periods only, counted from the day after the last period paid for
   * (or the hiring date), which is the honest reading of "he is paid X every
   * Y": a man on a monthly salary who started on the 1st is owed nothing on the
   * 20th, not two thirds. Part-periods are a conversation between two people,
   * not a number this system should invent — and an ERP that quietly shows a
   * third of a salary as "owed" would have people paying it.
   */
  #owed(employee, when) {
    if (!employee.is_active || !(Number(employee.salary_amount) > 0)) {
      return { owed_periods: 0, owed_amount: 0, owed_from: null, owed_to: null };
    }
    const from = employee.paid_up_to
      ? addDays(employee.paid_up_to, 1)
      : (employee.hired_on ? String(employee.hired_on).slice(0, 10) : null);
    if (!from || from > when) {
      return { owed_periods: 0, owed_amount: 0, owed_from: from, owed_to: null };
    }
    const periods = completePeriods(from, when, employee.salary_period);
    return {
      owed_periods: periods,
      owed_amount: round2(periods * Number(employee.salary_amount)),
      owed_from: periods ? from : null,
      owed_to: periods ? this.#lastCoveredDay(from, employee.salary_period, periods) : null,
    };
  }

  #lastCoveredDay(from, period, periods) {
    let start = from;
    let end = periodEnd(start, period);
    for (let i = 1; i < periods; i += 1) {
      start = addDays(end, 1);
      end = periodEnd(start, period);
    }
    return end;
  }

  /** A day-rate and a month-rate compared honestly, for the wage-bill figure. */
  #monthlyEquivalent(employee) {
    return monthlyEquivalent(employee.salary_amount, employee.salary_period);
  }

  async get(id) {
    const employee = await this.employees.findById(Number(id));
    if (!employee) throw new NotFoundError('Employee', id);
    const payments = await this.payments(employee.id);
    const owed = this.#owed({ ...employee, paid_up_to: payments.paid_up_to }, today());
    return {
      ...employee,
      ...owed,
      paid_total: payments.paid_total,
      paid_up_to: payments.paid_up_to,
      suggested_period: nextUnpaidPeriod({
        period: employee.salary_period,
        lastPaidEnd: payments.paid_up_to,
        hiredOn: employee.hired_on,
        today: today(),
      }),
      payments: payments.rows,
    };
  }

  /** One employee's salary payments — cost rows, with the photograph of each. */
  async payments(employeeId) {
    const employee = await this.employees.findById(Number(employeeId));
    if (!employee) throw new NotFoundError('Employee', employeeId);
    const rows = await this.employees.payments(employee.id);
    // One query for every payment's photographs rather than one per payment.
    const byCost = await attachmentService.listMany('cost', rows.map((row) => row.id));
    return {
      rows: rows.map((row) => ({ ...row, attachments: byCost[row.id] || [] })),
      paid_total: round2(rows.reduce((sum, row) => sum + Number(row.amount), 0)),
      paid_up_to: rows.reduce((latest, row) => (
        row.period_end && (!latest || row.period_end > latest) ? row.period_end : latest
      ), null),
      employee,
    };
  }

  /**
   * The period a payment defaults to, resolved once so `pay()` and `preview()`
   * agree on it instead of each computing it their own way.
   */
  async #resolvePeriod(employee, payload) {
    return payload.period_start
      ? {
        start: payload.period_start,
        end: payload.period_end || periodEnd(payload.period_start, employee.salary_period),
      }
      : nextUnpaidPeriod({
        period: employee.salary_period,
        lastPaidEnd: (await this.payments(employee.id)).paid_up_to,
        hiredOn: employee.hired_on,
        today: today(),
      });
  }

  /**
   * Absence, lateness and overtime, turned into money — shared by `pay()`
   * (which writes it) and `preview()` (which only shows it, before anybody
   * commits to it).
   *
   * `baseAmount` is what the period would pay with none of this — the plain
   * figure the screen has always offered. Three formulas, each the owner's own
   * answer to the question that was actually asked:
   *
   *   day rate      = monthly-equivalent salary ÷ working days in the period's
   *                    calendar month (shared/payroll.js#dayRate)
   *   absence       = days × day rate, unless a manual amount was given instead
   *   lateness      = late hours ÷ daily hours × day rate — a proportion of the
   *                    day, exactly as asked ("نسبة من سعر اليوم")
   *   overtime      = hours × (a flat EGP/hour, or a multiple of the derived
   *                    hourly rate) — both were wanted, per employee
   *
   * Refuses rather than guesses when the arithmetic has nothing to work from:
   * no schedule configured at all, or daily hours missing when lateness or
   * overtime were asked for, or deductions that would take the payment to
   * zero or below (a `costs.amount` cannot be zero — see shared/costs.js).
   */
  #breakdown(employee, periodStart, payload) {
    const baseAmount = round2(Number(payload.amount ?? employee.salary_amount));
    const asked = ['absence_days', 'absence_deduction_amount', 'late_hours', 'overtime_hours']
      .some((key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '');
    if (!asked) return { amount: baseAmount, breakdown: null };

    const rate = dayRate(employee, periodStart);
    if (rate === null) {
      throw new ValidationError(
        'Set this employee’s work days (and, for lateness or overtime, their daily hours) before entering absence, lateness or overtime for a payment',
      );
    }
    const dailyHours = Number(employee.daily_hours) || 0;
    const needsHourly = payload.late_hours || payload.overtime_hours;
    if (needsHourly && !(dailyHours > 0)) {
      throw new ValidationError('Set this employee’s daily working hours before entering lateness or overtime');
    }
    const hourlyRate = dailyHours > 0 ? rate / dailyHours : 0;

    const absenceDays = Math.max(0, Number(payload.absence_days) || 0);
    const manualAbsence = payload.absence_deduction_amount !== undefined
      && payload.absence_deduction_amount !== null && payload.absence_deduction_amount !== '';
    const absenceDeduction = manualAbsence
      ? round2(Math.max(0, Number(payload.absence_deduction_amount)))
      : round2(absenceDays * rate);

    const lateHours = Math.max(0, Number(payload.late_hours) || 0);
    const lateDeduction = round2(lateHours * hourlyRate);

    const overtimeHours = Math.max(0, Number(payload.overtime_hours) || 0);
    const overtimeHourlyRate = employee.overtime_rate_type === 'fixed'
      ? (Number(employee.overtime_rate_value) || 0)
      : hourlyRate * (Number(employee.overtime_rate_value) || 0);
    const overtimePay = round2(overtimeHours * overtimeHourlyRate);

    const amount = round2(baseAmount - absenceDeduction - lateDeduction + overtimePay);
    if (!(amount > 0)) {
      throw new ValidationError('These deductions bring the payment to zero or below — check the absence and lateness entered');
    }

    return {
      amount,
      breakdown: {
        day_rate: round2(rate),
        hourly_rate: round2(hourlyRate),
        gross_amount: baseAmount,
        absence_days: absenceDays || null,
        absence_deduction: absenceDeduction || null,
        late_hours: lateHours || null,
        late_deduction: lateDeduction || null,
        overtime_hours: overtimeHours || null,
        overtime_pay: overtimePay || null,
      },
    };
  }

  /**
   * What a payment WOULD come to, without writing anything — the live figure
   * the "record a payment" screen shows as absence, lateness and overtime are
   * typed in, computed with the exact same rule `pay()` writes with so the
   * number on screen is never a preview of something different from what gets
   * saved.
   */
  async preview(employeeId, payload = {}) {
    const employee = await this.employees.findById(Number(employeeId));
    if (!employee) throw new NotFoundError('Employee', employeeId);
    const period = await this.#resolvePeriod(employee, payload);
    const { amount, breakdown } = this.#breakdown(employee, period.start, payload);
    return { amount, period, ...(breakdown || {}) };
  }

  /**
   * What he actually paid, when, for which period, with a photograph if he
   * wants one — as a cost, through the one service that writes costs.
   *
   * The amount is what was HANDED OVER, not what the employee's record says it
   * should be. A shop pays half now and half on Thursday, and a payroll that
   * refuses to record that is a payroll nobody uses. The record's amount is the
   * default the screen offers, and nothing more — absence, lateness and
   * overtime (see `#breakdown`) adjust it from there when any were entered.
   */
  async pay(employeeId, payload = {}, context = {}) {
    const employee = await this.employees.findById(Number(employeeId));
    if (!employee) throw new NotFoundError('Employee', employeeId);

    const period = await this.#resolvePeriod(employee, payload);
    const { amount, breakdown } = this.#breakdown(employee, period.start, payload);

    return this.costs.create({
      employee_id: employee.id,
      warehouse_id: payload.warehouse_id || employee.warehouse_id || null,
      spent_on: payload.paid_on || today(),
      amount,
      description: payload.note || null,
      reference: payload.reference || null,
      payment_method: payload.payment_method || 'cash',
      period_start: period.start,
      period_end: period.end,
      photo: payload.photo || null,
      ...(breakdown
        ? {
          gross_amount: breakdown.gross_amount,
          absence_days: breakdown.absence_days,
          absence_deduction: breakdown.absence_deduction,
          late_hours: breakdown.late_hours,
          late_deduction: breakdown.late_deduction,
          overtime_hours: breakdown.overtime_hours,
          overtime_pay: breakdown.overtime_pay,
        }
        : {}),
    }, context, { source: 'salary' });
  }
}

export const employeeService = new EmployeeService();
export const payrollService = new PayrollService();
export default payrollService;
