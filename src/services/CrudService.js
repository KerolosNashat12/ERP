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
   * @param {(id:number)=>boolean} [options.isReferenced] guard for hard deletes
   */
  constructor(options) {
    this.repository = options.repository;
    this.module = options.module;
    this.entityType = options.entityType;
    this.labelField = options.labelField || 'name_en';
    this.uniqueFields = options.uniqueFields || ['code'];
    this.codePrefix = options.codePrefix || null;
    this.isReferenced = options.isReferenced || (() => false);
    this.audit = options.audit || auditService;
  }

  list(query) {
    return this.repository.list(query);
  }

  options() {
    return this.repository.activeOnly();
  }

  get(id) {
    return this.repository.requireById(id, this.entityType);
  }

  label(row) {
    return row?.[this.labelField] || row?.name || row?.code || String(row?.id ?? '');
  }

  generateCode() {
    const existing = this.repository.count();
    let attempt = existing + 1;
    let code = `${this.codePrefix}-${String(attempt).padStart(4, '0')}`;
    while (this.repository.exists('code', code)) {
      attempt += 1;
      code = `${this.codePrefix}-${String(attempt).padStart(4, '0')}`;
    }
    return code;
  }

  assertUnique(data, excludeId = null) {
    for (const field of this.uniqueFields) {
      const value = data[field];
      if (value === undefined || value === null || value === '') continue;
      if (this.repository.exists(field, value, excludeId)) {
        throw new ConflictError(`${field.replace('_', ' ')} "${value}" is already used`);
      }
    }
  }

  /** Hook for subclasses — runs before insert/update inside the transaction. */
  beforeSave(data) {
    return data;
  }

  create(data, context = {}) {
    return transaction(() => {
      const payload = this.beforeSave({ ...data });
      if (this.codePrefix && !payload.code) payload.code = this.generateCode();
      this.assertUnique(payload);
      if (context.actor?.id && this.repository.columns.includes('created_by')) {
        payload.created_by = context.actor.id;
      }
      const created = this.repository.create(payload);
      this.audit.recordChange(context, {
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

  update(id, data, context = {}) {
    return transaction(() => {
      const before = this.repository.requireById(id, this.entityType);
      const payload = this.beforeSave({ ...data }, before);
      this.assertUnique(payload, id);
      const after = this.repository.update(id, payload);
      this.audit.recordChange(context, {
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
  remove(id, context = {}) {
    return transaction(() => {
      const before = this.repository.requireById(id, this.entityType);
      const referenced = this.isReferenced(id);
      if (referenced && !this.repository.columns.includes('is_active')) {
        throw new BusinessRuleError('This record is used by existing documents and cannot be deleted');
      }
      if (referenced) {
        const after = this.repository.deactivate(id);
        this.audit.recordChange(context, {
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
      this.repository.remove(id);
      this.audit.recordChange(context, {
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
export const referencedBy = (table, column) => (id) => {
  const db = repositories.suppliers.db;
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id));
};

export const referencedByAny = (checks) => (id) => checks.some((check) => check(id));

export default CrudService;
