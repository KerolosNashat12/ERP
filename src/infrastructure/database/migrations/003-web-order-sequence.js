/**
 * The counter that numbers web orders.
 *
 * `002-web-orders` created the tables; the sequence row lives with the other
 * document counters in `seed.js`, which only runs on a database that is being
 * built from nothing. A shop that migrated before this feature shipped is
 * already seeded, so it would never get the row — and the first customer to
 * press "order" would meet `Unknown sequence: web_order`.
 *
 * Hence a migration: it runs exactly once on every existing database, and is a
 * no-op on a fresh one that the seed has already served.
 */
export default {
  name: '003-web-order-sequence',

  async up({ ddl }) {
    await ddl(`
      INSERT INTO sequences (name, prefix, next_value, padding, reset_yearly, year)
      VALUES ('web_order', 'WEB', 1, 5, 1, CAST(strftime('%Y','now') AS INTEGER))
      ON CONFLICT(name) DO NOTHING
    `);
  },
};
