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
