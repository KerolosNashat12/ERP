/**
 * The Turso Platform API — just enough of it to give a new shop its own
 * database without the owner ever seeing a URL or a token.
 *
 * A thin `fetch` client rather than a dependency: five calls, all JSON over
 * HTTPS, and a shop owner should not have to install anything to open a shop.
 *
 * The token this module sends is the *Platform* token — it can create and
 * destroy every database in the organisation, which makes it the most
 * dangerous secret in the deployment. It is read at call time, sent only in an
 * Authorization header, and can never reach a caller: `redact()` is the last
 * line of defence for the case where Turso quotes a request back at us, and no
 * response body is ever passed through raw.
 *
 * ── WHERE THE CREDENTIALS COME FROM ────────────────────────────────────────
 * The control plane first (`platform_settings`, written by the owner in the
 * console), then the environment (`TURSO_API_TOKEN` / `TURSO_ORG`, which keeps
 * working for anyone who set the deployment up that way). Resolved per call
 * rather than at import, because the console can connect Turso while the
 * process is running — that is the entire point of the console path, and a
 * value cached at boot would make the owner redeploy anyway.
 */
import config from '../config/index.js';
import settings from './settings.js';
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

/**
 * What this deployment will send to Turso, right now.
 *
 * Field by field, the control plane wins over the environment. A deployment
 * that has never been connected from the console reads exactly as it did
 * before this file learned about `platform_settings`; one that has been
 * connected ignores a stale variable left behind on the host, which is the
 * behaviour an owner who just pasted a token in the console expects.
 */
export async function credentials() {
  const stored = await settings.readTurso();
  return {
    apiUrl: config.turso.apiUrl,
    apiToken: stored.apiToken || config.turso.apiToken || '',
    org: stored.org || config.turso.org || '',
    group: stored.group || config.turso.group || 'default',
    // For the console, so it can say *why* automatic creation works — never
    // any part of the credential itself.
    source: stored.apiToken ? 'console' : (config.turso.apiToken ? 'environment' : null),
  };
}

/** Whether this deployment can make a database at all: a token and an org. */
export async function canProvision() {
  const { apiToken, org } = await credentials();
  return Boolean(apiToken && org);
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
function redact(text, apiToken) {
  const line = String(text || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  return apiToken ? line.replaceAll(apiToken, '***') : line;
}

function tursoError(detail, { status = 502, httpStatus = null, apiToken = '' } = {}) {
  const error = new AppError(`Turso refused: ${redact(detail, apiToken)}`, { status, code: 'TURSO_ERROR' });
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
async function reasonFor(response, name, creds) {
  const { org } = creds;
  let quoted = '';
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') quoted = body.error;
  } catch { /* not JSON: the status code is all that can honestly be reported */ }

  switch (response.status) {
    case 401:
    case 403:
      return 'the API token was rejected — it must be a Platform API token created in the Turso '
        + 'dashboard (Settings → API Tokens), not a database token. Connect Turso again from the '
        + 'console, or check TURSO_API_TOKEN on this deployment';
    case 404:
      return name
        ? `there is no database named "${name}" in organisation "${org}"`
        : `organisation "${org}" was not found — connect Turso again and choose the right organisation`;
    case 402:
      return 'the Turso account is at its plan limit — remove an unused database or upgrade the plan';
    case 429:
      return 'too many requests were sent at once — wait a moment and try again';
    default:
      return quoted ? `${quoted} (HTTP ${response.status})` : `HTTP ${response.status}`;
  }
}

/**
 * One call to the platform API with an explicit set of credentials.
 *
 * Takes the whole path, so it can serve both the organisation-scoped calls
 * (`request`, below) and `/v1/organizations`, which is the one call that is
 * made *before* an organisation is known — the verification a token has to
 * pass before it is stored.
 */
async function call(creds, path, { method = 'GET', body, name = null } = {}) {
  const { apiUrl, apiToken } = creds;
  const url = `${apiUrl}${path}`;
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
      { status: 503, apiToken },
    );
  }

  if (!response.ok) {
    throw tursoError(await reasonFor(response, name, creds), { httpStatus: response.status, apiToken });
  }
  if (method === 'DELETE') return null;
  try {
    return await response.json();
  } catch {
    throw tursoError(`the reply to ${method} ${path} was not readable JSON`, { apiToken });
  }
}

/** An organisation-scoped call, with the credentials this deployment has. */
async function request(creds, path, options = {}) {
  if (!creds.apiToken || !creds.org) {
    throw new ValidationError(
      'This deployment cannot create databases — connect Turso from the console first '
      + '(or set TURSO_API_TOKEN and TURSO_ORG on it)',
    );
  }
  return call(creds, `/v1/organizations/${encodeURIComponent(creds.org)}${path}`, options);
}

