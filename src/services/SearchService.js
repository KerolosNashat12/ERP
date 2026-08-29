/**
 * ONE SEARCH BOX FOR THE WHOLE ERP.
 *
 * The owner's ask was "enhance the search function to help me at search auto
 * suggestion… for the whole system". So this answers a term with everything in
 * the shop that it could mean — a product, a brand, a shelf, a supplier, a
 * customer, an invoice number — ranked together, best first, in one list.
 *
 * ── The ladder, and why the order is the whole design ───────────────────────
 * `shared/searchText.js` reads a term several ways: as itself, as the same
 * keystrokes with the keyboard on the other language, and as a consonant
 * skeleton that lets `tobacco` reach «توباكو». Those readings are tried IN
 * ORDER and the first one that finds anything wins outright.
 *
 * That matters more than it looks. A shop scans a barcode into this box. If a
 * skeleton reading were allowed to contribute alongside the exact one, a
 * scanned code could come back second behind a vowel-stripped near-miss, and
 * the person at the till would put the wrong bottle in the bag. A cheap
 * reading that fires before a confident one is not a faster answer; it is a
 * wrong one. So: stop at the first tier with results, and only fall to the
 * typo tier when every tier above it found nothing at all.
 *
 * ── Why the scoring is in JavaScript and the filtering is in SQL ────────────
 * SQL is good at "which rows could possibly match" and cannot express "which
 * of these is the best answer" without becoming unreadable. So SQL narrows to
 * a bounded candidate set on an indexed column, and the ranking — prefix beats
 * word-start beats substring, shorter fields beat longer ones, and every one of
 * those beats a typo — happens in memory over a few dozen rows.
 *
 * ── Permissions are per GROUP, not per endpoint ─────────────────────────────
 * One box that returns suppliers and invoices cannot be gated by one
 * permission. Every group declares the permission it needs and is skipped
 * entirely for a caller who lacks it — using `grantsPermission`, the same
 * function the route guards are written in terms of, so a module a shop has
 * not bought is invisible here on exactly the request where its own routes
 * would refuse.
 */
import { getDb } from '../infrastructure/database/connection.js';
import {
  candidates, searchKey, searchTokens, scoreField, scoreFuzzy, editBudget,
} from '../../public/shared/searchText.js';

/**
 * How many rows SQL may hand back per group before ranking. Comfortably more
 * than the handful that survive, so the ranking has something to choose
 * between — and bounded, so a one-letter search cannot pull a whole catalogue
 * into memory.
 */
const CANDIDATE_LIMIT = 60;

/** How many of each group reach the screen. A suggestion list is not a report. */
const GROUP_LIMIT = 6;

/**
 * The ceiling on the typo pass. It is the only tier that reads rows SQL could
 * not narrow, so it is the only one that needs a number: past this many
 * products a shop is better served by typing one more letter than by the ERP
 * scanning its whole catalogue on every keystroke.
 */
const FUZZY_SCAN_LIMIT = 4000;

/** LIKE's own wildcards, neutralised. A typed `%` is a character, not "all". */
const escaped = (value) => String(value).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The pattern a tier looks for. Both index columns are stored with a leading
 * and trailing space around every token, so `% key %` means "a whole word" and
 * `%key%` means "anywhere" — and which of the two a tier gets is a correctness
 * decision, not a tuning one. See `wholeWord` in shared/searchText.js.
 */
const patternFor = (tier, token) => (tier.wholeWord
  ? `% ${escaped(token)} %`
  : `%${escaped(token)}%`);

/**
 * A tier's whole condition: one LIKE per word, ANDed.
 *
 * ANDed and not ORed. "tobacco vanille" means the row must carry both words —
 * OR would answer it with every product containing either, which on a perfume
 * shelf is most of them, ranked by an accident.
 */
const tierWhere = (tier, column) => ({
  sql: tier.tokens.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' AND '),
  params: tier.tokens.map((token) => patternFor(tier, token)),
});

/**
 * How well a whole multi-word term matches one field: the AVERAGE of its
 * words' scores.
 *
 * Average rather than best, so "tobacco vanille" against «توباكو فانيل» — both
 * words matching — outranks the same term against a row that merely contains
 * "tobacco". A single-word term is its own average, so nothing changes for the
 * common case.
 */
