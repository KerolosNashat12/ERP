/**
 * Generic table gateway. Concrete repositories extend it and add only the
 * queries that are actually specific to their aggregate — this is where the
 * DRY win lives, since 8 of the 14 tables need nothing but plain CRUD.
 *
 * Every method is async because one of the two supported drivers talks over a
 * network. See `database/connection.js`.
 */
import { getDb } from '../database/connection.js';
import {
  likeParam, lineMatch, lineExact, normaliseTerm, rankExpression, worthLineSearch,
} from '../database/productSearch.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';
import { notInBin } from '../../shared/trashFilter.js';

const nowIso = () => new Date().toISOString();

export class BaseRepository {
  /**
   * @param {object} options
   * @param {string} options.table          physical table name
   * @param {string[]} options.columns      writable columns
   * @param {string[]} [options.searchable] columns included in free-text search
   * @param {boolean} [options.timestamps]  maintain created_at / updated_at
   * @param {{table: string, key: string}} [options.productScope]
   *        For a table whose rows are documents with lines: the line table and
   *        the column that points back here. Declaring it is what makes a
   *        product name, code, SKU or barcode find the documents that contain
   *        that product — see `searchPredicate` below.
   * @param {string} [options.documentColumn]
   *        The column that holds this document's own number, used to decide
   *        whether a search term was the document or its contents. Defaults to
   *        the first searchable column, which is that number on every document
   *        table in this schema.
   */
  constructor({
    table, columns, searchable = [], timestamps = true, defaultSort = 'id DESC',
    productScope = null, documentColumn = null, trashType = null,
  }) {
    /**
     * The recycle bin's key for this table, when it has one.
     *
     * A deleted record STAYS in its own table with every reference to it
     * intact — moving it to a bin table would break the invoices it sits on —
     * so what makes it "deleted" is an `in_bin` row in `trash_items`, and this
     * is what lets `list()` leave it out. One `NOT EXISTS` against an indexed
     * lookup, added to the one method every screen's list goes through, rather
     * than the same clause copied into fifteen repositories where fourteen
     * would eventually be right.
     */
    this.trashType = trashType;
    this.table = table;
    this.columns = columns;
    this.searchable = searchable;
    this.timestamps = timestamps;
    this.defaultSort = defaultSort;
    this.productScope = productScope;
    this.documentColumn = documentColumn || searchable[0] || null;
  }

