/**
 * Thin fetch wrapper for the platform API — every call goes to
 * `/api/platform/...`, carries the `mm_platform` cookie only (never a
 * tenant cookie), and never touches `/api/...` or `/t/:slug/api/...`.
 */

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const BASE = '/api/platform';

const listeners = new Set();
/** Fired on a 401 from an already-authenticated call, so the app can drop
 *  back to the sign-in screen. Never fired for the login call itself — a
 *  wrong password there is a normal, expected 401, not a lost session. */
export const onUnauthorized = (fn) => listeners.add(fn);

async function request(path, {
  method = 'GET', body, query, isLogin = false,
} = {}) {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

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
};

export { ApiError };
export default api;
