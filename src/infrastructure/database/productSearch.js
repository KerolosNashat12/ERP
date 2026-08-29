/**
 * ONE product-search rule, for every search box in the ERP.
 *
 * The owner's request was "search using product name or code — both work for
 * the whole system". Before this file each screen answered that question
 * differently: POS matched five columns, the products grid matched three, and
 * every document list matched only its own number. This module is the single
 * definition of "this term is about that product", so the screens can agree by
 * construction rather than by everybody remembering to copy the same `OR` list.
 *
 * The rule, in words:
 *   a term matches a product when it appears in the product's English name,
 *   its Arabic name, its product code (`sku_prefix`), a variant's SKU, a
 *   variant's barcode, or a variant's label.
 *
 * Three shapes of row need it, so there are three entry points:
 *   `rowMatch`      — a row that already carries the variant's details
 *                     (`v_variant_details` and anything selecting from it).
 *   `productMatch`  — a `products` row, which has to reach into its variants.
 *   `lineMatch`     — a document row, which matches through its own lines.
 *
 * Every one of them has an `…Exact` twin used for ordering: a term that *is* a
 * SKU or a barcode must put its row first, because that term came off a
 * scanner or was copied from a label, and a scan is never a guess.
 *
 * Everything returns `{ sql, params }` and nothing interpolates a caller's
 * value into SQL — aliases and table names are the only things spliced in, and
 * they are always literals written in this repository.
 */

/**
 * LIKE has two wildcards of its own. A shop's SKUs contain `-` and could
 * contain `_`, and `_` in LIKE means "any character": without escaping,
 * searching `AB_1` would also find `AB-1`, `AB91` and `ABX1`. So the term is
 * escaped and every LIKE declares the escape character.
 */
import { candidates } from '../../../public/shared/searchText.js';

const ESC = '\\';
const LIKE = `LIKE ? ESCAPE '${ESC}'`;

/** Columns of a row that carries a variant's denormalised product details. */
export const VARIANT_DETAIL_ROW = Object.freeze({
  productId: 'product_id',
  sku: 'sku',
  barcode: 'barcode',
  label: 'variant_label',
  code: 'sku_prefix',
  nameEn: 'product_name_en',
  nameAr: 'product_name_ar',
});

/** Columns of a bare `product_variants` row (no product columns of its own). */
export const VARIANT_ROW = Object.freeze({
  productId: 'product_id',
  sku: 'sku',
  barcode: 'barcode',
  label: 'variant_label',
});

/** Columns of a `products` row. */
export const PRODUCT_ROW = Object.freeze({
  productId: 'id',
  code: 'sku_prefix',
  nameEn: 'name_en',
  nameAr: 'name_ar',
});

/** Terms shorter than this are not expanded into a line-level document scan. */
export const MIN_LINE_SEARCH_LENGTH = 2;

export const normaliseTerm = (term) => String(term ?? '').trim();

/**
 * `%term%`, with LIKE's own wildcards neutralised. Arabic goes through
 * untouched: SQLite compares non-ASCII bytes exactly, which is precisely what
 * an Arabic substring search wants.
 */
export const likeParam = (term) => `%${normaliseTerm(term).replace(/[\\%_]/g, (c) => ESC + c)}%`;

const qualify = (alias, column) => (alias ? `${alias}.${column}` : column);

const searchColumns = (shape) => [shape.sku, shape.barcode, shape.code, shape.nameEn,
  shape.nameAr, shape.label].filter(Boolean);

/* ═══════════════════════ the normalised index, and what it is allowed to do ═
 *
 * `product_search` holds every token a product can be found by, reduced by
 * `shared/searchText.js` — hamza folded, tashkeel stripped, case and
 * separators gone, Arabic-Indic digits turned Western. SQLite can do none of
 * that itself, which is why the reduction happens on save and is stored.
 *
 * ── Only the two CONFIDENT tiers are wired in here, and that is deliberate ──
 * The engine offers three readings of a term: the term itself, the term with
 * the keyboard layout swapped, and the term as a consonant skeleton (which is
 * how `tobacco` reaches «توباكو»). This module feeds the LIST screens — the
 * products grid, the stock page, the document lists — and a list shows
 * everything that matched, unranked and unlimited. Precision is what it needs.
 *
 * So the skeleton tier is NOT here. It is a recall tier: it drops vowels, so
 * `bag` and `big` share a skeleton, and adding it to a grid would answer a
 * three-letter search with half a catalogue and no way to see why. It lives in
 * the SUGGEST endpoint instead, where results are ranked, capped at a handful,
 * and each one can say what it matched on.
 *
 * The layout tier IS here, because it is not a guess: `u'v` is «عطر» typed on
 * an English keyboard, and no product is called `u'v`.
 */

