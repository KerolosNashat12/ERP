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
 * ── Out of scope, deliberately ──────────────────────────────────────────────
 * Attendance, overtime, absence, advances and deductions. The owner ruled all
 * five out for this round. The door is left open rather than nailed shut: each
 * of them is another row against the same employee and period — a deduction is
 * a negative line, an advance is a payment against a period not yet finished —
 * so none of them needs this model changed to arrive later.
 */
import repositories from '../infrastructure/repositories/index.js';
import { CrudService, referencedBy } from './CrudService.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import {
  SALARY_PERIODS, isSalaryPeriod, completePeriods, nextUnpaidPeriod, periodEnd, addDays,
} from '../shared/payroll.js';
import costService from './CostService.js';
import attachmentService from './AttachmentService.js';

const today = () => new Date().toISOString().slice(0, 10);

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

  async beforeSave(data) {
    const payload = { ...data };
    if (payload.salary_period !== undefined && !isSalaryPeriod(payload.salary_period)) {
      throw new ValidationError(`A salary period is one of: ${SALARY_PERIODS.join(', ')}`);
    }
    if (payload.salary_amount !== undefined && payload.salary_amount !== null) {
      payload.salary_amount = round2(Number(payload.salary_amount));
      if (payload.salary_amount < 0) throw new ValidationError('A salary cannot be negative');
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
    const amount = Number(employee.salary_amount) || 0;
    if (employee.salary_period === 'day') return amount * 30;
    if (employee.salary_period === 'week') return (amount * 52) / 12;
    return amount;
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
   * What he actually paid, when, for which period, with a photograph if he
   * wants one — as a cost, through the one service that writes costs.
   *
   * The amount is what was HANDED OVER, not what the employee's record says it
   * should be. A shop pays half now and half on Thursday, and a payroll that
   * refuses to record that is a payroll nobody uses. The record's amount is the
   * default the screen offers, and nothing more.
   */
  async pay(employeeId, payload = {}, context = {}) {
    const employee = await this.employees.findById(Number(employeeId));
    if (!employee) throw new NotFoundError('Employee', employeeId);

    const period = payload.period_start
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

    return this.costs.create({
      employee_id: employee.id,
      warehouse_id: payload.warehouse_id || employee.warehouse_id || null,
      spent_on: payload.paid_on || today(),
      amount: payload.amount ?? employee.salary_amount,
      description: payload.note || null,
      reference: payload.reference || null,
      payment_method: payload.payment_method || 'cash',
      period_start: period.start,
      period_end: period.end,
      photo: payload.photo || null,
    }, context, { source: 'salary' });
  }
}

export const employeeService = new EmployeeService();
export const payrollService = new PayrollService();
export default payrollService;
