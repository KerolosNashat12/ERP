/**
 * The Turso Platform API — just enough of it to give a new shop its own
 * database without the owner ever seeing a URL or a token.
 *
 * A thin `fetch` client rather than a dependency: four calls, all JSON over
 * HTTPS, and a shop owner should not have to install anything to open a shop.
 *
 * The token this module sends is the *Platform* token — it can create and
 * destroy every database in the organisation, which makes it the most
 * dangerous secret in the deployment. It is read at call time, sent only in an
 * Authorization header, and can never reach a caller: `redact()` is the last
 * line of defence for the case where Turso quotes a request back at us, and no
 * response body is ever passed through raw.
 */
import config from '../config/index.js';
import { AppError, ConflictError, ValidationError } from '../shared/errors.js';

/**
 * Turso's own ceiling on a database name. A slug can be 31 characters and the
 * `mm-` prefix pushes past it, so the name is truncated — which is exactly why
 * a collision has to be an error rather than a silent reuse: two different
 * shops can truncate to one name.
 */
const MAX_NAME_LENGTH = 32;

/** `mm-<slug>`, in the alphabet Turso accepts. */
export function databaseName(slug) {
  const cleaned = `mm-${String(slug || '').toLowerCase()}`.replace(/[^a-z0-9-]/g, '');
  // Truncation can leave a trailing hyphen, which Turso rejects.
  return cleaned.slice(0, MAX_NAME_LENGTH).replace(/-+$/, '');
}

/** Whether this deployment can make a database at all: a token and an org. */
export function canProvision() {
  return Boolean(config.turso.apiToken && config.turso.org);
}

/**
 * The address a created database answers at.
 *
 * Turso hands back a hostname and the driver wants a URL. `file:` and full
 * URLs are passed through untouched for the same reason `TenantService`
 * accepts them: the libSQL driver treats a local file exactly like a remote
 * database, which is what lets this whole path be exercised without a Turso
 * account (see tests/platform-provision.test.js).
 */
export const databaseUrl = (hostname) => (
  /^(libsql:|https:|file:)/i.test(hostname) ? String(hostname) : `libsql://${hostname}`
);

/** One line, no secrets, short enough to show a person. */
function redact(text) {
  const { apiToken } = config.turso;
  const line = String(text || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  return apiToken ? line.replaceAll(apiToken, '***') : line;
}

function tursoError(detail, { status = 502, httpStatus = null } = {}) {
  const error = new AppError(`Turso refused: ${redact(detail)}`, { status, code: 'TURSO_ERROR' });
  // Kept off the message so a caller can recognise a conflict without parsing
  // English, and so the status Turso used never has to be guessed at.
  error.httpStatus = httpStatus;
  return error;
}

/**
 * What went wrong, said in a way the owner can act on. Only Turso's own
 * `error` string is ever quoted — a raw body could be an HTML page from a
 * proxy, or carry back something we sent it.
 */
async function reasonFor(response, name) {
  const { org } = config.turso;
  let quoted = '';
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') quoted = body.error;
  } catch { /* not JSON: the status code is all that can honestly be reported */ }

  switch (response.status) {
    case 401:
    case 403:
      return 'the API token was rejected — check TURSO_API_TOKEN, it must be a Platform API token '
        + 'created in the Turso dashboard, not a database token';
    case 404:
      return name
        ? `there is no database named "${name}" in organisation "${org}"`
        : `organisation "${org}" was not found — check TURSO_ORG`;
    case 402:
      return 'the Turso account is at its plan limit — remove an unused database or upgrade the plan';
    case 429:
      return 'too many requests were sent at once — wait a moment and try again';
    default:
      return quoted ? `${quoted} (HTTP ${response.status})` : `HTTP ${response.status}`;
  }
}

async function request(path, { method = 'GET', body, name = null } = {}) {
  const { apiUrl, apiToken, org } = config.turso;
  if (!canProvision()) {
    throw new ValidationError(
      'This deployment cannot create databases — set TURSO_API_TOKEN and TURSO_ORG on it first',
    );
  }

  const url = `${apiUrl}/v1/organizations/${encodeURIComponent(org)}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // No network, a blocked egress, a shop PC that is offline. 503 rather than
    // 502: nothing is wrong with the request, only with getting it there.
    let host = apiUrl;
    try { host = new URL(apiUrl).host; } catch { /* a malformed TURSO_API_URL is worth showing whole */ }
    throw tursoError(
      `could not be reached at ${host} (${error.message}) — check this deployment's internet access`,
      { status: 503 },
    );
  }

  if (!response.ok) {
    throw tursoError(await reasonFor(response, name), { httpStatus: response.status });
  }
  if (method === 'DELETE') return null;
  try {
    return await response.json();
  } catch {
    throw tursoError(`the reply to ${method} ${path} was not readable JSON`);
  }
}

export async function listDatabases() {
  const body = await request('/databases');
  const rows = Array.isArray(body?.databases) ? body.databases : [];
  return rows.map((row) => ({ name: row.Name || row.name || '' }));
}

/**
 * A brand-new, empty database.
 *
 * The name is checked against the organisation before anything is created, and
 * a conflict from the API itself is mapped to the same refusal for the case
 * where two consoles create at once. Handing back an existing database instead
 * would give a new shop somebody else's data — the one outcome this whole
 * feature must never produce.
 */
export async function createDatabase(name) {
  const taken = (await listDatabases()).some((row) => row.name === name);
  const conflict = () => new ConflictError(
    `A Turso database named "${name}" already exists — it belongs to another shop, `
    + 'and reusing it would mix two shops\' data. Choose a different shop name.',
  );
  if (taken) throw conflict();

  let body;
  try {
    body = await request('/databases', { method: 'POST', body: { name, group: config.turso.group }, name });
  } catch (error) {
    if (error.httpStatus === 409) throw conflict();
    throw error;
  }

  const database = body?.database || {};
  const hostname = database.Hostname || database.hostname || '';
  if (!hostname) throw tursoError(`the new database "${name}" came back without an address`);
  return { name: database.Name || database.name || name, hostname };
}

/** A database token for one database — what the tenant row stores and uses. */
export async function createDatabaseToken(name) {
  const body = await request(`/databases/${encodeURIComponent(name)}/auth/tokens`, { method: 'POST', name });
  const jwt = body?.jwt || '';
  if (!jwt) throw tursoError(`no auth token came back for database "${name}"`);
  return jwt;
}

/**
 * Destroys a database and everything in it. The only caller is the rollback in
 * `TenantService.create`, and only ever for a database that same call created
 * moments earlier — see the note there.
 */
export async function deleteDatabase(name) {
  await request(`/databases/${encodeURIComponent(name)}`, { method: 'DELETE', name });
}

export default {
  canProvision, databaseName, databaseUrl, listDatabases, createDatabase, createDatabaseToken, deleteDatabase,
};
