/**
 * Round 7: صفحة فواتيرك — the invoices the shop already had on paper.
 *
 * Two things, in the order they have to happen:
 *
 *  1. The two tables. They are also in `schema.js` (re-applied on every start,
 *     all `CREATE … IF NOT EXISTS`), so a shop PC and the hosted default
 *     database would get them without this file. A TENANT's database would not
 *     until `platform/migrateAll.js` swept it, and a database restored from an
 *     older backup would not either — that is what the numbered migration is
 *     for. One `ddl()` call per statement because migrations run inside a
 *     transaction and `exec()` would open a second writer.
 *
 *     There is no backfill and there can never be one: these rows are paper the
 *     shop is holding, and nothing already in the database is one of them.
 *     Inventing them from `purchase_orders` is exactly the double-count the
 *     whole feature exists to avoid — see shared/legacyInvoices.js.
 *
 *  2. The new module's permissions, granted to the roles that already hold the
 *     rights they were carved out of. `syncPermissionCatalogue()` grants new
 *     codes to `admin` alone, and `seedBaseline()` — which rebuilds every
 *     system role — does not run on a database that already has users. Without
 *     this step an upgraded shop would find that only the administrator could
 *     open the page.
 *
 *     SEEING the archive follows the right to read the books (`audit.view` —
 *     the manager and the accountant), the same choice migration 012 made for
 *     `costs.view` and for the same reason: an auditor who cannot see what the
 *     shop still owes on its old invoices cannot audit anything, while a stock
 *     clerk (who holds `purchases.view` and `reports.view`) has no business
 *     reading what the owner paid his suppliers before the system existed.
 *     FILING one and recording money against it follow the right to commit the
 *     shop's money (`purchases.approve` — the manager); DELETING a record and
 *     REVERSING a payment follow the right to undo a document
 *     (`purchases.delete`), which is the split `purchases` itself uses.
 */
import { LEGACY_INVOICES_SQL } from '../../../shared/legacyInvoices.js';

const GRANTS = [
  { code: 'legacy_invoices.view', follows: 'audit.view' },
  { code: 'legacy_invoices.create', follows: 'purchases.approve' },
  { code: 'legacy_invoices.update', follows: 'purchases.approve' },
  { code: 'legacy_invoices.pay', follows: 'purchases.approve' },
  { code: 'legacy_invoices.delete', follows: 'purchases.delete' },
  { code: 'legacy_invoices.reverse_payment', follows: 'purchases.delete' },
];

export default {
  name: '015-legacy-invoices',

  async up({ getDb, ddl }) {
    for (const sql of LEGACY_INVOICES_SQL.split(';')) {
      const statement = sql.trim();
      if (statement) await ddl(statement);
    }

    const db = getDb();
    for (const grant of GRANTS) {
      const [module, action] = grant.code.split('.');
      await db.prepare(`
        INSERT INTO permissions (code, module, action, description)
        VALUES (?, ?, ?, ?) ON CONFLICT(code) DO NOTHING
      `).run(grant.code, module, action, `${action} in ${module}`);

      await db.prepare(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
        SELECT rp.role_id, (SELECT id FROM permissions WHERE code = ?)
        FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        WHERE p.code = ?
      `).run(grant.code, grant.follows);
    }
  },
};
