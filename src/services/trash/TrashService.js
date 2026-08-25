/**
 * سلة المهملات — the recycle bin.
 *
 * ── What it is ───────────────────────────────────────────────────────────────
 * One door for deleting anything in this shop, one register of what has been
 * deleted, and one way back. Before it, "delete" meant three different things
 * depending on where you pressed it: master data was quietly DEACTIVATED (the
 * owner pressed delete, read "تم الحفظ بنجاح", and the product was still
 * there); an unreferenced record was destroyed with no way back; and a document
 * with money in it could not be deleted at all, so a test invoice raised on the
 * first day of trading stayed in the accounts forever.
 *
 * ── The four acts ────────────────────────────────────────────────────────────
 *   preview  — what would happen, asked BEFORE anything happens. Blockers stop
 *              it; warnings are the things a person should know and may accept.
 *   remove   — reverse whatever has to be reversed (through the document's own
 *              service, audited), then hide it.
 *   restore  — un-hide. For master data that is the whole of it. For a document
 *              it brings back the RECORD, not the transaction — see below.
 *   purge    — the only step that destroys anything. After thirty days, and
 *              only if the record is still safe to destroy on that day.
 *
 * ── The promise, stated exactly ──────────────────────────────────────────────
 * RESTORING BRINGS BACK THE RECORD, NOT THE MONEY. A deleted invoice comes back
 * as a VOID invoice: its stock stays where the void put it and its money stays
 * reversed. Anything else would be a button that rewrites history, and there is
 * no version of that which is safe in a shop's books. The bin says so in both
 * languages before the person presses anything.
 *
 * ── Why the deleted rows stay in their own tables ────────────────────────────
 * A product stays in `products`, an invoice stays in `sales`. Moving them into
 * a bin table would break every foreign key pointing at them and every report
 * that has ever added them up. `trash_items` is the REGISTER — what was
 * deleted, by whom, when it may be purged, and what had to be reversed — and an
 * `in_bin` row in it is what hides the record from the screens it used to
 * appear on.
 */
import { getDb, transaction } from '../../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import auditService from '../AuditService.js';
import { buildPolicies } from './policies.js';

/** How long a deleted thing waits before it may be destroyed. */
export const RETENTION_DAYS = Number(process.env.MM_TRASH_RETENTION_DAYS || 30);

const now = () => new Date().toISOString();
const plusDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

export class TrashService {
  constructor(deps = {}) {
    this.policies = null;
    this.deps = deps;
    this.audit = deps.audit || auditService;
  }

  /**
   * The policy map, built on first use.
   *
   * Lazily, because the policies hold references to the services that own the
   * documents — sales, returns, purchases, inventory — and those import each
   * other. Building this at module load would be a circular import that
   * resolves to `undefined` at exactly the wrong moment.
   */
  async registry() {
    if (this.policies) return this.policies;
    const [sales, returns, purchases, inventory, costs] = await Promise.all([
      this.deps.sales || import('../SalesService.js').then((m) => m.default),
      this.deps.returns || import('../ReturnService.js').then((m) => m.default),
      this.deps.purchases || import('../PurchaseService.js').then((m) => m.default),
      this.deps.inventory || import('../InventoryService.js').then((m) => m.default),
      this.deps.costs || import('../CostService.js').then((m) => m.default),
    ]);
    this.policies = buildPolicies({
      sales, returns, purchases, inventory, costs,
    });
    return this.policies;
  }

  async policyFor(entityType) {
    const policy = (await this.registry()).get(entityType);
    if (!policy) throw new ValidationError(`"${entityType}" cannot be deleted from here`);
    return policy;
  }

  /** Everything this shop can put in the bin — for the screen's filter. */
  async kinds() {
    return [...(await this.registry()).values()].map((policy) => ({
      entityType: policy.entityType,
      module: policy.module,
      kind: policy.kind,
    }));
  }

  /**
   * What would happen. Nothing is changed by asking.
   *
   * Every delete goes through this first — including the one the delete button
   * itself performs, so a blocker cannot be skipped by calling the API directly.
   */
  async preview(entityType, entityId) {
    const policy = await this.policyFor(entityType);
    const row = await policy.load(Number(entityId));
    if (!row) throw new NotFoundError(entityType, entityId);

    const existing = await this.#liveEntry(entityType, entityId);
    if (existing) {
      throw new BusinessRuleError('This is already in the recycle bin');
    }

    const verdict = await policy.check(row);
    return {
      entityType,
      entityId: Number(entityId),
      module: policy.module,
      kind: policy.kind,
      label: policy.label(row),
      detail: policy.detail ? policy.detail(row) : null,
      ok: verdict.ok !== false,
      blockers: verdict.blockers || [],
      warnings: verdict.warnings || [],
      references: verdict.references || [],
      retentionDays: RETENTION_DAYS,
    };
  }

