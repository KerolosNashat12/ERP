/**
 * Queries for what the shop spends and the people it pays.
 *
 * The costs ledger is a document table read almost entirely by date range, by
 * category and by branch, so every list here takes the same filter shape and
 * builds one WHERE clause from it — there is no second spelling of "costs
 * between two dates" anywhere in the codebase, which is what stops the total
 * on the screen and the total in the report ever disagreeing.
 */
import BaseRepository from './BaseRepository.js';
import { getDb } from '../database/connection.js';
import { SALARY_CATEGORY_CODE } from '../../shared/costs.js';
import { notInBin } from '../../shared/trashFilter.js';

export class CostCategoryRepository extends BaseRepository {
  constructor() {
    super({
      table: 'cost_categories',
      columns: ['code', 'name_en', 'name_ar', 'kind', 'display_order', 'is_system', 'is_active'],
      searchable: ['code', 'name_en', 'name_ar'],
      defaultSort: 'display_order ASC, name_en ASC',
    });
  }

  /** The one category payroll files wages under. */
  async salaryCategory() {
    return (await this.db.prepare(
      "SELECT * FROM cost_categories WHERE kind = 'salary' ORDER BY id LIMIT 1",
    ).get())
      || (await this.findBy('code', SALARY_CATEGORY_CODE));
  }

  async listWithCounts() {
    return this.db.prepare(`
      SELECT c.*,
             (SELECT COUNT(*) FROM costs k WHERE k.category_id = c.id) AS cost_count,
             (SELECT COALESCE(SUM(k.amount), 0) FROM costs k WHERE k.category_id = c.id) AS total_amount
      FROM cost_categories c
      ORDER BY c.display_order ASC, c.name_en ASC
    `).all();
  }
}

/**
 * One filter builder, used by the list, the totals and every report.
 * @returns {{sql: string, params: any[]}}
 */
