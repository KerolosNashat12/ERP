/**
 * Central runtime configuration.
 * Everything is overridable through environment variables so the same build
 * can run on a shop counter PC, a back-office machine, or a LAN server.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

/**
 * Which database to talk to.
 *
 * `sqlite` (default) is a local file — the shop counter, offline, no account.
 * `libsql` is Turso, needed on serverless hosts that give a function no durable
 * disk. Setting TURSO_DATABASE_URL alone is enough to switch, because that is
 * what the Vercel marketplace integration injects and forgetting the second
 * variable would otherwise fail in a confusing way.
 */
const DB_URL = process.env.MM_DB_URL || process.env.TURSO_DATABASE_URL || '';
const DB_DRIVER = (process.env.MM_DB_DRIVER || (DB_URL ? 'libsql' : 'sqlite')).toLowerCase();
const IS_HOSTED_DB = DB_DRIVER === 'libsql';

/**
 * The control plane's own address. Set on a hosted deployment, empty on a shop
 * PC — see `config.platform` below.
 */
const PLATFORM_DB_URL = process.env.MM_PLATFORM_DB_URL || '';

/**
 * The fallback that makes switching a live deployment on a three-variable
 * change: no control-plane URL, no control-plane file named either, and a shop
 * database that is already hosted — so the register goes in beside it rather
 * than onto a disk this host does not have.
 *
 * Naming MM_PLATFORM_DB opts out: an explicit path means that file, and tests
 * depend on being able to say so.
 */
const PLATFORM_SHARES_SHOP_DB = Boolean(
  !PLATFORM_DB_URL && !process.env.MM_PLATFORM_DB && IS_HOSTED_DB,
);

/**
 * Deployment settings that belong to the repository rather than to a host.
 *
 * Vercel has no place to keep a checkbox, and asking an owner to add
 * environment variables to bring their own console up is a step that can be
 * got wrong at 1am. `platform.json`, committed next to the code, says whether
 * this deployment is a fleet and which shop owns its root address. The
 * environment still wins where it is set — MM_PLATFORM=0 is how the shop PC's
 * launcher keeps the single-shop build even though the same repo now carries
 * a fleet's settings.
 */
function readPlatformFile() {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'platform.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled === true,
      defaultTenant: typeof parsed.defaultTenant === 'string' ? parsed.defaultTenant.trim() : '',
    };
  } catch {
    // Absent, unreadable or malformed all mean the same thing: a single shop.
    return { enabled: false, defaultTenant: '' };
  }
}

const PLATFORM_FILE = readPlatformFile();

/** '1' forces the fleet on, '0' forces it off, unset defers to platform.json. */
const PLATFORM_ENABLED = process.env.MM_PLATFORM === '1'
  || (process.env.MM_PLATFORM !== '0' && PLATFORM_FILE.enabled);

const DATA_DIR = process.env.MM_DATA_DIR
  ? path.resolve(process.env.MM_DATA_DIR)
  : path.join(ROOT_DIR, 'data');

/**
 * Serverless filesystems are read-only apart from a scratch directory, so the
 * data folder is only created when a driver actually needs one. Failing to make
 * it must not stop the process either — nothing on the hosted driver reads it.
 */
function ensureDataDir() {
  if (IS_HOSTED_DB) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
}
try {
  ensureDataDir();
} catch {
  // Read-only disk: the hosted driver keeps nothing here.
}

/**
 * The JWT secret is persisted on first run so sessions survive restarts without
 * asking a shop owner to configure anything. That trick cannot work on a host
 * that runs many instances with no shared disk — each would mint its own secret
 * and sign everyone out at random — so there the variable is required.
 */
