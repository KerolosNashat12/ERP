/**
 * Round 13, second half: the permissions behind الهدر and سلة المهملات.
 *
 * Both shipped as MODULES rather than as corners of ones that already existed —
 * the platform sells modules, and the shop's owner asked for these two by name
 * and wants them switchable per shop from the console. A module with no rows in
 * `permissions` is a module nothing can be granted for, and `requirePermission`
 * would answer 403 to the administrator himself.
 *
 * ── Who gets them ────────────────────────────────────────────────────────────
 * The administrator gets all five. Below him the split follows what the actions
 * actually cost:
 *
 *   `wastage.view`     — anybody who may already look at the stock. Knowing what
 *                        the shop lost is the same order of secret as knowing
 *                        what it holds.
 *   `wastage.record`   — whoever may adjust stock. Writing four bottles off IS
 *                        an adjustment, and must not be a looser door onto the
 *                        same shelf.
 *   `trash.view`       — whoever may see the audit log: the bin is a record of
 *                        who deleted what, which is the same kind of question.
 *   `trash.restore`    — deliberately NOT handed out by this migration beyond
 *                        the administrator. Restoring puts a hidden record back
 *                        on screens other people read.
 *   `trash.purge`      — the administrator only, and nobody else, ever, by
 *                        default. It is the one irreversible button in this
 *                        system that a person can reach.
 *
 * Nothing here widens a role the shop's own administrator narrowed: each grant
 * is conditional on the role ALREADY holding the right this one was carved out
 * of, which is the same rule migrations 011 and 015 follow.
 */
const GRANTS = [
  { code: 'wastage.view', module: 'wastage', action: 'view', from: 'inventory.view' },
  { code: 'wastage.record', module: 'wastage', action: 'record', from: 'inventory.adjust' },
  { code: 'trash.view', module: 'trash', action: 'view', from: 'audit.view' },
  { code: 'trash.restore', module: 'trash', action: 'restore', from: null },
  { code: 'trash.purge', module: 'trash', action: 'purge', from: null },
];

export default {
  name: '020-wastage-and-trash-permissions',

  async up({ getDb }) {
    const db = getDb();

    for (const grant of GRANTS) {
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(`
        INSERT INTO permissions (code, module, action, description)
        VALUES (?, ?, ?, ?) ON CONFLICT(code) DO NOTHING
      `).run(grant.code, grant.module, grant.action, `${grant.action} in ${grant.module}`);

      // The administrator, always.
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = 'admin' AND p.code = ?
      `).run(grant.code);

      if (!grant.from) continue;

      /*
       * And anybody who already holds the right this one was carved out of —
       * but only them. A role the owner narrowed stays narrow.
       */
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
        SELECT rp.role_id, p.id
          FROM role_permissions rp
          JOIN permissions source ON source.id = rp.permission_id AND source.code = ?
          JOIN permissions p ON p.code = ?
      `).run(grant.from, grant.code);
    }
  },
};
