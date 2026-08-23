/**
 * صفحة التكاليف — everything the shop spends that is not stock.
 *
 * Electricity, water, taxes, rent, equipment, maintenance, wages. One ledger,
 * one total, and that total is what the reports now subtract from profit: goods
 * margin is not what a shop owner means by the word (see ReportService).
 *
 * Three things worth reading before changing this file:
 *
 *  1. **A salary payment is a cost row.** Not a mirror of one — the row itself,
 *     with `employee_id`, `period_start` and `period_end` filled in. That is
 *     why it can only ever be counted once, why it cannot drift from a second
 *     copy of itself, and why it is edited in one place whichever screen you
 *     opened it from. `PayrollService` is a thin layer over `create()` here; it
 *     owns no money of its own. See shared/costs.js.
 *
 *  2. **A recurring cost never writes anything by itself.** `due()` computes
 *     what a template owes and returns it; `generate()` posts it, and is
 *     reached only from a person pressing something. The owner's rule: an
 *     entry nobody checked is worse than typing it. What protects the ledger
 *     from a double press is not that check but the unique index on
 *     `(recurring_id, period_key)` — the database refuses the second row for a
 *     month, so a retry, a second tab and two overlapping requests all end with
 *     one entry per month.
 *
 *  3. **A cost belongs to a branch** — `warehouse_id`, the shop location. Not a
 *     tenant: those are separate databases and cannot appear in one report.
 *     A single-shop install resolves it here so no caller has to know.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import { round2 } from '../shared/money.js';
import { dueOccurrences, MAX_CATCH_UP_MONTHS } from '../shared/costs.js';
import auditService from './AuditService.js';
import attachmentService from './AttachmentService.js';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A cost can carry a photograph of the bill — and so, therefore, can a salary
 * payment, because a salary payment is a cost row. ONE owner type for both,
 * which is the whole point of there being one attachment mechanism: adding this
 * required no change to AttachmentService and no new table.
 *
 * Looking at the bill is looking at the costs page; adding or removing one is
 * the same right as changing the cost it belongs to.
 */
attachmentService.registerOwner('cost', {
  module: 'costs',
  view: 'costs.view',
  attach: 'costs.update',
  exists: async (id) => Boolean(await repositories.costs.findById(Number(id))),
  label: async (id) => {
    const row = await repositories.costs.findDetailed(id);
    if (!row) return `cost ${id}`;
    return `${row.category_name_en} — ${row.amount} (${row.spent_on})`;
  },
});

export class CostService {
  constructor(deps = {}) {
    this.costs = deps.costs || repositories.costs;
    this.categories = deps.categories || repositories.costCategories;
    this.recurring = deps.recurring || repositories.recurringCosts;
    this.employees = deps.employees || repositories.employees;
    this.warehouses = deps.warehouses || repositories.warehouses;
    this.audit = deps.audit || auditService;
  }

  /** The one location, unless the caller named a branch. */
  async branchId(warehouseId) {
    if (warehouseId) {
      await this.warehouses.requireById(warehouseId, 'branch');
      return Number(warehouseId);
    }
    const location = await this.warehouses.single();
    if (!location) throw new BusinessRuleError('This shop has no location to file a cost against');
    return location.id;
  }

  // -------------------------------------------------------------- the ledger

  /** Paginated costs, each with the photographs attached to it. */
  async list(query = {}) {
    const page = await this.costs.listDetailed(query);
    const byCost = await attachmentService.listMany('cost', page.rows.map((row) => row.id));
    return {
      ...page,
      rows: page.rows.map((row) => ({ ...row, attachments: byCost[row.id] || [] })),
    };
  }

  /** What the header of the costs screen shows: one total and its breakdown. */
  async summary(query = {}) {
    const [total, byCategory, byBranch] = await Promise.all([
      this.costs.total(query),
      this.costs.byCategory(query),
      this.costs.byBranch(query),
    ]);
    return {
      total: round2(total.amount),
      entries: total.entries,
      byCategory: byCategory.map((row) => ({ ...row, amount: round2(row.amount) })),
      byBranch: byBranch.map((row) => ({ ...row, amount: round2(row.amount) })),
    };
  }