/** Every organisation slug a token can see. The verification, and the picker. */
function readOrganisations(body) {
  const rows = Array.isArray(body)
    ? body
    : (Array.isArray(body?.organizations) ? body.organizations : []);
  return rows
    .map((row) => ({
      // Turso's path segment is the slug; `name` is what a person recognises.
      // Old responses carry only one of the two, so either can stand for both.
      slug: String(row?.slug || row?.name || '').trim(),
      name: String(row?.name || row?.slug || '').trim(),
    }))
    .filter((row) => row.slug);
}

export async function listOrganizations(apiToken) {
  const creds = { apiUrl: config.turso.apiUrl, apiToken, org: '' };
  return readOrganisations(await call(creds, '/v1/organizations'));
}

export async function listDatabases(creds = null) {
  const resolved = creds || await credentials();
  const body = await request(resolved, '/databases');
  const rows = Array.isArray(body?.databases) ? body.databases : [];
  return rows.map((row) => ({ name: row.Name || row.name || '' }));
}

/**
 * Prove a token before it is stored, and work out which organisation it means.
 *
 * Verification is the whole value of connecting from the console: a token that
 * is accepted quietly and then fails an hour later, in the middle of creating a
 * shop, is worse than the environment variable it replaced. So two calls are
 * made, in this order, and both must succeed:
 *
 *   1. list the organisations this token can see — which proves the token is
 *      real, is a *platform* token, and has not been revoked;
 *   2. list the databases in the chosen organisation — which proves it can do
 *      the one thing it is being stored for, and yields the count the console
 *      shows.
 *
 * The organisation is not something a shop owner should have to know. With one
 * organisation in the list it is adopted silently; with several and no choice
 * made, the caller is handed the list it just fetched so the owner can pick
 * from what exists rather than from memory.
 *
 * Nothing is written here. Storing is the caller's job, and only ever after
 * this function has returned.
 */
export async function verifyToken({ apiToken, org = '', group = '' } = {}) {
  const token = String(apiToken || '').trim();
  if (!token) throw new ValidationError('Paste the API token first — there is nothing to check yet');

  const organisations = await listOrganizations(token);
  if (!organisations.length) {
    throw new ValidationError(
      'That token was accepted, but it cannot see any organisation. Create the token from '
      + 'app.turso.tech → Settings → API Tokens on the account that owns your databases.',
    );
  }

  const wanted = String(org || '').trim();
  let chosen;
  if (wanted) {
    chosen = organisations.find((row) => row.slug === wanted || row.name === wanted);
    if (!chosen) {
      throw new ValidationError(
        `This token cannot see an organisation called "${wanted}". It can see: `
        + `${organisations.map((row) => row.slug).join(', ')}.`,
      );
    }
  } else if (organisations.length === 1) {
    [chosen] = organisations;
  } else {
    const error = new AppError(
      'This token can see more than one organisation — choose the one your shops belong to.',
      { status: 422, code: 'TURSO_MANY_ORGS', details: { organisations } },
    );
    throw error;
  }

  const resolvedGroup = String(group || '').trim() || config.turso.group || 'default';
  // The second half of the proof: the token can actually read this
  // organisation's databases, which is the permission it is being kept for.
  const databases = await listDatabases({
    apiUrl: config.turso.apiUrl, apiToken: token, org: chosen.slug, group: resolvedGroup,
  });

  return {
    org: chosen.slug,
    orgName: chosen.name,
    group: resolvedGroup,
    organisations,
    databases: databases.length,
  };
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
  const creds = await credentials();
  const taken = (await listDatabases(creds)).some((row) => row.name === name);
  const conflict = () => new ConflictError(
    `A Turso database named "${name}" already exists — it belongs to another shop, `
    + 'and reusing it would mix two shops\' data. Choose a different shop name.',
  );
  if (taken) throw conflict();

  let body;
  try {
    body = await request(creds, '/databases', { method: 'POST', body: { name, group: creds.group }, name });
  } catch (error) {
    if (error.httpStatus === 409) throw conflict();
    throw error;
  }

  const database = body?.database || {};
  const hostname = database.Hostname || database.hostname || '';
  if (!hostname) {
    throw tursoError(`the new database "${name}" came back without an address`, { apiToken: creds.apiToken });
  }
  return { name: database.Name || database.name || name, hostname };
}

/** A database token for one database — what the tenant row stores and uses. */
export async function createDatabaseToken(name) {
  const creds = await credentials();
  const body = await request(creds, `/databases/${encodeURIComponent(name)}/auth/tokens`, { method: 'POST', name });
  const jwt = body?.jwt || '';
  if (!jwt) throw tursoError(`no auth token came back for database "${name}"`, { apiToken: creds.apiToken });
  return jwt;
}

/**
 * Destroys a database and everything in it. The only caller is the rollback in
 * `TenantService.create`, and only ever for a database that same call created
 * moments earlier — see the note there.
 */
export async function deleteDatabase(name) {
  const creds = await credentials();
  await request(creds, `/databases/${encodeURIComponent(name)}`, { method: 'DELETE', name });
}

export default {
  canProvision,
  credentials,
  databaseName,
  databaseUrl,
  listOrganizations,
  listDatabases,
  verifyToken,
  createDatabase,
  createDatabaseToken,
  deleteDatabase,
};
