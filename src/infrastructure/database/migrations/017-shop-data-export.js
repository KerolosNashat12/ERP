/**
 * The shop's own door to its own data — the permission that opens it.
 *
 * `settings.export_data` is new in this release. On a NEW shop it arrives with
 * everything else: `seedBaseline()` writes every code in `shared/permissions.js`
 * and gives the administrator role all of them. On a shop that already exists it
 * would arrive nowhere at all — `syncPermissionCatalogue()` runs against the
 * deployment's own database on boot, and a tenant's database only ever sees
 * `runMigrations()`. Without this file the feature would ship, deploy, answer on
 * its API, and every shop on the fleet would get 403 from a button they can see.
 * That is the exact failure `platform/moduleUpgrade.js` was written about, one
 * layer down.
 *
 * Granted to the ADMINISTRATOR ROLE ALONE, and to no role that merely resembles
 * it. The other migrations here grant a new code to whoever already holds the
 * right it was carved out of — `legacy_invoices.view` follows `audit.view`,
 * `purchases.pay` follows `purchases.approve` — because those are rights inside
 * the shop, and the person who could already do the neighbouring thing is the
 * right person. This one is not a right inside the shop: it produces one file
 * holding every price, every cost, every customer's phone number and every
 * salary, and once it exists it is on a laptop. So there is no `follows` here,
 * and `UNDELEGATABLE` in shared/permissions.js stops the role editor handing it
 * out afterwards. A shop that wants a second person able to take a copy makes
 * that person an administrator — a deliberate act, visible on the Users screen.
 *
 * `settings.backup` is untouched: on a shop PC it still means "copy the database
 * file to this machine", it still works there, and nobody loses it.
 */
const CODE = 'settings.export_data';

export default {
  name: '017-shop-data-export',

  async up({ getDb }) {
    const db = getDb();
    const [module, action] = CODE.split('.');

    await db.prepare(`
      INSERT INTO permissions (code, module, action, description)
      VALUES (?, ?, ?, ?) ON CONFLICT(code) DO NOTHING
    `).run(CODE, module, action, `${action} in ${module}`);

    await db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
        FROM roles r, permissions p
       WHERE r.code = 'admin' AND p.code = ?
    `).run(CODE);
  },
};
