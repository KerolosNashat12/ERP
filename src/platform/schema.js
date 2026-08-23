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

-- ─────────────────────────────────────────────────────────── backups
--
-- One row per backup taken of one shop, and the bytes of it in chunks beside.
--
-- Why the bytes live here at all: a Vercel function has no durable disk, and
-- the alternatives all cost the owner an account he does not have — a blob
-- store, an S3 bucket, a second provider with a second bill and a second set of
-- credentials to lose. The control plane is already a database this deployment
-- owns, already backed up by its provider, and already the thing that knows
-- which shops exist. Putting a shop's backup anywhere else would mean a shop
-- could be missing its backups and the console would have no way to know.
--
-- Why chunks rather than one BLOB column: a backup is megabytes, and the hosted
-- driver moves a row over HTTP. A multi-megabyte row is one request that has to
-- succeed whole, on both the write and the read, and it has to be held whole in
-- a function's memory at both ends. Chunked, a backup is written a piece at a
-- time and streamed back a piece at a time, so the peak memory is one chunk
-- however large the shop grows.
--
-- "manifest" is small and deliberately holds NO shop data: table names, row
-- counts and the part list, which is what the console shows and what a restore
-- needs to plan. Every actual row of the shop is in the chunks.
CREATE TABLE IF NOT EXISTS tenant_backups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Denormalised on purpose: a backup names the shop it was taken from even
  -- after that shop's row is gone, which is what makes a listing readable and
  -- what a restore checks the target against.
  slug          TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'scheduled'
                        CHECK (kind IN ('scheduled', 'manual', 'pre_restore')),
  -- 'running' is a row that exists so its chunks have something to hang off.
  -- A run that dies without reaching either end state leaves one behind, which
  -- is deliberate: it is visible in the console as an unfinished backup rather
  -- than as no backup at all, and the next prune clears it.
  status        TEXT    NOT NULL DEFAULT 'ready'
                        CHECK (status IN ('running', 'ready', 'failed')),
  taken_at      TEXT    NOT NULL,
  finished_at   TEXT,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  row_count     INTEGER NOT NULL DEFAULT 0,
  table_count   INTEGER NOT NULL DEFAULT 0,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  -- Of the file the owner downloads, byte for byte. A backup whose checksum
  -- does not match what comes back out is not a backup.
  sha256        TEXT,
  manifest      TEXT,
  error         TEXT,
  created_by    INTEGER REFERENCES platform_users(id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_backups_tenant ON tenant_backups(tenant_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_backups_status ON tenant_backups(status, taken_at DESC);

CREATE TABLE IF NOT EXISTS tenant_backup_chunks (
  backup_id INTEGER NOT NULL REFERENCES tenant_backups(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  bytes     BLOB    NOT NULL,
  PRIMARY KEY (backup_id, seq)
);

-- A ticket is permission to do one thing, once, soon.
--
-- Two kinds share this table because they are the same idea with different
-- consequences. A "download" ticket exists so the bytes of a shop's entire book
-- are never behind a plain cookie GET that a link in an email could trigger. A
-- "restore" ticket exists so that overwriting a live shop takes two deliberate
-- requests with a plan shown in between, and so the thing that was approved is
-- provably the thing that runs: the ticket names the backup, and a second
-- backup cannot be swapped in behind it.
--
-- Every ticket is bound to the console user who asked for it, expires in
-- minutes, and is spent on first use.
CREATE TABLE IF NOT EXISTS backup_tickets (
  token            TEXT    PRIMARY KEY,
  purpose          TEXT    NOT NULL CHECK (purpose IN ('download', 'restore')),
  tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  backup_id        INTEGER NOT NULL REFERENCES tenant_backups(id) ON DELETE CASCADE,
  platform_user_id INTEGER REFERENCES platform_users(id),
  plan             TEXT,
  created_at       TEXT    NOT NULL,
  expires_at       TEXT    NOT NULL,
  used_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_backup_tickets_expiry ON backup_tickets(expires_at);

-- ──────────────────────────────────────────────────── the fleet, summarised
--
-- One row per shop: the figures the owner's console shows on its landing
-- screen, written by the shop's side of the platform and READ by the console.
--
-- Why this table exists: the overview used to be computed on every page load
-- by opening every shop's database — four at a time, with a deadline. At six
-- shops that is fine. At eighty it is eighty connections per page load on a
-- metered database, and a console nobody can use. A figure on that screen is
-- now read, not computed.
--
-- Why it is in the control plane and not in each shop: the whole point is that
-- the console reads ONE database. A summary living inside each shop would have
-- to be fetched from each shop, which is the problem it was meant to solve.
--
-- ── What is here and what is deliberately NOT ────────────────────────────────
-- Only statistics live here. Every DECISION on that screen — whether a shop is
-- active or suspended, whether its website is on, which modules it has, what
-- its limits are — is read live from "tenants" on the same page load, because
-- those are things the owner acts on and a stale one is a wrong answer, not an
-- old one. See platform/FleetSummaryService.js for the rule in full.
--
-- ── Two clocks ──────────────────────────────────────────────────────────────
-- "computed_at" is when figures were last read successfully; "attempted_at" is
-- when the shop was last asked, successfully or not. They differ exactly when a
-- shop's database has gone: the figures stay as the last true ones, "status"
-- goes to 'error', and the console shows both facts — last good figures, and
-- the moment the last read failed. Nulling the figures on a failed read would
-- throw away the only thing anybody could act on.
--
-- "computed_day" and "computed_month" are what make "today's takings" honest.
-- A summary computed at 23:50 holds yesterday's day-total ten minutes later, so
-- the reader compares these against the current day and month and reports
-- "unknown" rather than presenting an old day's takings as today's.
CREATE TABLE IF NOT EXISTS tenant_summaries (
  tenant_id          INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Denormalised for the same reason "tenant_backups.slug" is: the row names
  -- the shop it describes without a join, and a listing stays readable.
  slug               TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  -- Which of the three writers produced this row: the scheduled sweep, a shop's
  -- own traffic, or the owner pressing "refresh now". Shown in the console, so
  -- "why is this figure old" has an answer.
  source             TEXT    NOT NULL DEFAULT 'cron'
                             CHECK (source IN ('cron', 'request', 'console', 'backfill')),
  computed_at        TEXT,
  attempted_at       TEXT    NOT NULL,
  computed_day       TEXT,
  computed_month     TEXT,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  users              INTEGER,
  products           INTEGER,
  revenue_30d        REAL,
  orders_30d         INTEGER,
  revenue_today      REAL,
  sales_today        INTEGER,
  revenue_month      REAL,
  sales_month        INTEGER,
  web_orders_pending INTEGER,
  currency           TEXT,
  last_activity_at   TEXT,
  -- Thirty days of {date, revenue, orders} as JSON — about a kilobyte a shop,
  -- which is what lets the console draw the fleet's trend chart without opening
  -- a single shop. Summed onto the CURRENT axis when read, so a shop whose
  -- summary is days old contributes the days it actually has.
  trend              TEXT,
  -- A fixed sentence, never a driver's message: a driver quotes the database
  -- URL back, and a URL is half of a credential. Same rule as FleetService.
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenant_summaries_attempted ON tenant_summaries(attempted_at);

-- ───────────────────────────────────────────── which deployment owns this
--
-- One row. The database's own answer to "which environment am I?".
--
-- Why it has to be here rather than in an environment variable: the realistic
-- accident is not a bad deploy, it is a staging deployment pointed at
-- PRODUCTION's control plane — one variable copied from the wrong project, and
-- a test run writes to real shops. No amount of checking environment variables
-- can catch that, because the variables are the thing that is wrong. The
-- control-plane database, though, is a durable place that this deployment did
-- not choose the contents of, and it can be made to say what it is. A
-- deployment claiming to be one thing while the database it just opened says
-- another is then a fact the process can check about itself, at boot, before it
-- serves anything.
--
-- Written once, by the first deployment that DECLARES an environment (a default
-- or a guess may not brand a database — see config/deployment.js). Changed only
-- by a deliberate re-purpose, which is a legitimate thing to do: a real staging
-- control plane is usually made by copying production's, and it arrives wearing
-- production's stamp. MM_CONTROL_PLANE_REPURPOSE is how somebody says so out
-- loud, and the change is recorded in platform_audit.
--
-- "id = 1" in the schema: there is exactly one answer to this question, and the
-- shape of the table says so rather than a comment asking nicely.
CREATE TABLE IF NOT EXISTS control_plane_identity (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  environment  TEXT    NOT NULL CHECK (environment IN ('production', 'staging', 'local')),
  stamped_at   TEXT    NOT NULL,
  -- 'first-run' | 'adopted' | 'repurposed' — why this row says what it says,
  -- so a mismatch three months from now has a history rather than a value.
  stamped_by   TEXT,
  note         TEXT
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
