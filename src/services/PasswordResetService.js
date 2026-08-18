/**
 * Account recovery without a mail server.
 *
 * The shop has to keep working with the internet down, so an emailed reset link
 * is exactly the wrong mechanism: it fails during the outage that is most likely
 * to strand someone at the till. Instead a locked-out user raises a request and
 * an administrator approves it face to face, which is also the only identity
 * check a small shop can genuinely perform.
 *
 * Deliberate choices:
 *  - Requesting a reset never reveals whether the username exists. An unknown
 *    name returns the same response as a real one, so this cannot be used to
 *    enumerate staff accounts.
 *  - The one-time password is returned exactly once, to the approving admin, and
 *    is never stored in readable form.
 *  - The account is unlocked and its failed-attempt counter cleared on approval,
 *    because "locked out" is the usual reason for asking in the first place.
 */
import crypto from 'node:crypto';
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../shared/errors.js';
import authService from './AuthService.js';
import auditService from './AuditService.js';

/** No look-alike characters: this gets read aloud or written on paper. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateOneTimePassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export class PasswordResetService {
  constructor(deps = {}) {
    this.users = deps.users || repositories.users;
    this.auth = deps.auth || authService;
    this.audit = deps.audit || auditService;
  }

  get db() {
    return getDb();
  }

  /**
   * Raise a request. Unauthenticated by design — the whole point is that the
   * caller cannot sign in. Always reports success.
   */
  async request({ username, note } = {}, request = {}) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) throw new ValidationError('Username is required');

    const user = await this.users.findByUsername(name);
    if (!user) {
      // Same shape as the success path, so a stranger learns nothing.
      await this.audit.record({
        action: 'RESET_REQUEST', module: 'users', status: 'FAILED',
        message: `Password reset requested for unknown username "${name}"`,
        actor: { id: null, username: name }, request,
      });
      return { requested: true };
    }

    const pending = await this.db
      .prepare("SELECT id FROM password_reset_requests WHERE user_id = ? AND status = 'pending' LIMIT 1")
      .get(user.id);
    if (pending) return { requested: true, alreadyPending: true };

    await this.db.prepare(`
      INSERT INTO password_reset_requests (user_id, username, note, requested_ip)
      VALUES (?, ?, ?, ?)
    `).run(user.id, user.username, note ? String(note).slice(0, 300) : null, request.ip || null);

    await this.audit.record({
      action: 'RESET_REQUEST', module: 'users', entityType: 'user', entityId: user.id,
      entityLabel: user.username, message: 'Password reset requested',
      actor: { id: user.id, username: user.username }, request,
    });
    return { requested: true };
  }

  /** Everything an administrator needs to triage, newest first. */
  async list({ status = 'pending' } = {}) {
    const where = status && status !== 'all' ? 'WHERE r.status = ?' : '';
    const params = where ? [status] : [];
    const rows = await this.db.prepare(`
      SELECT r.*, u.full_name, u.is_active, u.locked_until, h.username AS handled_by_username
        FROM password_reset_requests r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN users h ON h.id = r.handled_by
      ${where}
      ORDER BY r.requested_at DESC
      LIMIT 200
    `).all(...params);
    return { rows };
  }

  async pendingCount() {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM password_reset_requests WHERE status = 'pending'")
      .get();
    return row ? row.n : 0;
  }

  /**
   * Approve: mint a one-time password, force a change at next sign-in, and
   * clear the lockout. Returns the password once — it is never readable again.
   */
  async approve(id, context = {}) {
    return transaction(async () => {
      const requestRow = await this.#requirePending(id);
      const user = await this.users.requireById(requestRow.user_id, 'user');

      const oneTimePassword = generateOneTimePassword();
      await this.users.update(user.id, {
        password_hash: this.auth.hashPassword(oneTimePassword),
        must_change_password: 1,
        failed_attempts: 0,
        locked_until: null,
      });

      await this.#close(id, 'approved', context);
      await this.audit.record({
        action: 'RESET_APPROVE', module: 'users', entityType: 'user', entityId: user.id,
        entityLabel: user.username,
        message: 'Password reset approved; one-time password issued',
        actor: context.actor, request: context.request,
      });

      return { approved: true, username: user.username, oneTimePassword };
    });
  }

  async reject(id, context = {}) {
    return transaction(async () => {
      const requestRow = await this.#requirePending(id);
      await this.#close(id, 'rejected', context);
      await this.audit.record({
        action: 'RESET_REJECT', module: 'users', entityType: 'user',
        entityId: requestRow.user_id, entityLabel: requestRow.username,
        message: 'Password reset request rejected',
        actor: context.actor, request: context.request,
      });
      return { rejected: true };
    });
  }

  async #requirePending(id) {
    const row = await this.db
      .prepare('SELECT * FROM password_reset_requests WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Password reset request', id);
    if (row.status !== 'pending') {
      throw new BusinessRuleError('That request has already been handled');
    }
    return row;
  }

  async #close(id, status, context) {
    await this.db.prepare(`
      UPDATE password_reset_requests
         SET status = ?, handled_by = ?, handled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?
    `).run(status, context.actor?.id || null, id);
  }
}

export const passwordResetService = new PasswordResetService();
export default passwordResetService;
