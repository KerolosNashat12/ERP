/**
 * What a cost is FOR — كهرباء، مياه، ضرايب، إيجار، معدات، صيانة، مرتبات …
 *
 * Ordinary master data on purpose. A hard-coded list is a list the owner cannot
 * extend, and every shop spends money on something the list did not think of;
 * the seed (shared/costs.js) gives him twelve bilingual rows to start from and
 * the same create/edit/delete every other reference table has.
 *
 * Two rules of its own:
 *   · The salary category cannot be deleted or deactivated. Payroll needs one
 *     place to file wages and must not be able to lose it mid-month.
 *   · A category historic costs point at is deactivated rather than removed —
 *     inherited from CrudService, and the reason is the same as everywhere
 *     else: deleting it would leave last March's electricity bill filed under
 *     nothing.
 */
import repositories from '../infrastructure/repositories/index.js';
import { CrudService, referencedBy } from './CrudService.js';
import { BusinessRuleError } from '../shared/errors.js';

export class CostCategoryService extends CrudService {
  constructor() {
    super({
      repository: repositories.costCategories,
      module: 'costs',
      entityType: 'cost_category',
      codePrefix: 'CST',
      isReferenced: referencedBy('costs', 'category_id'),
    });
  }

  async list(query) {
    if (query?.all) return { rows: await this.repository.listWithCounts(), total: undefined };
    return super.list(query);
  }

  /** `kind` is not the caller's to set: there is one salary category, seeded. */
  async beforeSave(data, before) {
    const payload = { ...data };
    payload.kind = before?.kind || 'general';
    if (before?.is_system) payload.is_system = 1;
    return payload;
  }

  async remove(id, context = {}) {
    const before = await this.repository.requireById(id, 'cost category');
    if (before.kind === 'salary' || before.is_system) {
      throw new BusinessRuleError('The salaries category is part of the payroll and cannot be removed');
    }
    return super.remove(id, context);
  }
}

export const costCategoryService = new CostCategoryService();
export default costCategoryService;