function scoreTokens(tier, fieldKey) {
  let total = 0;
  let reason = null;
  for (const token of tier.tokens) {
    const hit = scoreField(token, fieldKey, { kind: tier.kind });
    if (!hit.score) return { score: 0, reason: null };
    total += hit.score;
    if (!reason) reason = hit.reason;
  }
  return { score: total / tier.tokens.length, reason };
}

export class SearchService {
  constructor(deps = {}) {
    this.db = deps.db || null;
  }

  #db() { return this.db || getDb(); }

  /**
   * Products, by the ladder.
   *
   * Returns `{ rows, tier }` — the tier is carried out so the screen can say
   * WHY something matched. "You had the keyboard on English" is a far better
   * thing to show a person than a result they did not type.
   */
  async #products(term, limit) {
    const db = this.#db();
    for (const tier of candidates(term)) {
      const column = tier.kind === 'skeleton' ? 'ps.bones' : 'ps.search_key';
      /*
       * `is_active` is not filtered here. A stopped product is exactly what
       * somebody searching the ERP for it is trying to find — to reactivate it,
       * or to see what happened to its stock. The row carries the flag and the
       * screen shows it greyed; hiding it would be answering a search with a
       * lie about what the shop has.
       */
      // eslint-disable-next-line no-await-in-loop -- tiers are ordered; stop at the first hit.
      const where = tierWhere(tier, column);
      if (!where.params.length) continue;
      const rows = await db.prepare(`
        SELECT p.id, p.sku_prefix, p.name_en, p.name_ar, p.is_active,
               p.brand_id, p.category_id,
               b.name_en AS brand_en, b.name_ar AS brand_ar,
               ps.search_key AS key
        FROM product_search ps
        JOIN products p ON p.id = ps.product_id
        LEFT JOIN brands b ON b.id = p.brand_id
        WHERE ${where.sql}
        LIMIT ?
      `).all(...where.params, CANDIDATE_LIMIT);
      if (!rows.length) continue;

      const scored = rows
        .map((row) => {
          const { score, reason } = scoreTokens(tier, row.key);
          return { row, score, reason };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.row.name_en.localeCompare(b.row.name_en));
      if (scored.length) return { rows: scored.slice(0, limit), tier: tier.kind };
    }

    return this.#productsFuzzy(term, limit);
  }

  /**
   * The last resort: they mistyped it.
   *
   * Runs only when every tier above found nothing, and only for terms long
   * enough that an edit budget means anything — `editBudget` returns 0 below
   * four characters, because at three letters one edit reaches half a
   * catalogue and a list of everything is not a suggestion.
   */
  async #productsFuzzy(term, limit) {
    const tokens = searchTokens(term);
    // Every word has to be long enough to guess at. One three-letter word in
    // the term is enough to refuse the whole thing — see scoreFuzzy.
    if (!tokens.length || tokens.some((token) => !editBudget(token))) {
      return { rows: [], tier: null };
    }

    const db = this.#db();
    const rows = await db.prepare(`
      SELECT p.id, p.sku_prefix, p.name_en, p.name_ar, p.is_active,
             p.brand_id, p.category_id,
             b.name_en AS brand_en, b.name_ar AS brand_ar,
             ps.search_key AS key
      FROM product_search ps
      JOIN products p ON p.id = ps.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LIMIT ?
    `).all(FUZZY_SCAN_LIMIT);

    const scored = rows
      .map((row) => {
        const { score, reason } = scoreFuzzy(tokens, String(row.key).trim().split(' '));
        return { row, score, reason };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    return { rows: scored.slice(0, limit), tier: scored.length ? 'typo' : null };
  }

  /**
   * A small named table — brands, categories, suppliers, customers.
   *
   * These have no index row of their own, deliberately: there are tens of them
   * rather than hundreds, both their names are on the row already, and keeping
   * a second index in step for a table this size would be more code than the
   * search it serves. So the reduction happens in memory, over every row.
   */
  async #named({ table, columns, extra = [], limit, term }) {
    const db = this.#db();
    const ladder = candidates(term);
    if (!ladder.length) return [];
    const select = ['id', ...columns, ...extra].join(', ');
    const rows = await db.prepare(`SELECT ${select} FROM ${table} LIMIT ?`).all(FUZZY_SCAN_LIMIT);

    for (const tier of ladder) {
      const scored = [];
      for (const row of rows) {
        let best = { score: 0, reason: null };
        for (const column of columns) {
          // The same padding the stored index uses, so " word " means a whole
          // word here exactly as it does there.
          const fieldKey = ` ${searchTokens(row[column]).join(' ')} `;
          const hit = scoreTokens(tier, fieldKey);
          if (hit.score > best.score) best = hit;
        }
        if (best.score > 0) scored.push({ row, ...best });
      }
      if (scored.length) {
        return scored.sort((a, b) => b.score - a.score).slice(0, limit);
      }
    }
    return [];
  }