  async get(id) {
    const row = await this.costs.findDetailed(id);
    if (!row) throw new NotFoundError('Cost', id);
    return { ...row, attachments: await attachmentService.list('cost', row.id) };
  }

  /**
   * Everything a cost row has to be true about, whoever is writing it.
   *
   * Both the costs screen and the salary screen come through here, so a salary
   * payment cannot be validated one way in one place and another way in the
   * other — which is exactly the drift a second table would have invited.
   */
  async #prepare(payload, { existing = null } = {}) {
    const amount = round2(Number(payload.amount));
    if (!(amount > 0)) throw new ValidationError('A cost must be greater than zero');

    const employeeId = payload.employee_id ?? existing?.employee_id ?? null;
    let employee = null;
    if (employeeId) {
      employee = await this.employees.findById(Number(employeeId));
      if (!employee) throw new NotFoundError('Employee', employeeId);
    }

    // A salary payment is filed under the salary category, always. The caller
    // does not get to choose, because "which category are wages?" has exactly
    // one right answer and a wrong one would take the money out of the payroll
    // report while leaving it in the costs total.
    let categoryId = payload.category_id ?? existing?.category_id ?? null;
    if (employee) {
      const salary = await this.categories.salaryCategory();
      if (!salary) throw new BusinessRuleError('This shop has no salary category to file wages under');
      categoryId = salary.id;
    }
    const category = categoryId ? await this.categories.findById(Number(categoryId)) : null;
    if (!category) throw new ValidationError('Choose what this cost is for');

    const periodStart = payload.period_start ?? existing?.period_start ?? null;
    const periodEnd = payload.period_end ?? existing?.period_end ?? null;
    if (employee) {
      if (!periodStart || !periodEnd) {
        throw new ValidationError('Say which period this salary payment covers');
      }
      if (periodEnd < periodStart) {
        throw new ValidationError('A salary period cannot end before it starts');
      }
    }

