/**
 * Thin fetch wrapper for the platform API — every call goes to
 * `/api/platform/...`, carries the `mm_platform` cookie only (never a
 * tenant cookie), and never touches `/api/...` or `/t/:slug/api/...`.
 *
 * It is also where the console's half of "one save, one thing saved" lives,
 * for the same reason as in the other two apps: this is the single door every
 * request already goes through, so a rule put here is a rule no future screen
 * can forget. Provisioning a shop twice because the button was slow to respond
 * is the same bug as the owner's double-saved purchase order, and it creates a
 * whole database rather than a document.
 *
 * An unsafe request that is already in the air is not sent again — both callers
 * wait on the one promise, which is what makes this survive a view being
 * re-rendered underneath a button — and every unsafe request carries an
 * `Idempotency-Key` so the server refuses a duplicate this page never saw:
 * a retransmit on a bad connection, a restored page, a second tab. The key is
 * held per submission and dropped the moment one succeeds, so deliberately
 * doing the same thing twice still does it twice.
 */

import { t } from './i18n.js';

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = '/api/platform';

// ------------------------------------------------------- one save, one thing

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** In the air right now, by signature -> the promise every caller shares. */
const inFlight = new Map();

/** Keys held per submission; an entry is dropped when that submission works. */
const heldKeys = new Map();
const KEY_TTL_MS = 10 * 60_000;

/** Key order is decided by whatever built the object, never by the owner. */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const newKey = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

function keyFor(signature) {
  const now = Date.now();
  for (const [held, entry] of heldKeys) {
    if (now - entry.at > KEY_TTL_MS) heldKeys.delete(held);
  }
  const existing = heldKeys.get(signature);
  if (existing) return existing.key;
  const key = newKey();
  heldKeys.set(signature, { key, at: now });
  return key;
}

/** How many unsafe requests are in the air — see core/actions.js. */
export const pendingRequests = () => inFlight.size;

/** Settles when everything currently in the air has finished, however it ends. */
export const settledRequests = () => Promise.allSettled([...inFlight.values()]);

const listeners = new Set();
/** Fired on a 401 from an already-authenticated call, so the app can drop
 *  back to the sign-in screen. Never fired for the login call itself — a
 *  wrong password there is a normal, expected 401, not a lost session. */
export const onUnauthorized = (fn) => listeners.add(fn);

function request(path, options = {}) {
  const method = options.method || 'GET';
  if (!UNSAFE.has(method)) return send(path, options, null);

  const signature = `${method} ${path} ${canonical(options.body)}`;
  const already = inFlight.get(signature);
  // The double-click, stopped before it reaches the network at all.
  if (already) return already;

  const key = keyFor(signature);
  const attempt = send(path, options, key)
    .then((payload) => {
      // Succeeded: this submission is spent, so the next identical one is a
      // genuinely new request and mints a key of its own.
      heldKeys.delete(signature);
      return payload;
    })
    .finally(() => inFlight.delete(signature));

  inFlight.set(signature, attempt);
  return attempt;
}

async function send(path, {
  method = 'GET', body, query, isLogin = false,
} = {}, idempotencyKey) {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }

  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    /**
     * A dropped connection arrives as `TypeError: Failed to fetch`, which is
     * the browser talking to a developer. What the owner needs on screen is
     * what to do about it, in their own language — the retry button beside
     * this message is the rest of the answer.
     */
    throw new ApiError(t('networkError'), 0, 'network');
  }

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!response.ok) {
    if (response.status === 401 && !isLogin) listeners.forEach((fn) => fn());
    const error = payload?.error || {};
    throw new ApiError(error.message || `Request failed (${response.status})`,
      response.status, error.code, error.details);
  }
  return payload;
}

export const api = {
  get: (path, query) => request(path, { query }),
  post: (path, body, opts) => request(path, { method: 'POST', body, ...opts }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
};

export { ApiError };
export default api;
