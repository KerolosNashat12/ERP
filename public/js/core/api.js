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

/* ------------------------------------------------ addresses for pictures

An `<img src>` is a request like any other, and it needs the tenant prefix
exactly as much as a `fetch` does — but it does NOT go through this module's
request door, so it is the one kind of API call a view can build by hand
without noticing. It did: the brands screen and the product photo editor
each wrote `/api/…/raw` as a literal, which is correct on the single-shop
build and 404 on `/t/<slug>/`, so every brand logo and every product
photograph rendered as a broken-image icon for any shop on the multi-tenant
build. The symptom is silent — no console error a shop owner would see, no
failed request in the UI, just a little torn page where a logo should be.

So picture addresses are NAMED here, next to `apiBase()`, the way the
storefront's own `api.js` already names `imageUrl`, `brandLogoUrl` and
`categoryImageUrl`. A view asks for the address of a thing; it does not
assemble one. `tests/asset-urls.test.js` fails if a literal `/api/…` ever
appears as a `src`, `href` or `url()` under `public/js/` again.
*/

/** Any server path, made absolute for THIS tenant. The escape hatch, named. */
export const assetUrl = (path) => (path ? apiBase() + path : null);

/**
 * A brand's mark. `version` busts the cache after a replacement — the address
 * carries no id of its own, so without it a replaced logo keeps showing the
 * old bytes until a hard reload.
 */
export const brandLogoUrl = (brandId, version) => {
  const base = `${apiBase()}/api/brands/${Number(brandId)}/logo/raw`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
};

/** One of a product's photographs, in the ERP's own editor. */
export const productImageUrl = (productId, imageId) =>
  `${apiBase()}/api/products/${Number(productId)}/images/${Number(imageId)}/raw`;

/** A category's picture — same arrangement as a brand's logo, same reason. */
export const categoryImageUrl = (categoryId, version) => {
  const base = `${apiBase()}/api/categories/${Number(categoryId)}/image/raw`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
};

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
  /**
   * A file that has to be ASKED for rather than linked to.
   *
   * `download()` below points an `<a>` at a URL, which is right for a file that
   * already exists: the browser does the work and a failure is a broken
   * download. It is wrong for something the server has to build — the shop's
   * whole data export — because every refusal (no permission, too soon, one
   * already running) would arrive as a file called `error.zip` instead of as a
   * message somebody can read in their own language.
   *
   * So: a POST, whose refusals are JSON with a code and reach `toastError()`
   * like every other error in this app, and whose success is bytes turned into
   * a download here. `clone()` because an identical request already in the air
   * is handed the same Response by the dedupe above, and a body can only be
   * read once.
   */
  async postDownload(path, body, fallbackName) {
    const response = await request(path, { method: 'POST', body, raw: true });
    if (!response.ok) {
      const text = await response.clone().text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      const error = payload?.error || {};
      throw new ApiError(error.message || `Request failed (${response.status})`,
        response.status, error.code, error.details);
    }

    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const blob = await response.clone().blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = match ? match[1] : (fallbackName || 'download');
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Late enough that the download has started, early enough that a shop's
    // whole book is not held in the tab for the rest of the session.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { filename: link.download, size: blob.size };
  },
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
