/**
 * Thin fetch wrapper. Every network call in the UI goes through here.
 *
 * Which is exactly why the "one save, one purchase order" guard lives here and
 * not in the twenty-odd screens that save something. A rule each new button has
 * to remember is not a rule; this module is the one door every request already
 * goes through, so a request that must not happen twice cannot happen twice
 * whoever asks for it.
 *
 * Two things are done to an unsafe request (POST/PUT/PATCH/DELETE) that are not
 * done to a GET:
 *
 *   1. It is DEDUPED while it is in the air. A second identical request — the
 *      second half of a double-click, Enter pressed twice, the same Save button
 *      after the view re-rendered underneath it, a second component asking for
 *      the same thing — is handed the promise the first one is already waiting
 *      on. Nothing goes out on the wire, and both callers get the same answer.
 *      This is the part that survives a re-render, because the state lives in
 *      this module rather than on a DOM node that gets replaced.
 *
 *   2. It carries an `Idempotency-Key`, so the SERVER can refuse to create the
 *      same thing twice even when this module is out of the picture entirely —
 *      a phone that retransmits on a bad connection, a page restored from the
 *      back-forward cache, a second tab. The key is random and is held per
 *      submission: the same submission retried keeps its key, and the key is
 *      thrown away the moment the submission SUCCEEDS. That last detail is what
 *      keeps two genuinely identical sales, rung up a minute apart, two sales —
 *      the second one mints a new key and is a new request.
 */

/**
 * The browser learns its tenant prefix from the URL, not from anything
 * server-rendered: `''` for the single-shop build and the platform's own
 * `/platform` shell, `/t/<slug>` whenever the page was loaded under a
 * tenant path. Every request and every asset/download URL this module
 * builds is routed through this, so the SPA works unmodified whether it is
 * serving `/` or `/t/mm/`.
 */
export function apiBase() {
  const match = window.location.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{0,30})(?:\/|$)/);
  return match ? `/t/${match[1]}` : '';
}

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

// ------------------------------------------------------- one save, one document

/** The methods that can create or change something. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** In the air right now, by signature -> the promise every caller shares. */
const inFlight = new Map();

/**
 * Idempotency keys being held, by signature. An entry is created when a
 * submission first goes out and deleted when it succeeds, so a retry keeps its
 * key and a deliberate repeat gets a fresh one. Failures keep theirs: a retry
 * after a dropped connection is the same submission, and the server has to be
 * able to tell that it is.
 */
const heldKeys = new Map();

/** Anything held for longer than the server's own window is dead weight. */
const KEY_TTL_MS = 10 * 60_000;

/**
 * A rendering in which key order does not matter, so `{a,b}` and `{b,a}` — the
 * same form filled the same way — are one request rather than two.
 */
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

/**
 * The public entry point. A GET goes straight out; anything that writes goes
 * through the dedupe above first.
 */
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

async function send(path, { method = 'GET', body, query, raw = false } = {}, idempotencyKey) {
  const url = new URL(apiBase() + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }

  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    listeners.forEach((fn) => fn());
    throw new ApiError('Your session has expired', 401, 'UNAUTHORIZED');
  }
  if (raw) return response;

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError(error.message || `Request failed (${response.status})`,
      response.status, error.code, error.details);
  }
  return payload;
}

export const api = {
  get: (path, query) => request(path, { query }),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  download(path, query, filename) {
    const url = new URL(apiBase() + path, window.location.origin);
    if (query) {
      for (const [k, val] of Object.entries(query)) {
        if (val !== undefined && val !== null && val !== '') url.searchParams.set(k, val);
      }
    }
    const link = document.createElement('a');
    link.href = url.toString();
    if (filename) link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  },
};

export { ApiError };
export default api;