/**
 * The index half of a match, as an EXISTS against the row's product.
 *
 * Returns null when the term reduces to nothing (a search for punctuation) or
 * when the caller's shape does not know where its product id is — in both
 * cases the plain column matching above still stands on its own, so the search
 * is narrower rather than broken.
 */
export function indexMatch(term, productIdExpr) {
  if (!productIdExpr) return null;
  const tiers = candidates(term)
    .filter((c) => (c.kind === 'exact' || c.kind === 'layout') && c.tokens.length);
  if (!tiers.length) return null;
  const parts = [];
  const params = [];
  for (const tier of tiers) {
    /*
     * One LIKE per WORD, ANDed — a row must carry all of them. A term of
     * several words keyed as one string matches nothing, because the index
     * deliberately keeps words apart; this is where "tobacco vanille" becomes
     * two conditions instead of one impossible one.
     *
     * The tiers themselves are ORed: any reading may satisfy the row.
     */
    parts.push(`(${tier.tokens.map(() => `ps.search_key ${LIKE}`).join(' AND ')})`);
    for (const token of tier.tokens) {
      params.push(`%${token.replace(/[\\%_]/g, (c) => ESC + c)}%`);
    }
  }
  return {
    sql: `EXISTS (SELECT 1 FROM product_search ps
            WHERE ps.product_id = ${productIdExpr} AND (${parts.join(' OR ')}))`,
    params,
  };
}

/** `{sql, params}` for `a OR b`, skipping whichever is absent. */
const either = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return { sql: `(${a.sql} OR ${b.sql})`, params: [...a.params, ...b.params] };
};

/**
 * The rule against a row that already has the columns — the POS/stock case.
 * @returns {{sql: string, params: any[]}}
 */
export function rowMatch(term, alias = '', shape = VARIANT_DETAIL_ROW) {
  const columns = searchColumns(shape);
  const like = likeParam(term);
  const literal = {
    sql: `(${columns.map((c) => `${qualify(alias, c)} ${LIKE}`).join(' OR ')})`,
    params: columns.map(() => like),
  };
  /*
   * The literal columns OR the normalised index. Both, not one: the columns
   * are what a scanned barcode and a pasted SKU match on exactly, and the
   * index is what «أحمر» matches «احمر» through. Dropping either loses a case
   * the other cannot cover.
   */
  return either(literal, shape.productId
    ? indexMatch(term, qualify(alias, shape.productId))
    : null);
}

/**
 * True when the term *is* this row's code rather than merely appearing in it.
 * SKUs are compared case-insensitively (the same rule the scanner endpoint
 * already uses); a barcode is machine-written and compared as stored.
 */
