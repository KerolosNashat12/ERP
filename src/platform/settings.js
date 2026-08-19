/**
 * `platform_settings` — the handful of deployment settings an owner has to be
 * able to change from the console, because the alternative is a host's
 * environment screen and a redeploy.
 *
 * One table, key/value, read and written only through this file. Two rules
 * make it safe to keep a secret in:
 *
 *   - nothing here ever returns a value to a caller that did not name the key
 *     it wanted, so a "give me everything" accident cannot happen;
 *   - the one caller that reads `turso.api_token` (`turso.js`) puts it in an
 *     Authorization header and nowhere else. It is never logged, never audited
 *     and never serialised into a response — see `integrations.js`.
 *
 * Reads are tolerant of a control plane that is not open: this module is
 * imported by `turso.js`, which a single-shop build loads without ever calling
 * `initPlatformDb()`. "Not open" and "nothing stored" mean the same thing to
 * every caller — fall back to the environment — so they are answered the same
 * way rather than by throwing.
 */
import { platformDb } from './db.js';

export const TURSO_KEYS = {
  apiToken: 'turso.api_token',
  org: 'turso.org',
  group: 'turso.group',
};

/** The control-plane connection, or null when there is not one. */
function db() {
  try {
    return platformDb();
  } catch {
    return null;
  }
}

/**
 * The values for exactly the keys asked for, as a plain object. A key that is
 * absent, empty or unreadable comes back as `''` — every caller treats "not
 * set" and "set to nothing" identically, and a missing table (an old control
 * plane that has not been restarted since this feature shipped) is just
 * another way of saying "not set".
 */
export async function readSettings(keys) {
  const wanted = [...new Set(keys)];
  const out = Object.fromEntries(wanted.map((key) => [key, '']));
  const connection = db();
  if (!connection) return out;

  const placeholders = wanted.map(() => '?').join(', ');
  let rows = [];
  try {
    rows = await connection
      .prepare(`SELECT key, value FROM platform_settings WHERE key IN (${placeholders})`)
      .all(...wanted);
  } catch {
    return out;
  }
  for (const row of rows) out[row.key] = row.value == null ? '' : String(row.value);
  return out;
}

/**
 * Write or replace several keys at once. A key whose value is empty is deleted
 * rather than stored blank, so "connected without a group" and "no group" are
 * one state in the table instead of two.
 */
export async function writeSettings(entries) {
  const connection = db();
  if (!connection) throw new Error('Platform database not initialised — call await initPlatformDb() first.');
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(entries)) {
    const text = value === null || value === undefined ? '' : String(value);
    if (!text) {
      await connection.prepare('DELETE FROM platform_settings WHERE key = ?').run(key);
    } else {
      await connection.prepare(`
        INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, text, now);
    }
  }
}

export async function deleteSettings(keys) {
  const connection = db();
  if (!connection) return;
  for (const key of keys) {
    await connection.prepare('DELETE FROM platform_settings WHERE key = ?').run(key);
  }
}

/** When a key was last written — the "checked at" the console shows. */
export async function settingUpdatedAt(key) {
  const connection = db();
  if (!connection) return null;
  try {
    const row = await connection.prepare('SELECT updated_at FROM platform_settings WHERE key = ?').get(key);
    return row?.updated_at || null;
  } catch {
    return null;
  }
}

/** The three Turso keys, read together — the only shape `turso.js` wants. */
export async function readTurso() {
  const values = await readSettings(Object.values(TURSO_KEYS));
  return {
    apiToken: values[TURSO_KEYS.apiToken],
    org: values[TURSO_KEYS.org],
    group: values[TURSO_KEYS.group],
  };
}

export default {
  TURSO_KEYS, readSettings, writeSettings, deleteSettings, settingUpdatedAt, readTurso,
};
