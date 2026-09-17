/**
 * بطاقة، صورة، فيش جنائي، شهادة جامعية، استمارة طبية، وغيرها — one employee's
 * paperwork.
 *
 * Its own table (`employee_documents`) rather than columns on `employees`, for
 * the same reason `costs` is a table and not six columns on `warehouses`: an
 * employee can have more than one of a kind — a renewed criminal-record
 * certificate should not erase the old one's history — and most employees will
 * have none of this on day one. The photograph or scan of each document is an
 * attachment, through the one mechanism every other photograph in this system
 * already uses (see AttachmentService.js) — this file adds no second way to
 * store a picture, only a new kind of owner for the existing one.
 *
 * Read and written under `employees.view` / `employees.update` — managing
 * somebody's paperwork is the same right as editing their record, the same
 * way a salary payment's receipt photo is `costs.update` and not a right of
 * its own.
 */
import repositories from '../infrastructure/repositories/index.js';
import { transaction } from '../infrastructure/database/connection.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import auditService from './AuditService.js';
import attachmentService from './AttachmentService.js';

export const DOCUMENT_TYPES = ['id_card', 'photo', 'criminal_record', 'degree', 'medical_form', 'other'];

attachmentService.registerOwner('employee_document', {
  module: 'employees',
  view: 'employees.view',
  attach: 'employees.update',
  exists: async (id) => Boolean(await repositories.employeeDocuments.findById(Number(id))),
  label: async (id) => {
    const row = await repositories.employeeDocuments.findById(Number(id));
    if (!row) return `employee document ${id}`;
    return row.label ? `${row.doc_type} — ${row.label}` : row.doc_type;
  },
});

export class EmployeeDocumentService {
  constructor(deps = {}) {
    this.documents = deps.documents || repositories.employeeDocuments;
    this.employees = deps.employees || repositories.employees;
    this.audit = deps.audit || auditService;
  }

  #validateType(docType) {
    if (!DOCUMENT_TYPES.includes(docType)) {
      throw new ValidationError(`A document type is one of: ${DOCUMENT_TYPES.join(', ')}`);
    }
  }

  #validateDates(issuedOn, expiresOn) {
    if (issuedOn && expiresOn && expiresOn < issuedOn) {
      throw new ValidationError('A document cannot expire before it was issued');
    }
  }

  /** One employee's documents, each with its photograph (if any). */
  async list(employeeId) {
    await this.employees.requireById(Number(employeeId), 'employee');
    const rows = await this.documents.forEmployee(employeeId);
    const byDoc = await attachmentService.listMany('employee_document', rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, attachments: byDoc[row.id] || [] }));
  }

  async add(employeeId, payload = {}, context = {}) {
    return transaction(async () => {
      const employee = await this.employees.findById(Number(employeeId));
      if (!employee) throw new NotFoundError('Employee', employeeId);
      this.#validateType(payload.doc_type);
      // 'other' needs a name to mean anything in a list — the five fixed
      // types already have one, which is the type itself.
      if (payload.doc_type === 'other' && !payload.label) {
        throw new ValidationError('Name this document');
      }
      this.#validateDates(payload.issued_on || null, payload.expires_on || null);

      const created = await this.documents.create({
        employee_id: employee.id,
        doc_type: payload.doc_type,
        label: payload.label || null,
        issued_on: payload.issued_on || null,
        expires_on: payload.expires_on || null,
        notes: payload.notes || null,
        created_by: context.actor?.id || null,
      });

      if (payload.photo?.dataUrl) {
        await attachmentService.attach('employee_document', created.id, payload.photo, context);
      }

      await this.audit.record({
        action: 'CREATE',
        module: 'employees',
        entityType: 'employee_document',
        entityId: created.id,
        entityLabel: `${employee.name} — ${payload.doc_type}`,
        after: { ...created, has_photo: Boolean(payload.photo?.dataUrl) },
        actor: context.actor,
        request: context.request,
      });
      return created;
    });
  }

  async update(id, payload = {}, context = {}) {
    return transaction(async () => {
      const before = await this.documents.requireById(id, 'employee document');
      if (payload.doc_type !== undefined) this.#validateType(payload.doc_type);
      const issuedOn = payload.issued_on !== undefined ? payload.issued_on : before.issued_on;
      const expiresOn = payload.expires_on !== undefined ? payload.expires_on : before.expires_on;
      this.#validateDates(issuedOn || null, expiresOn || null);

      const after = await this.documents.update(id, payload);
      if (payload.photo?.dataUrl) {
        await attachmentService.attach('employee_document', before.id, payload.photo, context);
      }

      await this.audit.recordChange(context, {
        action: 'UPDATE',
        module: 'employees',
        entityType: 'employee_document',
        entityId: before.id,
        entityLabel: after.doc_type,
        before,
        after,
      });
      return after;
    });
  }

  /** A document, gone — with its photograph. See CostService#remove for the same shape. */
  async remove(id, context = {}) {
    return transaction(async () => {
      const before = await this.documents.requireById(id, 'employee document');
      await attachmentService.detachAll('employee_document', before.id, context);
      await this.documents.remove(before.id);
      await this.audit.record({
        action: 'DELETE',
        module: 'employees',
        entityType: 'employee_document',
        entityId: before.id,
        entityLabel: before.doc_type,
        before,
        actor: context.actor,
        request: context.request,
      });
      return { deleted: true };
    });
  }

  /** Documents expiring within `withinDays` (or already expired) — the renewal reminder. */
  async expiring({ withinDays = 30 } = {}) {
    return this.documents.expiring(withinDays);
  }
}

export const employeeDocumentService = new EmployeeDocumentService();
export default employeeDocumentService;
