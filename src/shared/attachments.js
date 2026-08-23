/**
 * The attachments table, defined once.
 *
 * Lives in `shared/` rather than only in `schema.js` for the same reason
 * `requestReplay.js` does: `schema.js` is the shape a NEW database is created
 * with, and a migration has to carry an EXISTING one to it. Both import this
 * string, so the two can never drift apart by a column.
 *
 * See `services/AttachmentService.js` for what the columns mean and for the
 * contract another feature attaches its own photographs through.
 *
 * There is deliberately no foreign key on `owner_id`: one table serves every
 * kind of owner (a supplier payment today, a cost and a salary payment next),
 * and SQLite cannot point one column at three tables. What replaces the
 * database's cascade is `AttachmentService.detachAll()`, which the owning
 * service calls when it deletes an owner row.
 */
export const ATTACHMENTS_SQL = `
CREATE TABLE IF NOT EXISTS attachments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type         TEXT    NOT NULL,          -- 'purchase_payment', 'cost', …
  owner_id           INTEGER NOT NULL,
  data               BLOB    NOT NULL,          -- the readable photograph
  thumb              BLOB,                      -- ~20 KB preview for lists
  content_type       TEXT    NOT NULL,          -- sniffed from the bytes, never declared
  thumb_content_type TEXT,
  byte_size          INTEGER NOT NULL DEFAULT 0,
  thumb_byte_size    INTEGER NOT NULL DEFAULT 0,
  width              INTEGER,
  height             INTEGER,
  caption            TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_type, owner_id, id)
`;

export default ATTACHMENTS_SQL;