  /**
   * The free-text WHERE fragment for this table — the single place a search
   * term becomes SQL, whether it arrives through the generic `list()` below or
   * through a repository's own hand-written `listDetailed()`.
   *
   * Two halves:
   *   - the table's own `searchable` columns, plus whatever a joined query
   *     wants to add through `extra` (a customer's name, say);
   *   - and, when the table declares a `productScope`, the documents whose
   *     *lines* are for a matching product. A sales invoice is not a product,
   *     so this is the only honest way it can answer a barcode.
   *
   * Returns `null` for an empty term so callers can skip the clause entirely.
   *
   * @param {string} term
   * @param {{alias?: string, extra?: string[]}} [options]
   *        `extra` entries are already-qualified column expressions.
   * @returns {{sql: string, params: any[], documentSql: string,
   *            documentParams: any[], scoped: boolean} | null}
   */
  searchPredicate(term, { alias = '', extra = [] } = {}) {
    if (!normaliseTerm(term)) return null;
    const qualify = (c) => (alias && !c.includes('.') ? `${alias}.${c}` : c);
    const columns = [...this.searchable.map(qualify), ...extra];
    const like = likeParam(term);

    const documentSql = `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    const documentParams = columns.map(() => like);

    // The line half is skipped for a one-character term: it would match most of
    // the catalogue and cost a full scan to say so. Document numbers still
    // search on one character, exactly as before.
    const scoped = Boolean(this.productScope) && worthLineSearch(term);
    if (!scoped) {
      return { sql: documentSql, params: documentParams, documentSql, documentParams, scoped: false };
    }

    const lines = lineMatch(term, { alias: alias || this.table, ...this.productScope });
    return {
      sql: `(${documentSql} OR ${lines.sql})`,
      params: [...documentParams, ...lines.params],
      documentSql,
      documentParams,
      scoped: true,
    };
  }

  /**
   * `0` when the term is exactly this document's number or exactly a code on
   * one of its lines, `1` otherwise. First in an ORDER BY, so a scanned or
   * pasted code is never beaten to the top by a row that merely contains it.
   */
  searchRank(term, { alias = '' } = {}) {
    const value = normaliseTerm(term);
    if (!value) return null;
    const parts = [];
    const params = [];
    if (this.documentColumn) {
      parts.push(`${alias ? `${alias}.` : ''}${this.documentColumn} = ? COLLATE NOCASE`);
      params.push(value);
    }
    if (this.productScope && worthLineSearch(value)) {
      const exact = lineExact(value, { alias: alias || this.table, ...this.productScope });
      parts.push(exact.sql);
      params.push(...exact.params);
    }
    if (!parts.length) return null;
    return rankExpression({ sql: `(${parts.join(' OR ')})`, params });
  }

  get db() {
    return getDb();
  }

  /**
   * Keep only known columns so callers can pass whole request bodies safely.
   * Booleans are folded to 1/0 here because SQLite has no boolean type — better
   * to normalise once at the boundary than to litter every caller with ternaries.
   */
  pick(data) {
    const out = {};
    for (const col of this.columns) {
      const value = data[col];
      if (value === undefined) continue;
      out[col] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }
    return out;
  }

  async findById(id) {
    return (await this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id)) || null;
  }

  async requireById(id, entityName = this.table) {
    const row = await this.findById(id);
    if (!row) throw new NotFoundError(entityName, id);
    return row;
  }

  async findBy(column, value) {
    return (await this.db
      .prepare(`SELECT * FROM ${this.table} WHERE ${column} = ?`)
      .get(value)) || null;
  }

  /**
   * Paginated list with free-text search and equality filters.
   * @param {object} q { search, page, pageSize, sort, order, filters: {col: value} }
   */
  async list(q = {}) {
    const { search = '', page = 1, pageSize = 25, sort, order = 'DESC', filters = {} } = q;
    const where = [];
    const params = [];

    const predicate = this.searchable.length ? this.searchPredicate(search) : null;
    if (predicate) {
      where.push(predicate.sql);
      params.push(...predicate.params);
    }
    for (const [col, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (!this.columns.includes(col) && col !== 'id' && col !== 'is_active') continue;
      where.push(`${col} = ?`);
      params.push(value);
    }

    // What is in the recycle bin is not on this screen.
    if (this.trashType && q.includeDeleted !== true) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM trash_items tb WHERE tb.entity_type = ? "
        + `AND tb.entity_id = ${this.table}.id AND tb.status = 'in_bin')`,
      );
      params.push(this.trashType);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const explicitSort = sort && this.columns.includes(sort)
      ? `${sort} ${order === 'ASC' ? 'ASC' : 'DESC'}`
      : this.defaultSort;

    // An exact code match leads, then whatever order the caller asked for.
    const rank = predicate ? this.searchRank(search) : null;
    const orderSql = rank ? `ORDER BY ${rank.sql}, ${explicitSort}` : `ORDER BY ${explicitSort}`;
    const orderParams = rank ? rank.params : [];

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${whereSql}`)
      .get(...params)).n;

    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db
      .prepare(`SELECT * FROM ${this.table} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, ...orderParams, size, (current - 1) * size);

    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async all(orderBy = this.defaultSort) {
    return this.db.prepare(`SELECT * FROM ${this.table} ORDER BY ${orderBy}`).all();
  }

  /**
   * What every dropdown in the ERP is filled from — so it has to honour the
   * recycle bin exactly as the list above does. A brand that was deleted this
   * morning must not still be offered as a choice when a product is created
   * this afternoon.
   */
  async activeOnly(orderBy = 'id ASC') {
    const hidden = this.trashType ? ` AND ${notInBin(this.trashType, `${this.table}.id`)}` : '';
    return this.db
      .prepare(`SELECT * FROM ${this.table} WHERE is_active = 1${hidden} ORDER BY ${orderBy}`)
      .all();
  }

  async create(data) {
    const payload = this.pick(data);
    if (this.timestamps) {
      payload.created_at = payload.created_at || nowIso();
      payload.updated_at = nowIso();
    }
    const cols = Object.keys(payload);
    if (!cols.length) throw new ConflictError('Nothing to insert');
    const sql = `INSERT INTO ${this.table} (${cols.join(', ')})
                 VALUES (${cols.map(() => '?').join(', ')})`;
    const info = await this.db.prepare(sql).run(...cols.map((c) => payload[c]));
    return this.findById(info.lastInsertRowid);
  }

  async update(id, data) {
    await this.requireById(id);
    const payload = this.pick(data);
    if (this.timestamps) payload.updated_at = nowIso();
    const cols = Object.keys(payload);
    if (!cols.length) return this.findById(id);
    const sql = `UPDATE ${this.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    await this.db.prepare(sql).run(...cols.map((c) => payload[c]), id);
    return this.findById(id);
  }

  async remove(id) {
    await this.requireById(id);
    await this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return true;
  }

  /** Soft delete — preferred for master data referenced by historic documents. */
  async deactivate(id) {
    return this.update(id, { is_active: 0 });
  }

  async count(whereSql = '', params = []) {
    return (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${whereSql ? `WHERE ${whereSql}` : ''}`)
      .get(...params)).n;
  }

  async exists(column, value, excludeId = null) {
    const sql = excludeId
      ? `SELECT 1 FROM ${this.table} WHERE ${column} = ? AND id <> ? LIMIT 1`
      : `SELECT 1 FROM ${this.table} WHERE ${column} = ? LIMIT 1`;
    const args = excludeId ? [value, excludeId] : [value];
    return Boolean(await this.db.prepare(sql).get(...args));
  }
}

export default BaseRepository;
