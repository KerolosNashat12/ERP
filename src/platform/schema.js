/**
 * The control-plane schema — one owner account, one row per shop.
 *
 * Deliberately its own module, mirroring `infrastructure/database/schema.js`:
 * a JavaScript string so a bundler that traces `import` (not `fs.readFileSync`)
 * always ships it. Everything is `IF NOT EXISTS`, so applying it repeatedly —
 * on every start — is safe.
 *
 * This never describes a tenant's own tables. A tenant's data lives in its own
 * database, opened with `infrastructure/database/schema.js`'s SCHEMA_SQL, same
 * as the single-shop build always has. This file only describes the fleet.
 */

import { REQUEST_REPLAY_SQL } from '../shared/requestReplay.js';

export const PLATFORM_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  name_en         TEXT    NOT NULL,
  name_ar         TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Exactly one of these is filled in. 'sqlite' + db_file is a database on
  -- this machine; 'libsql' + db_url (+ db_auth_token) is a database somewhere
  -- on the internet, attached rather than created. db_auth_token is a secret:
  -- it is written here, read only to open a connection, and never returned by
  -- the API or written to an audit row.
  driver          TEXT    NOT NULL DEFAULT 'sqlite',
  db_file         TEXT,
  db_url          TEXT,
  db_auth_token   TEXT,
  website_enabled INTEGER NOT NULL DEFAULT 1,
  max_users       INTEGER NOT NULL DEFAULT 0,      -- 0 = unlimited
  max_products    INTEGER NOT NULL DEFAULT 0,      -- 0 = unlimited
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module    TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, module)
);

CREATE TABLE IF NOT EXISTS platform_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  full_name      TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at  TEXT
);

-- Settings that belong to this deployment rather than to any one shop, and
-- that an owner must be able to set from the console rather than from a host's
-- environment screen. Today that is one thing: the Turso platform credentials
-- (turso.api_token, turso.org, turso.group), so that "create a database
-- for me" can be switched on by pasting a token into the console.
--
-- turso.api_token is the most dangerous secret in the deployment — it can
-- create and destroy every database in the organisation. It is written here,
-- read only to put in an Authorization header, and never returned by an
-- endpoint, written to a log line, or recorded in a platform_audit row.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The marketing page's content, and its pictures.
--
-- Deliberately NOT a row in platform_settings. That table is documented as the
-- handful of deployment settings, and its safety property is that a value can
-- only be read by a caller naming its key — because one of those values is the
-- Turso API token. This is the opposite kind of thing: a document rather than a
-- setting, up to a quarter of a megabyte rather than a short string, and the
-- one value in this database that is served to the public internet with no
-- session. It also needs updated_by, which platform_settings has no column for.
-- See src/platform/LandingContentService.js.
--
-- Exactly one row, enforced in the schema: the document is rewritten whole on
-- every save, so "one row" is the shape of the data, not a limitation.
CREATE TABLE IF NOT EXISTS landing_content (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  document   TEXT    NOT NULL,          -- JSON; validated on write AND on read
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES platform_users(id)
);

-- One row per named picture slot: 'logo', 'hero', and 'shot-<key>' for a
-- screenshot override. Bytes in the database rather than on a disk, for the
-- same reason the shops' web_assets are: a serverless host has no durable one.
-- Replacing a slot overwrites its row, so there is never a second copy of a
-- picture the owner believes he replaced.
CREATE TABLE IF NOT EXISTS landing_assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slot         TEXT    NOT NULL UNIQUE,
  data         BLOB    NOT NULL,
  content_type TEXT    NOT NULL,        -- sniffed from the bytes, never declared
  byte_size    INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by   INTEGER REFERENCES platform_users(id)
);

-- Append-only, same convention as the ERP's own audit_logs.
CREATE TABLE IF NOT EXISTS platform_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_user_id  INTEGER REFERENCES platform_users(id),
  tenant_id         INTEGER REFERENCES tenants(id),
  action            TEXT    NOT NULL,
  detail            TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The console's half of "one save, one document". Identical table, identical
-- protocol, different database: a console request never touches a shop's, so
-- its claims cannot live in one. See shared/requestReplay.js.
${REQUEST_REPLAY_SQL}
`;

export default PLATFORM_SCHEMA_SQL;