function resolveSecret() {
  if (process.env.MM_JWT_SECRET) return process.env.MM_JWT_SECRET;
  if (IS_HOSTED_DB) {
    throw new Error(
      'MM_JWT_SECRET must be set when using the hosted database driver. '
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  const secretFile = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export const config = Object.freeze({
  env: process.env.NODE_ENV || 'production',
  server: {
    port: Number(process.env.MM_PORT || 4000),
    host: process.env.MM_HOST || '127.0.0.1',
    openBrowser: process.env.MM_OPEN_BROWSER !== 'false',
  },
  database: {
    driver: IS_HOSTED_DB ? 'libsql' : 'sqlite',
    url: DB_URL,
    authToken: process.env.MM_DB_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '',
  },
  paths: {
    root: ROOT_DIR,
    data: DATA_DIR,
    backups: path.join(DATA_DIR, 'backups'),
    database: process.env.MM_DB_FILE || path.join(DATA_DIR, 'mm-accessories.db'),
    public: path.join(ROOT_DIR, 'public'),
  },
  /**
   * The multi-tenant platform, off by default. With `enabled` false, nothing
   * in `src/platform/*` is ever imported from a request path that matters —
   * the single-shop build is exactly what it was before this existed.
   *
   * The control plane has the same two homes the ERP itself has. On a shop PC
   * it is the local file at `databaseFile`. On a host with no durable disk it
   * is a libSQL database, switched on by MM_PLATFORM_DB_URL alone — one
   * variable, so there is no combination of flags that can half-switch it.
   *
   * It is kept separate from MM_DB_URL on purpose: the ERP's own default
   * database and the fleet register are different databases with different
   * schemas, and pointing both at one URL would put tenant rows inside a
   * shop's data.
   */
  platform: {
    enabled: PLATFORM_ENABLED,
    /**
     * Where the fleet register lives.
     *
     * Given its own URL, it is its own database — the right answer, and the one
     * to grow into. Given none on a host that has no disk, it falls back to the
     * shop's own hosted database rather than failing to boot: a control plane
     * that cannot start takes the whole deployment with it, and a deployment
     * that is up is worth more than a tidy one that is down. The tables are
     * distinct (`tenants`, `platform_users`, …) and no ERP query names them,
     * but they are sharing a database with a shop's data and that is worth
     * moving off later, so `shared` says so out loud.
     */
    driver: (PLATFORM_DB_URL || PLATFORM_SHARES_SHOP_DB) ? 'libsql' : 'sqlite',
    url: PLATFORM_DB_URL || (PLATFORM_SHARES_SHOP_DB ? DB_URL : ''),
    authToken: process.env.MM_PLATFORM_DB_TOKEN
      || (PLATFORM_SHARES_SHOP_DB ? (process.env.MM_DB_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '') : ''),
    shared: PLATFORM_SHARES_SHOP_DB,
    databaseFile: process.env.MM_PLATFORM_DB || path.join(DATA_DIR, 'platform.db'),
    tenantsDir: process.env.MM_TENANTS_DIR || path.join(DATA_DIR, 'tenants'),
    /**
     * The shop that answers at the root of the domain.
     *
     * A deployment that served one shop before it served a fleet has links in
     * the world already — a storefront address customers have saved, a till
     * bookmarked on a counter PC. Naming that shop here keeps `/` and `/shop`
     * working by sending them to `/t/<slug>`, so switching the platform on
     * costs nobody a dead link. Unset, `/` is the owner's console.
     */
    defaultTenant: (process.env.MM_DEFAULT_TENANT || PLATFORM_FILE.defaultTenant || '').trim(),
  },
  auth: {
    secret: resolveSecret(),
    tokenTtl: process.env.MM_TOKEN_TTL || '12h',
    cookieName: 'mm_session',
    bcryptRounds: Number(process.env.MM_BCRYPT_ROUNDS || 10),
    maxFailedAttempts: 6,
    lockMinutes: 10,
  },
  business: {
    defaultLanguage: 'en',
    currency: 'EGP',
    currencySymbolEn: 'EGP',
    currencySymbolAr: 'ج.م',
    defaultTaxRate: 14,
    lowStockCheckEnabled: true,
  },
});

export default config;