export function costFilter(filters = {}, alias = 'k') {
  const where = [];
  const params = [];
  const q = (column) => `${alias}.${column}`;
  if (filters.dateFrom) { where.push(`date(${q('spent_on')}) >= date(?)`); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push(`date(${q('spent_on')}) <= date(?)`); params.push(filters.dateTo); }
  if (filters.categoryId) { where.push(`${q('category_id')} = ?`); params.push(Number(filters.categoryId)); }
  if (filters.warehouseId) { where.push(`${q('warehouse_id')} = ?`); params.push(Number(filters.warehouseId)); }
  if (filters.employeeId) { where.push(`${q('employee_id')} = ?`); params.push(Number(filters.employeeId)); }
  if (filters.source) { where.push(`${q('source')} = ?`); params.push(String(filters.source)); }
  if (filters.search) {
    where.push(`(${q('description')} LIKE ? OR ${q('reference')} LIKE ?)`);
    const like = `%${String(filters.search).trim()}%`;
    params.push(like, like);
  }
  /*
   * A cost in the recycle bin has left the ledger — that is what the delete
   * dialog promises out loud: "the profit for that month goes up by the same
   * amount". Because every screen and every report is built on this one
   * builder, the promise is kept in exactly one place: the list, the totals,
   * the profit report and the console all stop seeing it at the same instant,
   * and restoring it puts it back in all of them at once.
   */
  where.push(notInBin('cost', q('id')));
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export class CostRepository extends BaseRepository {
  constructor() {
    super({
      table: 'costs',
      trashType: 'cost',
      columns: [
        'category_id', 'warehouse_id', 'spent_on', 'amount', 'description', 'reference',
        'payment_method', 'source', 'recurring_id', 'period_key', 'employee_id',
        'period_start', 'period_end', 'created_by',
      ],
      searchable: ['description', 'reference'],
      defaultSort: 'spent_on DESC, id DESC',
    });
  }

  /** Costs with everything a screen needs to name them, paginated. */
  async listDetailed(query = {}) {
    const { sql, params } = costFilter(query);
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 1), 500);

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM costs k ${sql}`).get(...params)).n;

    const rows = await this.db.prepare(`
      SELECT k.*, c.name_en AS category_name_en, c.name_ar AS category_name_ar, c.kind AS category_kind,
             w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
             e.name AS employee_name, e.job_title AS employee_job_title,
             u.full_name AS created_by_name
      FROM costs k
      JOIN cost_categories c ON c.id = k.category_id
      JOIN warehouses w ON w.id = k.warehouse_id
      LEFT JOIN employees e ON e.id = k.employee_id
      LEFT JOIN users u ON u.id = k.created_by
      ${sql}
      ORDER BY k.spent_on DESC, k.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);

    return { rows, total, page, pageSize, pages: Math.ceil(total / pageSize) || 1 };
  }

  async findDetailed(id) {
    return (await this.db.prepare(`
      SELECT k.*, c.name_en AS category_name_en, c.name_ar AS category_name_ar, c.kind AS category_kind,
             w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
             e.name AS employee_name, u.full_name AS created_by_name
      FROM costs k
      JOIN cost_categories c ON c.id = k.category_id
      JOIN warehouses w ON w.id = k.warehouse_id
      LEFT JOIN employees e ON e.id = k.employee_id
      LEFT JOIN users u ON u.id = k.created_by
      WHERE k.id = ?
    `).get(Number(id))) || null;
  }

  /** One number: everything spent inside the filter. */
  async total(filters = {}) {
    const { sql, params } = costFilter(filters);
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(k.amount), 0) AS amount, COUNT(*) AS entries FROM costs k ${sql}`)
      .get(...params);
    return { amount: Number(row.amount), entries: Number(row.entries) };
  }

  async byCategory(filters = {}) {
    const { sql, params } = costFilter(filters);
    return this.db.prepare(`
      SELECT c.id AS category_id, c.name_en AS category_name_en, c.name_ar AS category_name_ar,
             COUNT(*) AS entries, ROUND(SUM(k.amount), 2) AS amount
      FROM costs k JOIN cost_categories c ON c.id = k.category_id
      ${sql}
      GROUP BY c.id ORDER BY amount DESC
    `).all(...params);
  }

  async byBranch(filters = {}) {
    const { sql, params } = costFilter(filters);
    return this.db.prepare(`
      SELECT w.id AS warehouse_id, w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
             COUNT(*) AS entries, ROUND(SUM(k.amount), 2) AS amount
      FROM costs k JOIN warehouses w ON w.id = k.warehouse_id
      ${sql}
      GROUP BY w.id ORDER BY amount DESC
    `).all(...params);
  }

  /** `{ '2026-03': 4210.5, … }` — costs per calendar month, for the profit report. */
  async byMonth(filters = {}) {
    const { sql, params } = costFilter(filters);
    return this.db.prepare(`
      SELECT substr(k.spent_on, 1, 7) AS month, ROUND(SUM(k.amount), 2) AS amount, COUNT(*) AS entries
      FROM costs k ${sql}
      GROUP BY month ORDER BY month DESC
    `).all(...params);
  }

  /** The months a template has already produced — the dedupe input. */
  async postedPeriods(recurringId) {
    const rows = await this.db.prepare(
      'SELECT period_key FROM costs WHERE recurring_id = ? AND period_key IS NOT NULL',
    ).all(Number(recurringId));
    return rows.map((row) => row.period_key);
  }
}

export class RecurringCostRepository extends BaseRepository {
  constructor() {
    super({
      table: 'recurring_costs',
      columns: [
        'category_id', 'warehouse_id', 'description', 'amount', 'payment_method',
        // `frequency`, `day_of_week` and `month_of_year` say WHEN this repeats;
        // `day_of_month` is shared by monthly and yearly. A column missing from
        // this list is a field the form can set and the repository silently
        // drops, so all four belong here together.
        'frequency', 'day_of_month', 'day_of_week', 'month_of_year',
        'starts_on', 'ends_on', 'is_active', 'stopped_at', 'stopped_by',
        'created_by',
      ],
      searchable: ['description'],
      /*
       * Ordered by WHAT it is, then when — day-of-month alone stopped being a
       * sort key the moment a weekly template stopped having one. Active
       * first, then daily/weekly/monthly/yearly by how often they come round,
       * which is the order a person reads a list of repeats in.
       */
      defaultSort: 'is_active DESC, id DESC',
    });
  }

  async listDetailed({ activeOnly = false } = {}) {
    return this.db.prepare(`
      SELECT r.*, c.name_en AS category_name_en, c.name_ar AS category_name_ar,
             w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
             (SELECT COUNT(*) FROM costs k WHERE k.recurring_id = r.id) AS posted_count,
             (SELECT MAX(k.period_key) FROM costs k WHERE k.recurring_id = r.id) AS last_period
      FROM recurring_costs r
      JOIN cost_categories c ON c.id = r.category_id
      JOIN warehouses w ON w.id = r.warehouse_id
      ${activeOnly ? 'WHERE r.is_active = 1' : ''}
      ORDER BY r.is_active DESC,
               CASE r.frequency WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1
                                WHEN 'monthly' THEN 2 ELSE 3 END,
               r.day_of_month ASC, r.id DESC
    `).all();
  }
}

export class EmployeeRepository extends BaseRepository {
  constructor() {
    super({
      table: 'employees',
      columns: [
        'code', 'name', 'job_title', 'phone', 'salary_amount', 'salary_period',
        'warehouse_id', 'hired_on', 'notes', 'is_active', 'created_by',
      ],
      searchable: ['code', 'name', 'job_title', 'phone'],
      defaultSort: 'is_active DESC, name ASC',
    });
  }

  /**
   * Every employee with what they have been paid — the three questions an owner
   * actually asks, answered in one query: who is on the books, what went to
   * each of them this month, and when each was last paid up to.
   */
  async withPayments({ monthFrom, monthTo, activeOnly = false } = {}) {
    return this.db.prepare(`
      SELECT e.*, w.name_en AS branch_name_en, w.name_ar AS branch_name_ar,
             (SELECT COALESCE(SUM(k.amount), 0) FROM costs k WHERE k.employee_id = e.id) AS paid_total,
             (SELECT COALESCE(SUM(k.amount), 0) FROM costs k
               WHERE k.employee_id = e.id AND date(k.spent_on) BETWEEN date(?) AND date(?)) AS paid_in_range,
             (SELECT MAX(k.period_end) FROM costs k WHERE k.employee_id = e.id) AS paid_up_to,
             (SELECT MAX(k.spent_on) FROM costs k WHERE k.employee_id = e.id) AS last_paid_on
      FROM employees e
      LEFT JOIN warehouses w ON w.id = e.warehouse_id
      ${activeOnly ? 'WHERE e.is_active = 1' : ''}
      ORDER BY e.is_active DESC, e.name ASC
    `).all(monthFrom || '1900-01-01', monthTo || '2999-12-31');
  }

  /** One employee's salary payments — which are cost rows. */
  async payments(employeeId) {
    return getDb().prepare(`
      SELECT k.*, u.full_name AS created_by_name,
             w.name_en AS branch_name_en, w.name_ar AS branch_name_ar
      FROM costs k
      LEFT JOIN users u ON u.id = k.created_by
      JOIN warehouses w ON w.id = k.warehouse_id
      WHERE k.employee_id = ?
      ORDER BY k.period_end DESC, k.spent_on DESC, k.id DESC
    `).all(Number(employeeId));
  }
}

export default {
  CostRepository, CostCategoryRepository, RecurringCostRepository, EmployeeRepository,
};
