/** Users, roles/permissions, audit trail, settings and document sequences. */
import { BaseRepository } from './BaseRepository.js';
import { getDb } from '../database/connection.js';

export class UserRepository extends BaseRepository {
  constructor() {
    super({
      table: 'users',
      columns: [
        'username', 'full_name', 'email', 'phone', 'password_hash', 'role_id',
        'default_warehouse_id', 'language', 'is_active', 'must_change_password',
        'failed_attempts', 'locked_until', 'last_login_at', 'created_by',
      ],
      searchable: ['username', 'full_name', 'email', 'phone'],
    });
  }

  async findByUsername(username) {
    return (await this.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(String(username || '').trim())) || null;
  }

  async listDetailed({ search = '', roleId, isActive } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (search) {
      where.push('(u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (roleId) { where.push('u.role_id = ?'); params.push(roleId); }
    if (isActive !== undefined && isActive !== '') { where.push('u.is_active = ?'); params.push(Number(isActive)); }
    return this.db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role_id, u.language,
             u.is_active, u.last_login_at, u.locked_until, u.created_at,
             u.default_warehouse_id,
             r.code AS role_code, r.name_en AS role_name_en, r.name_ar AS role_name_ar,
             w.name_en AS warehouse_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN warehouses w ON w.id = u.default_warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY u.full_name
    `).all(...params);
  }

  async permissionsFor(userId) {
    return (await this.db.prepare(`
      SELECT p.code FROM users u
      JOIN role_permissions rp ON rp.role_id = u.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = ?
    `).all(userId)).map((r) => r.code);
  }

  async registerLoginSuccess(userId) {
    await this.db.prepare(
      'UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    ).run(new Date().toISOString(), userId);
  }

  async registerLoginFailure(userId, maxAttempts, lockMinutes) {
    const user = await this.findById(userId);
    const attempts = (user?.failed_attempts || 0) + 1;
    const lockedUntil = attempts >= maxAttempts
      ? new Date(Date.now() + lockMinutes * 60_000).toISOString()
      : null;
    await this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, lockedUntil, userId);
    return { attempts, lockedUntil };
  }
}

export class RoleRepository extends BaseRepository {
  constructor() {
    super({
      table: 'roles',
      columns: ['code', 'name_en', 'name_ar', 'description', 'is_system'],
      searchable: ['code', 'name_en'],
      timestamps: false,
      defaultSort: 'id ASC',
    });
  }

  async withPermissions() {
    const roles = await this.all('id ASC');
    const map = await this.db.prepare(`
      SELECT rp.role_id, p.code FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
    `).all();
    // The per-role user count is a query, so this cannot stay a `map()` callback.
    const withCounts = [];
    for (const role of roles) {
      withCounts.push({
        ...role,
        permissions: map.filter((m) => m.role_id === role.id).map((m) => m.code),
        user_count: (await this.db
          .prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(role.id)).n,
      });
    }
    return withCounts;
  }

  async setPermissions(roleId, permissionCodes) {
    const db = getDb();
    await db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
    const link = db.prepare(`
      INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT ?, id FROM permissions WHERE code = ?
    `);
    for (const code of permissionCodes) await link.run(roleId, code);
  }
}

export class AuditRepository {
  get db() {
    return getDb();
  }

  async write(entry) {
    await this.db.prepare(`
      INSERT INTO audit_logs
        (user_id, username, action, module, entity_type, entity_id, entity_label,
         before_data, after_data, status, message, ip_address, user_agent)
      VALUES (@user_id, @username, @action, @module, @entity_type, @entity_id, @entity_label,
              @before_data, @after_data, @status, @message, @ip_address, @user_agent)
    `).run({
      user_id: null, username: null, entity_type: null, entity_id: null, entity_label: null,
      before_data: null, after_data: null, status: 'SUCCESS', message: null,
      ip_address: null, user_agent: null, ...entry,
    });
  }

  async list({ search = '', userId, module, action, entityType, dateFrom, dateTo, status,
    page = 1, pageSize = 50 } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (search) {
      where.push('(a.entity_label LIKE ? OR a.message LIKE ? OR a.username LIKE ? OR a.entity_id LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (userId) { where.push('a.user_id = ?'); params.push(userId); }
    if (module) { where.push('a.module = ?'); params.push(module); }
    if (action) { where.push('a.action = ?'); params.push(action); }
    if (entityType) { where.push('a.entity_type = ?'); params.push(entityType); }
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (dateFrom) { where.push('date(a.created_at) >= date(?)'); params.push(dateFrom); }
    if (dateTo) { where.push('date(a.created_at) <= date(?)'); params.push(dateTo); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${whereSql}`).get(...params)).n;
    const size = Math.min(Number(pageSize) || 50, 500);
    const current = Math.max(Number(page) || 1, 1);
    const rows = await this.db.prepare(`
      SELECT a.*, u.full_name AS user_full_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?
    `).all(...params, size, (current - 1) * size);
    return { rows, total, page: current, pageSize: size, pages: Math.ceil(total / size) || 1 };
  }