    return {
      category_id: category.id,
      warehouse_id: await this.branchId(payload.warehouse_id ?? existing?.warehouse_id),
      spent_on: payload.spent_on || existing?.spent_on || today(),
      amount,
      description: payload.description ?? existing?.description ?? null,
      reference: payload.reference ?? existing?.reference ?? null,
      payment_method: payload.payment_method || existing?.payment_method || 'cash',
      employee_id: employee ? employee.id : null,
      period_start: employee ? periodStart : null,
      period_end: employee ? periodEnd : null,
    };
  }

  /**
   * One cost, and the photograph of its bill, as one act.
   *
   * `attach()` runs inside this transaction, so a picture that will not store
   * takes the cost down with it rather than leaving a cost nobody can prove.
   * Same shape as PurchaseService.registerPayment — deliberately, because it is
   * the same problem.
   */
  async create(payload = {}, context = {}, { source = 'manual', recurring = null } = {}) {
    return transaction(async () => {
      const data = await this.#prepare(payload);
      const created = await this.costs.create({
        ...data,
        source,
        recurring_id: recurring?.id || null,
        period_key: recurring?.period_key || null,
        created_by: context.actor?.id || null,
      });

      if (payload.photo?.dataUrl) {
        await attachmentService.attach('cost', created.id, payload.photo, context);
      }

      const row = await this.costs.findDetailed(created.id);
      await this.audit.record({
        action: 'CREATE', module: 'costs', entityType: 'cost', entityId: created.id,
        entityLabel: this.#label(row),
        after: { ...row, has_photo: Boolean(payload.photo?.dataUrl) },
        actor: context.actor, request: context.request,
      });
      return this.get(created.id);
    });
  }

  async update(id, payload = {}, context = {}) {
    return transaction(async () => {
      const before = await this.costs.findDetailed(id);
      if (!before) throw new NotFoundError('Cost', id);
      const data = await this.#prepare(payload, { existing: before });
      await this.costs.update(before.id, data);
      const after = await this.costs.findDetailed(before.id);

      if (payload.photo?.dataUrl) {
        await attachmentService.attach('cost', before.id, payload.photo, context);
      }

      await this.audit.recordChange(context, {
        action: 'UPDATE', module: 'costs', entityType: 'cost', entityId: before.id,
        entityLabel: this.#label(after), before, after,
      });
      return this.get(before.id);
    });
  }

  /**
   * A cost, gone — with its photographs.
   *
   * `owner_id` carries no foreign key (one attachments table cannot point at
   * three tables), so nothing cascades on its own and the bytes would sit in
   * the shop's backup forever. See the contract in AttachmentService.js.
   */
  async remove(id, context = {}) {
    return transaction(async () => {
      const before = await this.costs.findDetailed(id);
      if (!before) throw new NotFoundError('Cost', id);
      await attachmentService.detachAll('cost', before.id, context);
      await this.costs.remove(before.id);
      await this.audit.record({
        action: 'DELETE', module: 'costs', entityType: 'cost', entityId: before.id,
        entityLabel: this.#label(before), before,
        actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  #label(row) {
    if (!row) return 'cost';
    const who = row.employee_name ? ` — ${row.employee_name}` : '';
    return `${row.category_name_en}${who} — ${row.amount} (${row.spent_on})`;
  }

  // ----------------------------------------------------------- what repeats

  async listRecurring(query = {}) {
    const rows = await this.recurring.listDetailed(query);
    const asOf = query.asOf || today();
    // Each template says how many entries it currently owes, so the list can
    // show it without the screen having to ask a second time.
    const withDue = [];
    for (const row of rows) {
      const posted = await this.costs.postedPeriods(row.id);
      withDue.push({ ...row, due_count: dueOccurrences(row, { asOf, posted }).length });
    }
    return { rows: withDue };
  }

  async getRecurring(id) {
    return this.recurring.requireById(id, 'recurring cost');
  }

  async saveRecurring(payload = {}, context = {}, id = null) {
    return transaction(async () => {
      const amount = round2(Number(payload.amount));
      if (!(amount > 0)) throw new ValidationError('A repeating cost must be greater than zero');
      const category = await this.categories.findById(Number(payload.category_id));
      if (!category) throw new ValidationError('Choose what this cost is for');
      if (category.kind === 'salary') {
        // Wages repeat too, but they repeat per PERSON and are recorded when
        // they are actually handed over. A template that posted salaries on the
        // 1st would be inventing payments nobody made.
        throw new BusinessRuleError('Salaries repeat per employee — record them on the employee, not as a repeating cost');
      }

      const data = {
        category_id: category.id,
        warehouse_id: await this.branchId(payload.warehouse_id),
        description: payload.description || null,
        amount,
        payment_method: payload.payment_method || 'cash',
        day_of_month: Math.min(Math.max(Number(payload.day_of_month) || 1, 1), 31),
        starts_on: payload.starts_on || today(),
        ends_on: payload.ends_on || null,
      };
      if (data.ends_on && data.ends_on < data.starts_on) {
        throw new ValidationError('A repeating cost cannot end before it starts');
      }

      const before = id ? await this.recurring.requireById(id, 'recurring cost') : null;
      const row = id
        ? await this.recurring.update(id, data)
        : await this.recurring.create({ ...data, is_active: 1, created_by: context.actor?.id || null });

      await this.audit.recordChange(context, {
        action: id ? 'UPDATE' : 'CREATE', module: 'costs', entityType: 'recurring_cost',
        entityId: row.id, entityLabel: `${category.name_en} — ${amount} / month`, before, after: row,
      });
      return row;
    });
  }

  /**
   * Stop one, or start it again.
   *
   * Stopping is not deleting: the entries it already produced are real costs
   * that happened, and they stay. What stops is the future — `due()` returns
   * nothing for an inactive template, so nothing is ever offered again.
   */
  async setRecurringActive(id, active, context = {}) {
    return transaction(async () => {
      const before = await this.recurring.requireById(id, 'recurring cost');
      const after = await this.recurring.update(id, {
        is_active: active ? 1 : 0,
        stopped_at: active ? null : new Date().toISOString(),
        stopped_by: active ? null : (context.actor?.id || null),
      });
      await this.audit.record({
        action: active ? 'RESUME' : 'STOP', module: 'costs', entityType: 'recurring_cost',
        entityId: before.id, entityLabel: before.description || `recurring cost ${before.id}`,
        before: { is_active: before.is_active }, after: { is_active: after.is_active },
        actor: context.actor, request: context.request,
      });
      return after;
    });
  }

  async removeRecurring(id, context = {}) {
    return transaction(async () => {
      const before = await this.recurring.requireById(id, 'recurring cost');
      // `costs.recurring_id` is ON DELETE SET NULL: the entries it produced are
      // money that left the shop and must survive the template being tidied
      // away. They keep `source = 'recurring'` so the ledger still says where
      // they came from.
      await this.recurring.remove(id);
      await this.audit.record({
        action: 'DELETE', module: 'costs', entityType: 'recurring_cost', entityId: id,
        entityLabel: before.description || `recurring cost ${id}`, before,
        actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  /**
   * Every month every active template owes and has not been given.
   *
   * This is what six weeks away looks like: nothing was posted while nobody was
   * looking, so the missed months are all here, oldest first, each with its
   * date and the amount the template currently says. The screen shows them at
   * the top of the costs page and the owner confirms them — one at a time if
   * the electricity bill was not what the template guessed, or all at once.
   */
  async due({ asOf = null } = {}) {
    const when = asOf || today();
    const templates = await this.recurring.listDetailed({ activeOnly: true });
    const rows = [];
    for (const template of templates) {
      const posted = await this.costs.postedPeriods(template.id);
      for (const occurrence of dueOccurrences(template, { asOf: when, posted })) {
        rows.push({
          ...occurrence,
          category_id: template.category_id,
          category_name_en: template.category_name_en,
          category_name_ar: template.category_name_ar,
          warehouse_id: template.warehouse_id,
          branch_name_en: template.branch_name_en,
          branch_name_ar: template.branch_name_ar,
          description: template.description,
          payment_method: template.payment_method,
        });
      }
    }
    rows.sort((a, b) => (a.due_on < b.due_on ? -1 : 1));
    return { rows, asOf: when, maxCatchUpMonths: MAX_CATCH_UP_MONTHS };
  }

  /**
   * Post one month of one template.
   *
   * `amount` may be overridden — the electricity bill is rarely the number the
   * template guessed, and making him delete and retype it would be the same
   * work he was trying to avoid. Overriding here changes this month only; the
   * template keeps its own figure unless he edits that too.
   *
   * Its own transaction, per occurrence, so a duplicate rejected by the unique
   * index costs one month rather than the whole run.
   */
  async postOccurrence(recurringId, periodKey, { amount = null, spentOn = null } = {}, context = {}) {
    const template = await this.recurring.requireById(recurringId, 'recurring cost');
    const posted = await this.costs.postedPeriods(template.id);
    const occurrence = dueOccurrences(template, { asOf: today(), posted })
      .find((row) => row.period_key === periodKey);
    if (!occurrence) {
      throw new BusinessRuleError(`${periodKey} is not due on this repeating cost, or has already been posted`);
    }
    return this.create(
      {
        category_id: template.category_id,
        warehouse_id: template.warehouse_id,
        spent_on: spentOn || occurrence.due_on,
        amount: amount === null || amount === undefined ? occurrence.amount : amount,
        description: template.description,
        payment_method: template.payment_method,
      },
      context,
      { source: 'recurring', recurring: { id: template.id, period_key: occurrence.period_key } },
    );
  }

  /**
   * Post everything currently due — the "confirm all" button.
   *
   * Running it twice produces nothing the second time, and that is guaranteed
   * by the database rather than by this loop: the unique index on
   * `(recurring_id, period_key)` rejects the second row for a month, so two
   * requests racing each other end with one entry, not two. A rejection here is
   * therefore not an error — it is the guard working — and it is counted as
   * "already posted" rather than thrown at the caller.
   */
  async generate({ asOf = null } = {}, context = {}) {
    const { rows } = await this.due({ asOf });
    const posted = [];
    let skipped = 0;
    for (const occurrence of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        posted.push(await this.postOccurrence(
          occurrence.recurring_id, occurrence.period_key, {}, context,
        ));
      } catch (error) {
        if (/UNIQUE constraint failed|is not due/i.test(String(error?.message))) skipped += 1;
        else throw error;
      }
    }
    return { posted: posted.length, skipped, rows: posted };
  }
}

export const costService = new CostService();
export default costService;
