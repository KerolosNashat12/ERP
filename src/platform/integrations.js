/**
 * Connecting Turso from the console instead of from a deploy setting.
 *
 * The owner has the token. Asking him to put it in a host's environment screen
 * and redeploy asks him to leave the product to finish using the product — so
 * the console takes it, proves it, and keeps it.
 *
 * Three properties this file exists to hold:
 *
 *   VERIFIED BEFORE STORED — a token is checked against Turso itself before a
 *     byte of it is written. A credential that is accepted quietly and fails an
 *     hour later, halfway through creating a shop, would be worse than the
 *     environment variable it replaces, because by then the owner has stopped
 *     thinking about tokens.
 *   NOTHING PARTIAL — verification either returns everything needed (the
 *     organisation, the group, a live database count) or throws. There is no
 *     path that writes the token and then discovers the organisation.
 *   THE TOKEN NEVER COMES BACK — not from `status()`, not masked, not in an
 *     audit row, not in a log line. There is nothing useful to show: an owner
 *     who wants to change it pastes a new one. `platform_audit` records that
 *     Turso was connected and by whom, and the organisation it was connected
 *     to, which is not a secret and is on screen anyway.
 */
import turso from './turso.js';
import settings, { TURSO_KEYS } from './settings.js';
import { platformDb } from './db.js';

async function recordAudit(action, actor, detail) {
  await platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (?, NULL, ?, ?, ?)
  `).run(actor?.id ?? null, action, detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

/**
 * What the console draws the card from.
 *
 * `databases` is a live count when connected, because the number is the proof:
 * it can only be produced by a token that still works, in an organisation that
 * still exists. When that call fails the count is null and the reason is said
 * in words — a stale "connected" with no explanation is how an owner ends up
 * discovering the problem at shop-creation time instead.
 */
export async function status() {
  const creds = await turso.credentials();
  const connected = Boolean(creds.apiToken && creds.org);
  const base = {
    connected,
    // 'console' — pasted here; 'environment' — set on the host, still honoured.
    source: creds.source,
    org: connected ? creds.org : null,
    group: connected ? creds.group : null,
    databases: null,
    checkedAt: null,
    error: null,
  };
  if (!connected) return base;

  const checkedAt = new Date().toISOString();
  try {
    const databases = await turso.listDatabases(creds);
    return { ...base, databases: databases.length, checkedAt };
  } catch (error) {
    // `turso.js` has already redacted this; it is one sentence about Turso.
    return { ...base, checkedAt, error: error.message };
  }
}

/**
 * Verify, then store. In that order, with nothing written on any path that
 * throws — which is what makes "a token that fails is rejected and nothing is
 * kept" a property of the code rather than of the caller's diligence.
 */
export async function connectTurso({ apiToken, org, group } = {}, actor = null) {
  const verified = await turso.verifyToken({ apiToken, org, group });

  await settings.writeSettings({
    [TURSO_KEYS.apiToken]: String(apiToken).trim(),
    [TURSO_KEYS.org]: verified.org,
    [TURSO_KEYS.group]: verified.group,
  });

  // The organisation and the count, never the token.
  await recordAudit('TURSO_CONNECT', actor, { org: verified.org, group: verified.group });

  return {
    connected: true,
    source: 'console',
    org: verified.org,
    group: verified.group,
    databases: verified.databases,
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

/**
 * Forget it. Shops already created keep working untouched: each one holds its
 * own database URL and its own database token, and neither came from here.
 * What stops is this deployment's ability to make a *new* database by itself.
 */
export async function disconnectTurso(actor = null) {
  await settings.deleteSettings(Object.values(TURSO_KEYS));
  await recordAudit('TURSO_DISCONNECT', actor, null);
  return status();
}

export default { status, connectTurso, disconnectTurso };
