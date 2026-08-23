/**
 * Round 5: clicking Save twice must not make two purchase orders.
 *
 * The table itself is in `schema.js`, which is re-applied on every start and is
 * all `CREATE … IF NOT EXISTS` — so a shop PC and the hosted default database
 * both get it without this file. A TENANT's database does not: nothing applies
 * `schema.js` to it per request, only `platform/migrateAll.js` does, and that
 * runs `applySchema()` *and* the migrations together. Having a numbered
 * migration here is what makes the fleet sweep report the change, and what
 * carries a database restored from a backup taken before it.
 *
 * Idempotent for the same reason everything here is: the DDL is `IF NOT
 * EXISTS`, so applying it to a database that already has the table is a no-op.
 * Split into one `ddl()` call per statement because migrations run inside a
 * transaction and `exec()` would open a second writer against the same file.
 */
import { REQUEST_REPLAY_SQL } from '../../../shared/requestReplay.js';

export default {
  name: '010-request-replay',

  async up({ ddl }) {
    for (const statement of REQUEST_REPLAY_SQL.split(';')) {
      const sql = statement.trim();
      if (sql) await ddl(sql);
    }
  },
};
