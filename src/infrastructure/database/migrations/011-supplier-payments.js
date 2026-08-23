/**
 * Round 5: a supplier payment becomes a row, and can carry a photograph.
 *
 * Three things, in the order they have to happen:
 *
 *  1. The two tables. They are also in `schema.js` (which is re-applied on
 *     every start and is all `CREATE … IF NOT EXISTS`), so a shop PC and the
 *     hosted default database would get them without this file. A TENANT's
 *     database would not until `platform/migrateAll.js` swept it, and a
 *     database restored from an older backup would not either — that is what
 *     the numbered migration is for. One `ddl()` call per statement because
 *     migrations run inside a transaction and `exec()` would open a second
 *     writer against the same database.
 *
 *  2. The backfill, which is the interesting part. Every existing order whose
 *     `paid_amount` is above zero was paid by somebody, at some point, and
 *     nothing recorded it. From now on `paid_amount` is derived — it is the sum
 *     of the payment rows — so an order with 12,000 paid and no rows would read
 *     as unpaid the first time anything recomputed it, and the supplier balance
 *     on the reports would jump overnight. One row per such order carries the
 *     old number across, dated the day the order was raised and marked in its
 *     note as what it is: a total that predates the payment log, not a payment
 *     anybody witnessed.
 *
 *  3. The two new permissions, granted to the roles that already hold the
 *     rights they were carved out of. Recording money out used to travel with
 *     `purchases.approve` (committing the shop to the spend); reversing one
 *     travels with `purchases.delete` (undoing a document). Without this step
 *     an upgraded shop would find that only the administrator could pay a
 *     supplier, because `syncPermissionCatalogue()` grants new codes to `admin`
 *     alone and `seedBaseline()` — which rebuilds every system role — does not
 *     run on a database that already has users.
 */
import { ATTACHMENTS_SQL } from '../../../shared/attachments.js';
import { PURCHASE_PAYMENTS_SQL } from '../../../shared/supplierPayments.js';

/** `purchases.pay` follows the right to commit the spend; the reversal follows the right to undo. */
const GRANTS = [
  { code: 'purchases.pay', follows: 'purchases.approve' },
  { code: 'purchases.reverse_payment', follows: 'purchases.delete' },
];

export default {
  name: '011-supplier-payments',

  async up({ getDb, ddl }) {
    for (const sql of [...PURCHASE_PAYMENTS_SQL.split(';'), ...ATTACHMENTS_SQL.split(';')]) {
      const statement = sql.trim();
      if (statement) await ddl(statement);
    }

    const db = getDb();

    // Idempotent by construction: an order that already has a payment row is
    // skipped, so re-running this on a half-migrated database adds nothing.
    await db.prepare(`
      INSERT INTO purchase_payments (purchase_order_id, paid_on, amount, method, note, created_by, created_at)
      SELECT po.id, po.order_date, ROUND(po.paid_amount, 2), 'unknown',
             'Recorded before payments were kept individually', po.created_by, po.created_at
      FROM purchase_orders po
      WHERE po.paid_amount > 0
        AND NOT EXISTS (SELECT 1 FROM purchase_payments p WHERE p.purchase_order_id = po.id)
    `).run();

    for (const grant of GRANTS) {
      await db.prepare(`
        INSERT INTO permissions (code, module, action, description)
        VALUES (?, 'purchases', ?, ?)
        ON CONFLICT(code) DO NOTHING
      `).run(grant.code, grant.code.split('.')[1], `${grant.code.split('.')[1]} in purchases`);

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
