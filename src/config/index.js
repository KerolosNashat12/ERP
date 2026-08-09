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

const DATA_DIR = process.env.MM_DATA_DIR
  ? path.resolve(process.env.MM_DATA_DIR)
  : path.join(ROOT_DIR, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

/**
 * The JWT secret is persisted on first run so sessions survive restarts
 * without asking a shop owner to configure anything.
 */
function resolveSecret() {
  if (process.env.MM_JWT_SECRET) return process.env.MM_JWT_SECRET;
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
  paths: {
    root: ROOT_DIR,
    data: DATA_DIR,
    backups: path.join(DATA_DIR, 'backups'),
    database: process.env.MM_DB_FILE || path.join(DATA_DIR, 'mm-accessories.db'),
    schema: path.join(ROOT_DIR, 'src', 'infrastructure', 'database', 'schema.sql'),
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
