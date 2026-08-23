/**
 * The one table that makes "save" mean one document.
 *
 * It lives here, on its own, because BOTH schemas need it verbatim: a shop's
 * database (`infrastructure/database/schema.js`) for every ERP and storefront
 * write, and the control plane (`platform/schema.js`) for the owner's console.
 * Two copies of the same DDL is exactly how they drift, so there is one.
 *
 * Why a table at all, when a Map would be faster: this deployment is
 * serverless. Each request may land on a different instance with its own
 * memory, and instances are recycled between one click and the next — the
 * lesson `api/middleware/tenant.js` records at length, learned twice. A guard
 * that only remembers what THIS instance has seen does not guard anything. The
 * database is the only thing every instance shares, so the database is where
 * the claim has to be staked.
 *
 * Columns:
 *   key         the fingerprint of one logical request — see idempotency.js.
 *   state       'in_flight' while somebody is running it, 'done' once there is
 *               a response to hand back. The two states are what makes an
 *               overlapping retry wait for the first answer instead of
 *               starting a second one.
 *   http_status / body   the response to replay, stored only for a success.
 *   expires_at  epoch milliseconds. While in flight this is a LEASE: an
 *               instance that dies mid-request must not wedge the key forever,
 *               so once the lease is up another request may take it over. Once
 *               done it is the replay window, after which the same request is
 *               a new one again.
 *
 * Epoch milliseconds rather than the ISO strings used everywhere else in this
 * schema: every read of this column is a comparison against "now", never
 * something a person reads, and an integer comparison is identical on both
 * drivers with no format to get wrong. `created_at` stays ISO for the human
 * looking at a stuck row.
 */
export const REQUEST_REPLAY_SQL = `
CREATE TABLE IF NOT EXISTS request_replay (
  key         TEXT    PRIMARY KEY,
  scope       TEXT    NOT NULL,
  state       TEXT    NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight','done')),
  http_status INTEGER,
  body        TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_replay_expires ON request_replay(expires_at);
`;

export default REQUEST_REPLAY_SQL;
