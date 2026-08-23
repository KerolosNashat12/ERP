/**
 * The SHAPE of a backup file — written once, because there are now two doors.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * A backup of a shop can be asked for from two places, and they are not the
 * same place on purpose:
 *
 *   the platform console   the owner of the PLATFORM, over the whole fleet,
 *                          out of the copy stored in the control plane.
 *                          `platform/BackupService.js`.
 *   the shop itself        the administrator of ONE shop, over his own shop,
 *                          read live out of that shop's database and never
 *                          stored anywhere. `services/DataExportService.js`.
 *
 * Two callers producing "a backup" is exactly how two subtly different files
 * come to exist — one with a README the other lacks, workbooks named
 * differently, a manifest with a field missing — and the day that matters is
 * the day somebody tries to restore the wrong one. So the layout is here, both
 * callers go through `assembleArchive`, and neither one owns it.
 *
 * ── The layout ───────────────────────────────────────────────────────────────
 *   README.txt                what the other two are, in both languages
 *   snapshot/<table>.NNNN.jsonl   every row, complete, in restore order
 *   snapshot/manifest.json    the tables, their columns, their parts, the shop
 *   spreadsheets/<slug>-en.xlsx   the readable half, English
 *   spreadsheets/<slug>-ar.xlsx   the readable half, Arabic
 *
 * The order is not cosmetic: README first so an owner double-clicking the
 * archive meets the explanation before the machinery, and the manifest LAST
 * because the workbooks report back which sheets they had to truncate and the
 * manifest is where that is recorded.
 */
import { ZipWriter } from '../shared/zip.js';
import { WorkbookBuilder } from './exportSheets.js';

export const README_NAME = 'README.txt';
export const MANIFEST_NAME = 'snapshot/manifest.json';

/** Where a workbook lives inside the archive. One rule, both doors. */
export const workbookName = (slug, lang) => `spreadsheets/${slug}-${lang}.xlsx`;

/**
 * The note a person reads first.
 *
 * Bilingual, and the Arabic is not a translation added later — the two halves
 * are written together here so a change to one is visibly a change to the
 * other. `redacted` names the columns this copy does NOT carry: it is empty for
 * the control plane's own copies and lists the credentials for a copy taken
 * through a shop's own door, and saying so is not a footnote — an owner who
 * believes he holds a file that can put his shop back has to be told what the
 * file will not do.
 */
export function readme({ nameEn, nameAr, takenAt, redacted = [] }) {
  const lines = [
    '================================================================',
    `  ${nameEn} — full data export`,
    `  ${nameAr} — نسخة كاملة من البيانات`,
    `  ${takenAt}`,
    '================================================================',
    '',
    'ENGLISH',
    '',
    '  spreadsheets/  Two Excel workbooks — one English, one Arabic.',
    '                 Products, stock, clients, sales, returns, purchases,',
    '                 suppliers, costs, employees, web orders, stock movements,',
    '                 promotions and users. Open either one by double-clicking.',
    '',
    '  snapshot/      The same shop, complete, in the form a computer restores',
    '                 from. It is not meant to be read. Keep it: it is the half',
    '                 that can put this shop back exactly as it was.',
    '',
    '  This file contains everything the shop knows, including what every',
    '  product cost, what every client\'s phone number is, and what every',
    '  employee is paid. Treat it the way you would treat the shop\'s books.',
    '',
  ];

  if (redacted.length) {
    lines.push(
      `  NOT INCLUDED: ${redacted.join(', ')}. This copy was taken from inside`,
      '  the shop, and passwords are the one thing that must not travel in a',
      '  file kept on a laptop. Everything else is here. If this snapshot is',
      '  ever restored, every user\'s password has to be set again afterwards.',
      '',
    );
  }

  lines.push(
    'العربية',
    '',
    '  مجلد spreadsheets: ملفان بصيغة Excel — واحد بالعربي وواحد بالإنجليزي.',
    '  المنتجات والمخزون والعملاء والمبيعات والمرتجعات والمشتريات والموردين',
    '  والتكاليف والموظفين وطلبات الموقع وحركة المخزون والعروض والمستخدمين.',
    '  افتح أيًّا منهما بالضغط عليه مرتين.',
    '',
    '  مجلد snapshot: نفس بيانات المتجر كاملة، بالشكل الذي يسترجعها منه',
    '  الكمبيوتر. ليس المقصود قراءته. احتفظ به: هو الجزء القادر على إعادة',
    '  المتجر إلى ما كان عليه بالضبط.',
    '',
    '  هذا الملف يحتوي كل ما يعرفه المتجر، بما في ذلك تكلفة كل منتج ورقم هاتف',
    '  كل عميل ومرتّب كل موظف. تعامل معه كما تتعامل مع دفاتر المتجر.',
    '',
  );

  if (redacted.length) {
    lines.push(
      '  غير مُضمَّن: كلمات المرور المُشفَّرة. هذه النسخة مأخوذة من داخل المتجر،',
      '  وكلمات المرور هي الشيء الوحيد الذي يجب ألا ينتقل في ملف محفوظ على',
      '  جهاز شخصي. كل ما عدا ذلك موجود. وإذا استُرجعت هذه النسخة يومًا فلا بد',
      '  من ضبط كلمة مرور كل مستخدم من جديد بعدها.',
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Build one archive, from whatever the caller can produce.
 *
 * `produce` is handed three things and returns the manifest:
 *
 *   addPart(name, bytes)          put one snapshot part into the archive
 *   handles(table) -> boolean     whether any sheet is built from this table —
 *                                 asked BEFORE parsing, so the photographs are
 *                                 copied through without ever becoming objects
 *   feed(table, columns, rows)    give the workbooks a batch of rows
 *
 * The control plane's caller reads those parts out of the copy it stored; the
 * shop's caller reads them out of its own database as they are being written.
 * Everything after `produce` returns is identical for both, which is the whole
 * reason this function exists.
 */
export async function assembleArchive({
  write, shop, takenAt, redacted = [], produce,
}) {
  const zip = new ZipWriter(write);
  const workbooks = new WorkbookBuilder();

  await zip.add(README_NAME, readme({
    nameEn: shop.nameEn, nameAr: shop.nameAr, takenAt, redacted,
  }));

  const manifest = await produce({
    addPart: (name, bytes) => zip.add(name, bytes),
    handles: (table) => workbooks.handles(table),
    feed: (table, columns, rows) => workbooks.feed(table, columns, rows),
  });

  const truncated = [];
  for (const book of await workbooks.workbooks()) {
    // `store: true`: an .xlsx is already a deflated archive, and a second pass
    // over it costs real CPU on a function with a time limit to save nothing.
    await zip.add(workbookName(shop.slug, book.lang), book.bytes, { store: true });
    truncated.push(...book.truncated);
  }

  await zip.add(MANIFEST_NAME, JSON.stringify({
    ...manifest,
    truncatedSheets: [...new Set(truncated)],
  }, null, 2));

  return zip.finish();
}

export default {
  assembleArchive, readme, workbookName, README_NAME, MANIFEST_NAME,
};
