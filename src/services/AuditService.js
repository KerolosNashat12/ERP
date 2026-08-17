/**
 * Audit trail. Every service that mutates data calls `record()`; nothing writes
 * to audit_logs directly. Snapshots are stored as JSON so a reviewer can see
 * exactly which fields changed.
 */
import repositories from '../infrastructure/repositories/index.js';

const MAX_SNAPSHOT_CHARS = 8000;
const REDACTED_FIELDS = new Set(['password', 'password_hash', 'confirm_password']);

function sanitise(data) {
  if (!data || typeof data !== 'object') return data;
  const clone = Array.isArray(data) ? [...data] : { ...data };
  for (const key of Object.keys(clone)) {
    if (REDACTED_FIELDS.has(key)) clone[key] = '***';
    else if (clone[key] && typeof clone[key] === 'object') clone[key] = sanitise(clone[key]);
  }
  return clone;
}

function serialise(data) {
  if (data === undefined || data === null) return null;
  const json = JSON.stringify(sanitise(data));
  return json.length > MAX_SNAPSHOT_CHARS ? `${json.slice(0, MAX_SNAPSHOT_CHARS)}…(truncated)` : json;
}

/** Fields that actually changed — keeps UPDATE entries readable. */
export function diff(before, after) {
  if (!before || !after) return { before, after };
  const changedBefore = {};
  const changedAfter = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at') continue;
    if (String(before[key] ?? '') !== String(after[key] ?? '')) {
      changedBefore[key] = before[key];
      changedAfter[key] = after[key];
    }
  }
  return { before: changedBefore, after: changedAfter };
}

export class AuditService {
  constructor(auditRepository = repositories.audit) {
    this.repository = auditRepository;
  }

  /**
   * @param {object} p
   * @param {object} p.actor    { id, username } — the signed-in user
   * @param {string} p.action   CREATE | UPDATE | DELETE | LOGIN | LOGOUT | POST | VOID | ...
   * @param {string} p.module   module key from shared/permissions.js
   */
  async record({ actor, action, module, entityType, entityId, entityLabel, before, after,
    status = 'SUCCESS', message, request } = {}) {
    await this.repository.write({
      user_id: actor?.id ?? null,
      username: actor?.username ?? null,
      action,
      module,
      entity_type: entityType ?? null,
      entity_id: entityId != null ? String(entityId) : null,
      entity_label: entityLabel ?? null,
      before_data: serialise(before),
      after_data: serialise(after),
      status,
      message: message ?? null,
      ip_address: request?.ip ?? null,
      user_agent: request?.userAgent ?? null,
    });
  }

  async recordChange(context, { module, entityType, entityId, entityLabel, before, after, action }) {
    const changes = action === 'UPDATE' ? diff(before, after) : { before, after };
    await this.record({
      actor: context?.actor,
      request: context?.request,
      action,
      module,
      entityType,
      entityId,
      entityLabel,
      before: changes.before,
      after: changes.after,
    });
  }

  async list(query) {
    return this.repository.list(query);
  }

  async filters() {
    return this.repository.distinctValues();
  }

  async activitySummary(days) {
    return this.repository.activitySummary(days);
  }
}

export const auditService = new AuditService();
export default auditService;
