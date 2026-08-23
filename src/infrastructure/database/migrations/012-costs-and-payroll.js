/**
 * Round 6: صفحة التكاليف — what the shop spends — and the people it pays.
 *
 * Four things, in the order they have to happen:
 *
 *  1. The tables. They are also in `schema.js` (re-applied on every start, all
 *     `CREATE … IF NOT EXISTS`), so a shop PC and the hosted default database
 *     would get them without this file. A TENANT's database would not until
 *     `platform/migrateAll.js` swept it, and a database restored from an older
 *     backup would not either — that is what the numbered migration is for.
 *     One `ddl()` call per statement because migrations run inside a
 *     transaction and `exec()` would open a second writer.
 *
 *  2. The categories, bilingual. Seeded rather than hard-coded: they are
 *     ordinary rows the owner renames, hides and adds to. `ON CONFLICT(code)`
 *     leaves a shop's own edits alone if this ever runs twice — it updates
 *     nothing, so a category renamed to "كهربا" stays renamed.
 *
 *  3. The salary category is guaranteed to exist and to be `kind = 'salary'`.
 *     Payroll needs one place to file wages and must not invent it at runtime.
 *
 *  4. The two new modules' permissions, granted to the roles that already hold
 *     the rights they were carved out of — `syncPermissionCatalogue()` grants
 *     new codes to `admin` alone, and `seedBaseline()` (which rebuilds every
 *     system role) does not run on a database that already has users. Without
 *     this step an upgraded shop would find that only the administrator could
 *     see the costs page.
 *
 *     Spending the shop's money follows the right to commit it
 *     (`purchases.approve` — the manager). *Seeing* what was spent follows the
 *     right to read the books (`audit.view` — the manager and the accountant),
 *     because an auditor who cannot see the electricity bill cannot audit
 *     anything. Nobody else gains sight of the payroll by accident: a stock
 *     clerk holds `reports.view` and would have been swept in by any grant
 *     hung off that.
 */
import { COSTS_SQL, COST_CATEGORY_SEED, SALARY_CATEGORY_CODE } from '../../../shared/costs.js';

const GRANTS = [
  { code: 'costs.view', follows: 'audit.view' },
  { code: 'costs.create', follows: 'purchases.approve' },
  { code: 'costs.update', follows: 'purchases.approve' },
  { code: 'costs.delete', follows: 'purchases.approve' },
  { code: 'employees.view', follows: 'audit.view' },
  { code: 'employees.create', follows: 'purchases.approve' },
  { code: 'employees.update', follows: 'purchases.approve' },
  { code: 'employees.delete', follows: 'purchases.approve' },
  { code: 'employees.pay', follows: 'purchases.approve' },
];

export default {
  name: '012-costs-and-payroll',

  async up({ getDb, ddl }) {
    for (const sql of COSTS_SQL.split(';')) {
      const statement = sql.trim();
      if (statement) await ddl(statement);
    }

    const db = getDb();

    const insertCategory = db.prepare(`
      INSERT INTO cost_categories (code, name_en, name_ar, kind, display_order, is_system)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO NOTHING
    `);
    for (const row of COST_CATEGORY_SEED) {
      await insertCategory.run(
        row.code, row.name_en, row.name_ar, row.kind, row.display_order, row.is_system,
      );
    }

    // A shop that somehow has the category under another kind still gets a
    // usable payroll: the marker is what the code looks for, not the code.
    await db.prepare(`
      UPDATE cost_categories SET kind = 'salary', is_system = 1 WHERE code = ?
    `).run(SALARY_CATEGORY_CODE);

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
