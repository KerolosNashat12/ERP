/**
 * Platform (owner) authentication — deliberately a separate world from the
 * ERP's `AuthService`.
 *
 * The cookie has its own name, `mm_platform`, but a cookie name alone would
 * not stop an attacker from just relabelling one cookie as the other — so the
 * token itself is signed with a different secret, derived from the ERP's but
 * not equal to it. A tenant session token, whatever cookie it arrives in, can
 * never verify against this secret; a platform token can never verify against
 * the ERP's. That is what makes the cross-cookie rejection a property of the
 * signature, not of request plumbing that a client fully controls.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { platformDb, platformTransaction } from './db.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../shared/errors.js';

export const COOKIE_NAME = 'mm_platform';

const SECRET = crypto.createHash('sha256').update(`${config.auth.secret}::platform-control-plane`).digest('hex');
const TOKEN_TTL = '12h';

function issueToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, scope: 'platform' }, SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    throw new UnauthorizedError('Session expired, please sign in again');
  }
  // Belt and braces alongside the distinct secret: even a token forged with
  // the right secret by mistake (a future refactor that reuses SECRET,
  // say) still needs the right scope to be accepted here.
  if (payload.scope !== 'platform') throw new UnauthorizedError();
  return payload;
}

function readToken(req) {
  if (req.cookies?.[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export async function login({ username, password }) {
  const db = platformDb();
  const user = await db.prepare('SELECT * FROM platform_users WHERE username = ?').get(username);
  if (!user || !user.is_active || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw new UnauthorizedError('Invalid username or password');
  }
  await db.prepare('UPDATE platform_users SET last_login_at = ? WHERE id = ?')
    .run(new Date().toISOString(), user.id);
  return {
    token: issueToken(user),
    user: { id: user.id, username: user.username, fullName: user.full_name },
  };
}

/**
 * Whether this console has an owner yet.
 *
 * Unauthenticated on purpose: the sign-in page has to know which of the two
 * things to draw before anybody can prove anything. It leaks one bit — that a
 * fresh deployment is fresh — and that bit is already visible in the fact that
 * no password works.
 */
export async function needsSetup() {
  const row = await platformDb().prepare('SELECT id FROM platform_users LIMIT 1').get();
  return !row;
}

/**
 * Create the first owner, from the console itself.
 *
 * Environment variables are a poor place for a password nobody has chosen yet,
 * so the first person to open a new console sets one here. The window closes
 * the moment it is used: with an owner on file this refuses, so it cannot be
 * used to add a second account or to overwrite the first. The check and the
 * insert run in one transaction, so two people racing on a cold start cannot
 * both win.
 */
export async function setup({ password, fullName }) {
  const chosen = String(password || '');
  if (chosen.length < 8) {
    throw new ValidationError('Choose a password of at least 8 characters');
  }

  const created = await platformTransaction(async (db) => {
    const existing = await db.prepare('SELECT id FROM platform_users LIMIT 1').get();
    if (existing) return null;
    const hash = bcrypt.hashSync(chosen, config.auth.bcryptRounds);
    const result = await db.prepare(`
      INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
      VALUES ('owner', ?, ?, 1, ?)
    `).run(hash, String(fullName || 'Platform Owner').slice(0, 80), new Date().toISOString());
    return Number(result.lastInsertRowid);
  });

  if (!created) {
    throw new ConflictError('This console already has an owner — sign in instead');
  }
  return login({ username: 'owner', password: chosen });
}

export async function authenticate(req, _res, next) {
  try {
    const token = readToken(req);
    if (!token) throw new UnauthorizedError();
    const payload = verifyToken(token);
    const db = platformDb();
    const user = await db.prepare('SELECT * FROM platform_users WHERE id = ?').get(payload.sub);
    if (!user || !user.is_active) throw new UnauthorizedError('Account is no longer active');
    req.platformUser = { id: user.id, username: user.username, fullName: user.full_name };
    next();
  } catch (error) {
    next(error);
  }
}

export default {
  COOKIE_NAME, login, authenticate, needsSetup, setup,
};