  /**
   * Documents, by their number. `SN-2026-0012`, `PO-27`, or just `27`.
   *
   * Kept literal rather than routed through the index: a document number is
   * machine-issued and is never mistyped in a way worth guessing at. What IS
   * worth handling is a person typing the tail of it — so the match is a plain
   * substring, and the ORDER puts the newest first, because the invoice
   * somebody is looking for is almost always a recent one.
   */
  async #documents({ table, numberColumn, extra = [], limit, term }) {
    const value = String(term).trim();
    if (value.length < 2) return [];
    const select = ['id', `${numberColumn} AS number`, ...extra].join(', ');
    const rows = await this.#db().prepare(`
      SELECT ${select} FROM ${table}
      WHERE ${numberColumn} LIKE ? ESCAPE '\\'
      ORDER BY id DESC
      LIMIT ?
    `).all(`%${escaped(value)}%`, limit);
    return rows.map((row) => ({ row, score: 0.8, reason: 'number' }));
  }

  /**
   * Everything the caller is allowed to see, grouped.
   *
   * @param {string} term        what they typed
   * @param {(code: string) => boolean} may  the permission test, module gate included
   */
  async suggest(term, may, { limit = GROUP_LIMIT } = {}) {
    const raw = String(term ?? '').trim();
    if (raw.length < 1) return { term: raw, groups: [], tier: null };

    const groups = [];
    let tier = null;

    if (may('products.view')) {
      const found = await this.#products(raw, limit);
      tier = found.tier;
      if (found.rows.length) {
        groups.push({
          kind: 'product',
          rows: found.rows.map(({ row, score, reason }) => ({
            id: row.id,
            code: row.sku_prefix,
            name_en: row.name_en,
            name_ar: row.name_ar,
            brand_en: row.brand_en,
            brand_ar: row.brand_ar,
            is_active: row.is_active,
            score,
            reason,
          })),
        });
      }
    }

    /*
     * The rest run in parallel: they are independent reads of small tables and
     * running them in series would make the box wait for the sum of them on
     * every keystroke. On a hosted database that is the difference between one
     * round trip's latency and five.
     */
    const [brands, categories, suppliers, customers] = await Promise.all([
      may('brands.view') ? this.#named({ table: 'brands', columns: ['name_en', 'name_ar'], limit, term: raw }) : [],
      may('categories.view') ? this.#named({ table: 'categories', columns: ['name_en', 'name_ar'], limit, term: raw }) : [],
      may('suppliers.view') ? this.#named({ table: 'suppliers', columns: ['name_en', 'name_ar'], extra: ['phone'], limit, term: raw }) : [],
      may('customers.view') ? this.#named({ table: 'customers', columns: ['name'], extra: ['phone'], limit, term: raw }) : [],
    ]);

    const push = (kind, hits, shape) => {
      if (hits.length) groups.push({ kind, rows: hits.map(({ row, score, reason }) => ({ ...shape(row), score, reason })) });
    };
    push('brand', brands, (r) => ({ id: r.id, name_en: r.name_en, name_ar: r.name_ar }));
    push('category', categories, (r) => ({ id: r.id, name_en: r.name_en, name_ar: r.name_ar }));
    push('supplier', suppliers, (r) => ({ id: r.id, name_en: r.name_en, name_ar: r.name_ar, phone: r.phone }));
    push('customer', customers, (r) => ({ id: r.id, name_en: r.name, name_ar: r.name, phone: r.phone }));

    const [sales, purchases] = await Promise.all([
      may('sales.view') ? this.#documents({ table: 'sales', numberColumn: 'invoice_no', extra: ['total_amount', 'created_at'], limit: 4, term: raw }) : [],
      may('purchases.view') ? this.#documents({ table: 'purchase_orders', numberColumn: 'po_number', extra: ['total_amount', 'created_at'], limit: 4, term: raw }) : [],
    ]);
    push('sale', sales, (r) => ({ id: r.id, number: r.number, total: r.total_amount, at: r.created_at }));
    push('purchase', purchases, (r) => ({ id: r.id, number: r.number, total: r.total_amount, at: r.created_at }));

    return { term: raw, tier, groups };
  }

  /**
   * The storefront's own suggestions.
   *
   * A separate method rather than a flag on `suggest()`, and deliberately so:
   * this one answers the open internet. It must never reveal an unpublished
   * product, a stopped one, a supplier, a customer or a document, and the way
   * to guarantee that is for the query to have no path to them at all — not
   * for a boolean to be passed correctly on every call for ever.
   */
  async suggestPublic(term, { limit = 8 } = {}) {
    const raw = String(term ?? '').trim();
    if (!raw) return { term: raw, rows: [], tier: null };
    const db = this.#db();

    for (const tier of candidates(raw)) {
      const column = tier.kind === 'skeleton' ? 'ps.bones' : 'ps.search_key';
      const where = tierWhere(tier, column);
      if (!where.params.length) continue;
      // eslint-disable-next-line no-await-in-loop -- ordered tiers, first hit wins.
      const rows = await db.prepare(`
        SELECT p.id, p.name_en, p.name_ar, ps.search_key AS key,
               (SELECT MIN(v.selling_price) FROM product_variants v
                 WHERE v.product_id = p.id AND v.is_active = 1) AS price_from,
               COALESCE(
                 (SELECT ip.id FROM product_images ip
                   WHERE ip.id = p.primary_image_id AND ip.product_id = p.id),
                 (SELECT i2.id FROM product_images i2
                   WHERE i2.product_id = p.id ORDER BY i2.display_order, i2.id LIMIT 1)
               ) AS image_id
        FROM product_search ps
        JOIN products p ON p.id = ps.product_id
        WHERE ${where.sql}
          AND p.is_active = 1 AND p.is_published = 1
        LIMIT ?
      `).all(...where.params, CANDIDATE_LIMIT);
      if (!rows.length) continue;

      const scored = rows
        .map((row) => ({ row, ...scoreTokens(tier, row.key) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        return {
          term: raw,
          tier: tier.kind,
          rows: scored.slice(0, limit).map(({ row, score, reason }) => ({
            id: row.id,
            name_en: row.name_en,
            name_ar: row.name_ar,
            price_from: row.price_from,
            image_id: row.image_id,
            score,
            reason,
          })),
        };
      }
    }

    /*
     * The typo tier, for the storefront too. A shopper mistyping a brand name
     * on a phone is at least as likely as a member of staff mistyping it at the
     * counter — and the shopper is the one who leaves rather than trying again.
     *
     * Same ceiling and same budget as the ERP's: below four characters
     * `editBudget` returns 0 and this does nothing, because at three letters
     * one edit reaches half a catalogue.
     */
    const tokens = searchTokens(raw);
    if (!tokens.length || tokens.some((token) => !editBudget(token))) {
      return { term: raw, rows: [], tier: null };
    }

    const all = await db.prepare(`
      SELECT p.id, p.name_en, p.name_ar, ps.search_key AS key,
             (SELECT MIN(v.selling_price) FROM product_variants v
               WHERE v.product_id = p.id AND v.is_active = 1) AS price_from,
             COALESCE(
               (SELECT ip.id FROM product_images ip
                 WHERE ip.id = p.primary_image_id AND ip.product_id = p.id),
               (SELECT i2.id FROM product_images i2
                 WHERE i2.product_id = p.id ORDER BY i2.display_order, i2.id LIMIT 1)
             ) AS image_id
      FROM product_search ps
      JOIN products p ON p.id = ps.product_id
      WHERE p.is_active = 1 AND p.is_published = 1
      LIMIT ?
    `).all(FUZZY_SCAN_LIMIT);

    const scored = all
      .map((row) => ({ row, ...scoreFuzzy(tokens, String(row.key).trim().split(' ')) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return { term: raw, rows: [], tier: null };
    return {
      term: raw,
      tier: 'typo',
      rows: scored.slice(0, limit).map(({ row, score, reason }) => ({
        id: row.id,
        name_en: row.name_en,
        name_ar: row.name_ar,
        price_from: row.price_from,
        image_id: row.image_id,
        score,
        reason,
      })),
    };
  }
}

export const searchService = new SearchService();
export default searchService;