  /**
   * Delete: reverse what must be reversed, then hide it.
   *
   * One transaction. A reversal that succeeds while the register entry fails
   * would leave stock moved and nothing to explain it — the worst of both.
   */
  async remove(entityType, entityId, { reason = null, context = {} } = {}) {
    const policy = await this.policyFor(entityType);

    return transaction(async () => {
      const row = await policy.load(Number(entityId));
      if (!row) throw new NotFoundError(entityType, entityId);
      if (await this.#liveEntry(entityType, entityId)) {
        throw new BusinessRuleError('This is already in the recycle bin');
      }

      const verdict = await policy.check(row);
      if (verdict.ok === false) {
        const first = (verdict.blockers || [])[0];
        throw new BusinessRuleError(first ? first.en : 'This cannot be deleted');
      }

      const effect = await policy.remove(row, { ...context, reason });
      const label = policy.label(row);

      const inserted = await getDb().prepare(`
        INSERT INTO trash_items
          (module, entity_type, entity_id, label, detail, snapshot, effect, reason,
           status, deleted_at, deleted_by, purge_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_bin', ?, ?, ?)
      `).run(
        policy.module,
        entityType,
        Number(entityId),
        label,
        policy.detail ? policy.detail(row) : null,
        JSON.stringify(this.#snapshot(row)),
        JSON.stringify(effect || {}),
        reason,
        now(),
        context.actor?.id || null,
        plusDays(RETENTION_DAYS),
      );

      await this.audit.record({
        action: 'DELETE',
        module: policy.module,
        entityType,
        entityId: Number(entityId),
        entityLabel: label,
        after: { toRecycleBin: true, effect, reason },
        actor: context.actor,
        request: context.request,
      });

      return this.get(Number(inserted.lastInsertRowid));
    });
  }

  /** Put it back. What "back" means is the policy's to say. */
  async restore(id, { context = {} } = {}) {
    return transaction(async () => {
      const entry = await this.get(id);
      if (entry.status !== 'in_bin') {
        throw new BusinessRuleError('This entry is not in the recycle bin any more');
      }
      const policy = await this.policyFor(entry.entityType);
      const row = await policy.load(entry.entityId);
      if (!row) {
        throw new BusinessRuleError(
          'The record behind this entry is gone. It cannot be restored.',
        );
      }

      const result = await policy.restore(row, { ...context });

      await getDb().prepare(`
        UPDATE trash_items SET status = 'restored', restored_at = ?, restored_by = ?
        WHERE id = ?
      `).run(now(), context.actor?.id || null, id);

      await this.audit.record({
        action: 'RESTORE',
        module: entry.module,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: entry.label,
        after: result,
        actor: context.actor,
        request: context.request,
      });

      return { ...(await this.get(id)), result };
    });
  }

  /**
   * Destroy it.
   *
   * The dependency question is asked AGAIN here, on the day this runs: thirty
   * days is long enough for a product nobody could sell when it was deleted to
   * have been sold. A policy that refuses says why, and the entry stays in the
   * bin rather than half-destroyed.
   */
  async purge(id, { context = {}, force = false } = {}) {
    return transaction(async () => {
      const entry = await this.get(id);
      if (entry.status !== 'in_bin') {
        throw new BusinessRuleError('This entry is not in the recycle bin any more');
      }
      if (!force && entry.purgeAfter > now()) {
        throw new BusinessRuleError(
          `This may not be destroyed until ${entry.purgeAfter.slice(0, 10)}.`,
        );
      }

      const policy = await this.policyFor(entry.entityType);
      const row = await policy.load(entry.entityId);
      // Already gone: the register catches up rather than failing.
      const result = row ? await policy.purge(row, { ...context }) : { alreadyGone: true };

      await getDb().prepare(`
        UPDATE trash_items SET status = 'purged', purged_at = ?, purged_by = ?
        WHERE id = ?
      `).run(now(), context.actor?.id || null, id);

      await this.audit.record({
        action: 'PURGE',
        module: entry.module,
        entityType: entry.entityType,
        entityId: entry.entityId,
        entityLabel: entry.label,
        after: result,
        actor: context.actor,
        request: context.request,
      });

      return { ...(await this.get(id)), result };
    });
  }

  /**
   * Everything whose thirty days are up — destroyed in one sweep.
   *
   * Called by the scheduled job. One at a time and never fatal: a single entry
   * that cannot be destroyed (a product that has since been sold) must not stop
   * the ones behind it, and it stays in the bin with its reason recorded.
   */
  async sweep({ context = {} } = {}) {
    const due = await getDb().prepare(`
      SELECT id FROM trash_items WHERE status = 'in_bin' AND purge_after <= ?
      ORDER BY purge_after LIMIT 200
    `).all(now());

    const purged = [];
    const kept = [];
    for (const row of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.purge(row.id, { context });
        purged.push(row.id);
      } catch (error) {
        kept.push({ id: row.id, reason: error.message });
      }
    }
    return { due: due.length, purged: purged.length, kept };
  }

