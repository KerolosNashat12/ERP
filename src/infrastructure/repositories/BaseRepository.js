/**
 * Generic table gateway. Concrete repositories extend it and add only the
 * queries that are actually specific to their aggregate — this is where the
 * DRY win lives, since 8 of the 14 tables need nothing but plain CRUD.
 *
 * Every method is async because one of the two supported drivers talks over a
 * network. See `database/connection.js`.
 */
import { getDb } from '../database/connection.js';
import { NotFoundError, ConflictError } from '../../shared/errors.js';

const nowIso = () => new Date().toISOString();

export class BaseRepository {
  /**
   * @param {object} options
   * @param {string} options.table          physical table name
   * @param {string[]} options.columns      writable columns
   * @param {string[]} [options.searchable] columns included in free-text search
   * @param {boolean} [options.timestamps]  maintain created_at / updated_at
   */
  constructor({ table, columns, searchable = [], timestamps = true, defaultSort = 'id DESC' }) {
    this.table = table;
    this.columns = columns;
    this.searchable = searchable;
    this.timestamps = timestamps;
    this.defaultSort = defaultSort;
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

    if (search && this.searchable.length) {
      where.push(`(${this.searchable.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      this.searchable.forEach(() => params.push(`%${search}%`));
    }
    for (const [col, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (!this.columns.includes(col) && col !== 'id' && col !== 'is_active') continue;
      where.push(`${col} = ?`);
      params.push(value);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSql = sort && this.columns.includes(sort)
      ? `ORDER BY ${sort} ${order === 'ASC' ? 'ASC' : 'DESC'}`
      : `ORDER BY ${this.defaultSort}`;

    const total = (await this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${this.table} ${whereSql}`)
      .get(...params)).n;

    const size = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db
      .prepare(`SELECT * FROM ${this.table} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, size, (current - 1) * size);

    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async all(orderBy = this.defaultSort) {
    return this.db.prepare(`SELECT * FROM ${this.table} ORDER BY ${orderBy}`).all();
  }

  async activeOnly(orderBy = 'id ASC') {
    return this.db
      .prepare(`SELECT * FROM ${this.table} WHERE is_active = 1 ORDER BY ${orderBy}`)
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
