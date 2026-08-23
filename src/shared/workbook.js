/**
 * A spreadsheet the owner can double-click, built with no dependency.
 *
 * The brief for this was "he said download all data" — a shop owner wants to
 * see his products, his sales and his customers. CSV was the obvious answer and
 * is the wrong one here, for reasons that are specific to this shop rather than
 * general:
 *
 *   - Excel opens a UTF-8 CSV as mojibake unless it starts with a byte-order
 *     mark, and an Arabic price list rendered as `Ø§Ù„Ù…Ù†ØªØ¬` is a file the
 *     owner will report as broken.
 *   - Excel on an Arabic Windows install uses `;` as its list separator, so a
 *     comma-separated file opens as one column per row.
 *   - A cell beginning `=`, `+`, `-` or `@` is executed as a formula when the
 *     file is opened. A product literally named "-5% clearance" is a live
 *     formula in a spreadsheet the owner did not write.
 *   - Fourteen tables means fourteen files, and no way to say which is which.
 *
 * An `.xlsx` has none of those problems: it is UTF-8 by construction, it is one
 * file with one tab per table, its cells carry a type so text is text and a
 * formula is never evaluated, and the Arabic workbook can declare itself
 * right-to-left so the columns run the way the reader does. And an `.xlsx` is a
 * ZIP of XML, which this repository can already write (see `shared/zip.js`) —
 * so the whole thing costs one file and no `npm install`.
 *
 * What is deliberately minimal: inline strings rather than a shared-string
 * table (simpler, and a backup is written once and read once), two cell styles,
 * and no charts, formulas or merged cells. It is a table of values, which is
 * exactly what it is for.
 */
import { zipToBuffer } from './zip.js';

/** Excel's own ceiling is 1 048 576 rows; a readable sheet stops long before. */
export const MAX_SHEET_ROWS = Number(process.env.MM_EXPORT_MAX_SHEET_ROWS || 100_000);

/** A1, B1 … Z1, AA1. */
export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * XML 1.0 has no escape for most control characters — they cannot appear in a
 * document at all, escaped or not. A stray one in a note field would produce a
 * workbook Excel refuses to open with no explanation, so they are dropped here
 * rather than allowed to ruin the file.
 */
export function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Sheet names: 31 characters, and none of `[ ] : * ? / \`. */
export function sheetName(name, taken = new Set()) {
  let base = String(name).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    const suffix = ` ${n}`;
    base = base.slice(0, 31 - suffix.length);
    candidate = base + suffix;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function cellXml(reference, value, style) {
  const styleAttr = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') {
    return `<c r="${reference}"${styleAttr}/>`;
  }
  if (isNumber(value)) return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
  return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheetXml({ columns, rows, rtl }) {
  const width = columns.length;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"',
    rtl ? ' rightToLeft="1"' : '',
    // The header stays on screen while the owner scrolls a thousand sales.
    '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
    '<cols>',
  ];
  columns.forEach((column, index) => {
    parts.push(`<col min="${index + 1}" max="${index + 1}" width="${column.width || 18}" customWidth="1"/>`);
  });
  parts.push('</cols><sheetData>');

  parts.push('<row r="1">');
  columns.forEach((column, index) => {
    parts.push(cellXml(`${columnName(index)}1`, column.label, 1));
  });
  parts.push('</row>');

  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    parts.push(`<row r="${r}">`);
    for (let i = 0; i < width; i += 1) {
      const value = row[i];
      if (value === null || value === undefined || value === '') continue;
      parts.push(cellXml(`${columnName(i)}${r}`, value, 0));
    }
    parts.push('</row>');
  });

  parts.push('</sheetData>');
  if (rows.length) {
    parts.push(`<autoFilter ref="A1:${columnName(width - 1)}${rows.length + 1}"/>`);
  }
  parts.push('</worksheet>');
  return parts.join('');
}

const CONTENT_TYPES = (count) => [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
  ...Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
  '</Types>',
].join('');

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

/** One bold style for the header row, and the default for everything else. */
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F0E8"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
  // Named "Normal", because a workbook with no default cell style makes some
  // readers warn and others substitute one of their own.
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '<dxfs count="0"/>'
  + '</styleSheet>';

/**
 * Build one workbook.
 *
 * `sheets` is `[{ name, columns: [{ label, width }], rows: [[value, …]] }]`.
 * `rtl` mirrors every sheet, which is what makes the Arabic workbook read the
 * way its reader does rather than being an English workbook with Arabic in it.
 */
export function buildWorkbook(sheets, { rtl = false } = {}) {
  const used = new Set();
  const named = sheets.map((sheet) => ({ ...sheet, tab: sheetName(sheet.name, used) }));

  const workbook = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheets>'];
  const rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
  named.forEach((sheet, index) => {
    workbook.push(`<sheet name="${xmlText(sheet.tab)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`);
    rels.push(`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`);
  });
  workbook.push('</sheets></workbook>');
  rels.push(`<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  rels.push('</Relationships>');

  return zipToBuffer(async (zip) => {
    await zip.add('[Content_Types].xml', CONTENT_TYPES(named.length));
    await zip.add('_rels/.rels', ROOT_RELS);
    await zip.add('xl/workbook.xml', workbook.join(''));
    await zip.add('xl/_rels/workbook.xml.rels', rels.join(''));
    await zip.add('xl/styles.xml', STYLES);
    for (let i = 0; i < named.length; i += 1) {
      await zip.add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml({ ...named[i], rtl }));
    }
  });
}

export default {
  buildWorkbook, columnName, sheetName, xmlText, MAX_SHEET_ROWS,
};