  async get(id) {
    const row = await getDb().prepare('SELECT * FROM trash_items WHERE id = ?').get(Number(id));
    if (!row) throw new NotFoundError('Recycle bin entry', id);
    return shape(row);
  }

  /** The bin, newest first. `status` defaults to what is still in it. */
  async list({
    status = 'in_bin', module = null, search = '', page = 1, pageSize = 50,
  } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
    if (module) { where.push('module = ?'); params.push(module); }
    if (search) {
      where.push('(label LIKE ? OR detail LIKE ? OR reason LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const clause = where.join(' AND ');
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const current = Math.max(Number(page) || 1, 1);

    const total = (await getDb()
      .prepare(`SELECT COUNT(*) AS n FROM trash_items WHERE ${clause}`)
      .get(...params)).n;

    const rows = await getDb().prepare(`
      SELECT t.*, u.full_name AS deleted_by_name
      FROM trash_items t
      LEFT JOIN users u ON u.id = t.deleted_by
      WHERE ${clause}
      ORDER BY t.deleted_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);

    return {
      rows: rows.map(shape),
      total,
      page: current,
      pageSize: size,
      pages: Math.ceil(total / size) || 1,
      retentionDays: RETENTION_DAYS,
    };
  }

  /** How full the bin is, and how much of it is about to be destroyed. */
  async summary() {
    const counts = await getDb().prepare(`
      SELECT module, COUNT(*) AS n FROM trash_items WHERE status = 'in_bin'
      GROUP BY module ORDER BY n DESC
    `).all();
    const soon = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM trash_items
      WHERE status = 'in_bin' AND purge_after <= ?
    `).get(plusDays(7));
    const total = counts.reduce((sum, row) => sum + Number(row.n), 0);
    return {
      inBin: total,
      byModule: counts.map((row) => ({ module: row.module, count: Number(row.n) })),
      dueWithin7Days: Number(soon?.n || 0),
      retentionDays: RETENTION_DAYS,
    };
  }

  async #liveEntry(entityType, entityId) {
    return getDb().prepare(
      "SELECT id FROM trash_items WHERE entity_type = ? AND entity_id = ? AND status = 'in_bin'",
    ).get(entityType, Number(entityId));
  }

  /**
   * Enough of the record to say what it was after it is gone — never the whole
   * aggregate. A sale's snapshot with every line and payment in it would put a
   * copy of the shop's books in a second table, and the row itself is still
   * there for as long as the entry is in the bin.
   */
  #snapshot(row) {
    const flat = {};
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;
      flat[key] = value;
    }
    return flat;
  }
}

function shape(row) {
  const parse = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
  return {
    id: row.id,
    module: row.module,
    entityType: row.entity_type,
    entityId: row.entity_id,
    label: row.label,
    detail: row.detail,
    reason: row.reason,
    status: row.status,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deletedByName: row.deleted_by_name || null,
    purgeAfter: row.purge_after,
    restoredAt: row.restored_at,
    purgedAt: row.purged_at,
    effect: parse(row.effect),
    snapshot: parse(row.snapshot),
  };
}

/**
 * Hides what is in the bin.
 *
 * Every list that can show a deletable record asks this once, as a `NOT EXISTS`
 * against an indexed lookup. Written here rather than in fifteen repositories
 * so that the definition of "deleted" is one sentence in one place.
 */
export { notInBin } from '../../shared/trashFilter.js';

export const trashService = new TrashService();
export default trashService;
