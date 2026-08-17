/**
 * Seeds the system.
 *   node scripts/seed.js          → baseline only (roles, admin, settings, attributes)
 *   node scripts/seed.js --demo   → baseline + ONE worked example end to end
 *
 * The demo is deliberately small: a single supplier, brand, category, product
 * (with its variant matrix), client and promo code, plus one purchase order and
 * one sale. Enough to see every screen populated, little enough to delete in a
 * minute when the real catalogue goes in.
 *
 * The work itself lives in `src/infrastructure/database/seed.js` so the hosted
 * deployment can bootstrap an empty database without anyone running a CLI.
 */
import { initDb, applySchema, closeDb } from '../src/infrastructure/database/connection.js';
import { seedBaseline, seedExample, hasExampleData } from '../src/infrastructure/database/seed.js';

const withDemo = process.argv.includes('--demo');

await initDb();
await applySchema();

await seedBaseline();
console.log('✔ Baseline seeded (permissions, roles, admin, settings, attributes)');

if (withDemo) {
  if (await hasExampleData()) {
    console.log('• Example data already present — skipping');
  } else {
    await seedExample();
    console.log('✔ One worked example seeded (1 supplier, 1 brand, 1 category, 1 product, 1 client)');
  }
}

await closeDb();
console.log('\nSign in with:');
console.log('  admin / admin123        (Administrator — you will be asked to change this)');
if (withDemo) console.log('  cashier / cashier123    (Cashier — to see role restrictions)');
