/**
 * Who is making this request, remembered for a few seconds.
 *
 * `authenticate` ran two queries before ANY route did its own work: read the
 * user row, then read every permission that user's role carries. On the shop
 * PC those are microseconds. On the hosted database they are two network round
 * trips added to every single request the ERP makes - opening the products page
 * costs them four times over, once per call it fires.
 *
 * The token already proves who the caller is; these two reads only answer "is
 * this account still active, and what may it do". Both change rarely and both
 * are changed through this application, so the answer is cached briefly and
 * thrown away the moment anything touches users, roles or permissions.
 *
 * The TTL is deliberately short. A cache here is a window during which a
 * disabled account can still act, so it is measured in seconds, not minutes -
 * long enough to cover the burst of calls one screen makes, short enough that
 * "I removed his access" is true by the time the sentence is finished. Every
 * write path calls forgetIdentity() anyway, so the TTL only covers changes made
 * by something outside this process - another serverless instance, or somebody
 * editing the database by hand.
 */
import { currentTenant } from '../../infrastructure/database/connection.js';

const TTL_MS = Number(process.env.MM_IDENTITY_TTL_MS || 8000);
const MAX_ENTRIES = 500;

const entries = new Map();

const keyFor = (userId) => `${currentTenant() || '-'}:${userId}`;

export function readIdentity(userId) {
  if (TTL_MS <= 0) return null;
  const hit = entries.get(keyFor(userId));
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    entries.delete(keyFor(userId));
    return null;
  }
  return hit;
}

export function rememberIdentity(userId, user, permissions) {
  if (TTL_MS <= 0) return;
  const key = keyFor(userId);
  entries.delete(key);
  entries.set(key, { user, permissions, expires: Date.now() + TTL_MS });
  // Bounded, oldest first - this runs in a serverless function, not a cache server.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

/**
 * Forget one user, or everybody. Called from every path that can change what a
 * user is or may do: their row, their role, that role's permissions, and the
 * modules a shop is entitled to.
 */
export function forgetIdentity(userId = null) {
  if (userId === null) { entries.clear(); return; }
  entries.delete(keyFor(userId));
  // A role change affects everyone holding it and the caller rarely knows who,
  // so a named user is dropped from every tenant's slot as well.
  for (const key of entries.keys()) if (key.endsWith(`:${userId}`)) entries.delete(key);
}

export const forgetAllIdentities = () => entries.clear();
