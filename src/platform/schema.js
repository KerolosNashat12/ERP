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

-- Append-only, same convention as the ERP's own audit_logs.
CREATE TABLE IF NOT EXISTS platform_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_user_id  INTEGER REFERENCES platform_users(id),
  tenant_id         INTEGER REFERENCES tenants(id),
  action            TEXT    NOT NULL,
  detail            TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export default PLATFORM_SCHEMA_SQL;
