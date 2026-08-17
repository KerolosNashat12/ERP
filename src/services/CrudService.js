/**
 * Reusable CRUD use-case for master data (suppliers, brands, categories,
 * warehouses, customers, attributes...). It owns the cross-cutting concerns —
 * uniqueness, auto-codes, audit trail, soft delete when a record is referenced.
 * Modules with genuinely different behaviour subclass it instead of copying it.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { ConflictError, BusinessRuleError } from '../shared/errors.js';
import auditService from './AuditService.js';

export class CrudService {
  /**
   * @param {object} options
   * @param {import('../infrastructure/repositories/BaseRepository.js').BaseRepository} options.repository
   * @param {string} options.module          permission/audit module key
   * @param {string} options.entityType      audit entity type
   * @param {string} [options.labelField]    field used as the human label in the audit log
   * @param {string[]} [options.uniqueFields]
   * @param {string} [options.codePrefix]    enables automatic code generation
   * @param {(id:number)=>Promise<boolean>} [options.isReferenced] guard for hard deletes
   */
  constructor(options) {
    this.repository = options.repository;
    this.module = options.module;
    this.entityType = options.entityType;
    this.labelField = options.labelField || 'name_en';
    this.uniqueFields = options.uniqueFields || ['code'];
    this.codePrefix = options.codePrefix || null;
    this.isReferenced = options.isReferenced || (async () => false);
    this.audit = options.audit || auditService;
  }

  async list(query) {
    return this.repository.list(query);
  }

  async options() {
    return this.repository.activeOnly();
  }

  async get(id) {
    return this.repository.requireById(id, this.entityType);
  }

  label(row) {
    return row?.[this.labelField] || row?.name || row?.code || String(row?.id ?? '');
  }

  async generateCode() {
    const existing = await this.repository.count();
    let attempt = existing + 1;
    let code = `${this.codePrefix}-${String(attempt).padStart(4, '0')}`;
    while (await this.repository.exists('code', code)) {
      attempt += 1;
      code = `${this.codePrefix}-${String(attempt).padStart(4, '0')}`;
    }
    return code;
  }

  async assertUnique(data, excludeId = null) {
    for (const field of this.uniqueFields) {
      const value = data[field];
      if (value === undefined || value === null || value === '') continue;
      if (await this.repository.exists(field, value, excludeId)) {
        throw new ConflictError(`${field.replace('_', ' ')} "${value}" is already used`);
      }
    }
  }

  /**
   * Hook for subclasses — runs before insert/update inside the transaction.
   * Awaited by the callers, so an override may query the database.
   */
  async beforeSave(data) {
    return data;
  }

  async create(data, context = {}) {
    return transaction(async () => {
      const payload = await this.beforeSave({ ...data });
      if (this.codePrefix && !payload.code) payload.code = await this.generateCode();
      await this.assertUnique(payload);
      if (context.actor?.id && this.repository.columns.includes('created_by')) {
        payload.created_by = context.actor.id;
      }
      const created = await this.repository.create(payload);
      await this.audit.recordChange(context, {
        action: 'CREATE',
        module: this.module,
        entityType: this.entityType,
        entityId: created.id,
        entityLabel: this.label(created),
        after: created,
      });
      return created;
    });
  }

  async update(id, data, context = {}) {
    return transaction(async () => {
      const before = await this.repository.requireById(id, this.entityType);
      const payload = await this.beforeSave({ ...data }, before);
      await this.assertUnique(payload, id);
      const after = await this.repository.update(id, payload);
      await this.audit.recordChange(context, {
        action: 'UPDATE',
        module: this.module,
        entityType: this.entityType,
        entityId: id,
        entityLabel: this.label(after),
        before,
        after,
      });
      return after;
    });
  }

  /**
   * Deleting master data that historic documents point at would corrupt the
   * ledger, so referenced records are deactivated instead of removed.
   */
  async remove(id, context = {}) {
    return transaction(async () => {
      const before = await this.repository.requireById(id, this.entityType);
      const referenced = await this.isReferenced(id);
      if (referenced && !this.repository.columns.includes('is_active')) {
        throw new BusinessRuleError('This record is used by existing documents and cannot be deleted');
      }
      if (referenced) {
        const after = await this.repository.deactivate(id);
        await this.audit.recordChange(context, {
          action: 'DEACTIVATE',
          module: this.module,
          entityType: this.entityType,
          entityId: id,
          entityLabel: this.label(before),
          before,
          after,
        });
        return { deleted: false, deactivated: true, record: after };
      }
      await this.repository.remove(id);
      await this.audit.recordChange(context, {
        action: 'DELETE',
        module: this.module,
        entityType: this.entityType,
        entityId: id,
        entityLabel: this.label(before),
        before,
      });
      return { deleted: true, deactivated: false };
    });
  }
}

/** Small helper used by the factories below to test references cheaply. */
export const referencedBy = (table, column) => async (id) => {
  const db = repositories.suppliers.db;
  return Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id));
};

// `some()` cannot await, and short-circuiting is the point: stop at the first hit.
export const referencedByAny = (checks) => async (id) => {
  for (const check of checks) {
    if (await check(id)) return true;
  }
  return false;
};

export default CrudService;
