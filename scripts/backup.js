/**
 * Creates a consistent backup copy of the database FILE — safe to run while the
 * server is up.
 *
 * This is the shop-PC tool and nothing more. It takes `VACUUM INTO`, which is a
 * perfect copy and is available on exactly one of the two drivers. A shop whose
 * database is hosted has no file to copy, and this used to say so in a way that
 * read like a verdict on the whole idea of a backup. It is not one: the shop's
 * own data can be taken out of ANY deployment, from Settings → Backups in the
 * ERP itself (`src/services/DataExportService.js`), and from the two commands
 * printed below.
 */
import {
  initDb, backupTo, closeDb, supportsFileBackup, driverName,
} from '../src/infrastructure/database/connection.js';
import config from '../src/config/index.js';
import path from 'node:path';
import fs from 'node:fs';

await initDb();

/**
 * Writing nothing is the correct outcome on a hosted database, not a failure —
 * so say why, say where the data actually comes from, and stop.
 *
 * Both languages, because this is printed on a shop's own machine and the
 * person reading a scheduled task's log is as likely to read Arabic as English.
 */
if (!supportsFileBackup()) {
  console.log(
    `Copying the database file is not possible here: this deployment runs on ${driverName()}, `
    + 'which has no file to copy.',
  );
  console.log('  Your data itself is still yours, and can still be taken out — in full:');
  console.log('');
  console.log('    In the ERP:   Settings → Backups → "Download a copy of my data"');
  console.log('    On a server:  node scripts/backup-shop.js --all');
  console.log('                  node scripts/backup-shop.js mm --out ./mm.zip');
  console.log('');
  console.log('  Each one reads the shop row by row, which works on both drivers, and produces');
  console.log('  a restorable snapshot AND two spreadsheets in one file.');
  console.log('');
  console.log(
    `نسخ ملف قاعدة البيانات غير ممكن هنا: هذا التثبيت يعمل على ${driverName()}، `
    + 'ولا يوجد ملف لنسخه.',
  );
  console.log('  لكن بياناتك تظل بياناتك، ويمكن أخذ نسخة كاملة منها:');
  console.log('');
  console.log('    من داخل النظام:  الإعدادات ← النسخ الاحتياطية ← «نزّل نسخة من بياناتي»');
  console.log('    من الخادم:       node scripts/backup-shop.js --all');
  console.log('');
  await closeDb();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(config.paths.backups, `mm-backup-${stamp}.db`);

await backupTo(target);
const { size } = fs.statSync(target);
console.log(`Backup written: ${target} (${(size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`تم إنشاء النسخة: ${target}`);
await closeDb();
