/** Thin fetch wrapper. Every network call in the UI goes through here. */

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

async function request(path, { method = 'GET', body, query, raw = false } = {}) {
  const url = new URL(path, window.location.origin);
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
    const url = new URL(path, window.location.origin);
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