export function rowExact(term, alias = '', shape = VARIANT_DETAIL_ROW) {
  const value = normaliseTerm(term);
  const parts = [];
  const params = [];
  if (shape.sku) { parts.push(`${qualify(alias, shape.sku)} = ? COLLATE NOCASE`); params.push(value); }
  if (shape.barcode) { parts.push(`${qualify(alias, shape.barcode)} = ?`); params.push(value); }
  if (shape.code) { parts.push(`${qualify(alias, shape.code)} = ? COLLATE NOCASE`); params.push(value); }
  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * `0` for an exact code match, `1` for everything else — drop it first in an
 * ORDER BY and a scanned code can never come second.
 */
export function rankExpression(exact) {
  return { sql: `CASE WHEN ${exact.sql} THEN 0 ELSE 1 END`, params: exact.params };
}

// --------------------------------------------------------------- a product

/**
 * The rule against a `products` row. The product's own columns, plus an
 * `EXISTS` into its variants so a barcode or a variant SKU finds the product
 * that owns it — in SQL, so the 5,000th product costs the same as the first.
 */
export function productMatch(term, alias = 'p') {
  /*
   * `own` already carries the index tier, because PRODUCT_ROW knows its own id
   * — so the product's normalised text is searched here and the correlated
   * subquery below stays about the literal columns of its variants.
   *
   * The child shape is stripped of `productId` for exactly that reason: left
   * on, every product row would run a second, identical EXISTS against the
   * same index row for no additional matches.
   */
  const own = rowMatch(term, alias, PRODUCT_ROW);
  const child = rowMatch(term, 'psv', { ...VARIANT_ROW, productId: null });
  return {
    sql: `(${own.sql} OR EXISTS (SELECT 1 FROM product_variants psv
              WHERE psv.product_id = ${alias}.id AND ${child.sql}))`,
    params: [...own.params, ...child.params],
  };
}

/** Exact-code twin of `productMatch`, for the ORDER BY. */
export function productExact(term, alias = 'p') {
  const own = rowExact(term, alias, PRODUCT_ROW);
  const child = rowExact(term, 'psx', VARIANT_ROW);
  return {
    sql: `(${own.sql} OR EXISTS (SELECT 1 FROM product_variants psx
              WHERE psx.product_id = ${alias}.id AND ${child.sql}))`,
    params: [...own.params, ...child.params],
  };
}

// -------------------------------------------------------------- a document

/**
 * A sales invoice is not a product, so it cannot match a product code by
 * itself — it matches by *containing a line for* that product. Phrased as
 * `id IN (SELECT fk FROM lines WHERE variant_id IN (matching variants))`
 * rather than as a correlated EXISTS over the lines: the inner set is computed
 * once (one scan of the catalogue, which is the part LIKE cannot index away)
 * and the outer lookup then rides the line table's `variant_id` index instead
 * of re-scanning every line of every document.
 *
 * @param {string} term
 * @param {{alias: string, table: string, key: string}} scope
 *        the document alias, its line table, and the line's foreign key
 */
export function lineMatch(term, { alias, table, key }) {
  const variants = matchingVariantIds(term);
  return {
    sql: `${alias}.id IN (SELECT dl.${key} FROM ${table} dl
            WHERE dl.variant_id IN (${variants.sql}))`,
    params: variants.params,
  };
}

/** Exact-code twin of `lineMatch`. */
export function lineExact(term, { alias, table, key }) {
  const value = normaliseTerm(term);
  return {
    sql: `${alias}.id IN (SELECT dx.${key} FROM ${table} dx
            WHERE dx.variant_id IN (SELECT pxv.id FROM product_variants pxv
              WHERE pxv.sku = ? COLLATE NOCASE OR pxv.barcode = ?))`,
    params: [value, value],
  };
}

/** The variant ids a term matches, as a subquery. */
export function matchingVariantIds(term) {
  // Same reasoning as productMatch: the product side carries the index tier,
  // the variant side stays literal so the index is not consulted twice.
  const onVariant = rowMatch(term, 'psv', { ...VARIANT_ROW, productId: null });
  const onProduct = rowMatch(term, 'psp', PRODUCT_ROW);
  return {
    sql: `SELECT psv.id FROM product_variants psv
            JOIN products psp ON psp.id = psv.product_id
           WHERE ${onVariant.sql} OR ${onProduct.sql}`,
    params: [...onVariant.params, ...onProduct.params],
  };
}

/**
 * The honest half of feature 3: never hand back a document with no visible
 * reason. These SELECT-list columns say whether the document itself matched or
 * one of its lines did, and which product that line was for.
 *
 * The three scalar subqueries are correlated on the document id and so run only
 * for the rows a page actually returns — 25 index seeks, not a table scan.
 *
 * @param {string} term
 * @param {{alias, table, key, documentSql, documentParams}} scope
 *        `documentSql` is the screen's own "the document matched" predicate
 *        (its number, its customer — whatever that screen already searched).
 */
export function matchReasonColumns(term, {
  alias, table, key, documentSql, documentParams = [], scoped = true,
}) {
  // Nothing was expanded into a line search, so nothing can have matched a
  // line: say so as a constant rather than paying for three subqueries to
  // rediscover it.
  if (!scoped) return { sql: "'document' AS search_match", params: [] };

  const lineOf = (column) => {
    const onVariant = rowMatch(term, 'dmv', VARIANT_ROW);
    const onProduct = rowMatch(term, 'dmp', PRODUCT_ROW);
    return {
      sql: `(SELECT ${column} FROM ${table} dm
               JOIN product_variants dmv ON dmv.id = dm.variant_id
               JOIN products dmp ON dmp.id = dmv.product_id
              WHERE dm.${key} = ${alias}.id AND (${onVariant.sql} OR ${onProduct.sql})
              LIMIT 1)`,
      params: [...onVariant.params, ...onProduct.params],
    };
  };

  const sku = lineOf('dmv.sku');
  const nameEn = lineOf('dmp.name_en');
  const nameAr = lineOf('dmp.name_ar');

  return {
    sql: `CASE WHEN ${documentSql} THEN 'document' ELSE 'line' END AS search_match,
          ${sku.sql}    AS search_match_sku,
          ${nameEn.sql} AS search_match_name_en,
          ${nameAr.sql} AS search_match_name_ar`,
    params: [...documentParams, ...sku.params, ...nameEn.params, ...nameAr.params],
  };
}

/**
 * Whether a term is worth expanding into a line-level document scan.
 *
 * A single character matches most of the catalogue, so on a document screen it
 * would return every invoice in the shop and pay for a full variant scan to do
 * it. One character still searches document numbers exactly as it did before —
 * this only gates the new, expensive half.
 */
export const worthLineSearch = (term) => normaliseTerm(term).length >= MIN_LINE_SEARCH_LENGTH;

export default {
  VARIANT_DETAIL_ROW,
  VARIANT_ROW,
  PRODUCT_ROW,
  normaliseTerm,
  likeParam,
  rowMatch,
  rowExact,
  rankExpression,
  productMatch,
  productExact,
  lineMatch,
  lineExact,
  matchingVariantIds,
  matchReasonColumns,
  worthLineSearch,
};