  async distinctValues() {
    return {
      modules: (await this.db.prepare('SELECT DISTINCT module FROM audit_logs ORDER BY module').all()).map((r) => r.module),
      actions: (await this.db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all()).map((r) => r.action),
    };
  }

  async activitySummary(days = 7) {
    return this.db.prepare(`
      SELECT date(created_at) AS day, module, COUNT(*) AS events
      FROM audit_logs
      WHERE created_at >= datetime('now', ?)
      GROUP BY day, module ORDER BY day DESC
    `).all(`-${days} days`);
  }
}

export class SettingsRepository {
  get db() {
    return getDb();
  }

  async all() {
    const rows = await this.db.prepare('SELECT * FROM settings ORDER BY group_name, key').all();
    return rows.map((r) => ({ ...r, value: decode(r.value, r.value_type) }));
  }

  async asObject() {
    return Object.fromEntries((await this.all()).map((r) => [r.key, r.value]));
  }

  async get(key, fallback = null) {
    const row = await this.db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
    return row ? decode(row.value, row.value_type) : fallback;
  }

  async set(key, value, { valueType, group } = {}) {
    const type = valueType || inferType(value);
    await this.db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name, updated_at)
      VALUES (?, ?, ?, COALESCE(?, 'general'), ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, value_type = excluded.value_type,
                                     updated_at = excluded.updated_at
    `).run(key, encode(value), type, group || null, new Date().toISOString());
  }
}

function inferType(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value && typeof value === 'object') return 'json';
  return 'string';
}
function encode(value) {
  if (value && typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return value === null || value === undefined ? null : String(value);
}
function decode(value, type) {
  if (value === null) return null;
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === '1' || value === 'true';
  if (type === 'json') { try { return JSON.parse(value); } catch { return null; } }
  return value;
}

/**
 * Document numbering. Runs inside the caller's transaction so two concurrent
 * sales can never receive the same invoice number.
 */
export class SequenceRepository {
  get db() {
    return getDb();
  }

  async next(name) {
    const row = await this.db.prepare('SELECT * FROM sequences WHERE name = ?').get(name);
    if (!row) throw new Error(`Unknown sequence: ${name}`);
    const year = new Date().getFullYear();
    let value = row.next_value;
    if (row.reset_yearly && row.year !== year) {
      value = 1;
      await this.db.prepare('UPDATE sequences SET year = ? WHERE name = ?').run(year, name);
    }
    await this.db.prepare('UPDATE sequences SET next_value = ? WHERE name = ?').run(value + 1, name);
    const padded = String(value).padStart(row.padding, '0');
    return row.reset_yearly ? `${row.prefix}-${year}-${padded}` : `${row.prefix}-${padded}`;
  }
}
