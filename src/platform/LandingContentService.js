/**
 * Where the landing page's content and pictures live, and how they are read.
 *
 * ── Why a table of its own, and not a row in `platform_settings` ─────────────
 * `platform_settings` is a key/value table whose module header says what it is
 * for: "the handful of deployment settings an owner has to be able to change
 * from the console", and whose stated safety property is that a value can only
 * be read by a caller that names its key — because one of those values is the
 * Turso API token, "the most dangerous secret in the deployment". This document
 * is the opposite of everything in that sentence. It is not a setting, it is a
 * document; it is not small, it is up to a quarter of a megabyte of prose; and
 * it is not a secret, it is the one value here that is served to the public
 * internet with no session at all. Storing them in one table puts the bytes
 * that go on the front page one careless `SELECT *` away from the credential
 * that can delete every database in the organisation, and that adjacency buys
 * nothing.
 *
 * There are two smaller reasons on top of it. The document needs `updated_by`
 * — an audit reader wants to know who changed the price, and `platform_settings`
 * has no such column and should not grow one for a single row's sake. And the
 * assets need a table regardless: bytes are a BLOB, not a TEXT setting. So the
 * landing page brings its own two tables, `landing_content` and
 * `landing_assets`, and `platform_settings` stays what its header says it is.
 *
 * `landing_content` holds exactly one row (`CHECK (id = 1)`). The document is
 * rewritten whole on every save — the console sends the whole thing, this
 * replaces the whole thing — so a single row is not a limitation, it is the
 * shape of the data written into the schema.
 *
 * ── What is stored ───────────────────────────────────────────────────────────
 * Only what the owner has actually changed. The defaults for every field are
 * baked into `public/kj/defaults.js`, so a deployment that has never been edited —
 * or whose control plane is unreachable, or whose stored document is corrupt —
 * renders the page that ships in the repository. `mergeLandingDocument` in
 * `landingDocument.js` states how the two meet and why.
 *
 * ── Never take the page down ─────────────────────────────────────────────────
 * Every read path here answers "nothing is stored" rather than throwing: no
 * control plane (the single-shop build never opens one), no table, unreadable
 * JSON, or a document that fails validation. A malformed row is complained about
 * once and then ignored. A landing page showing last month's price is a
 * problem; a landing page that 500s is a lost customer.
 */
import crypto from 'node:crypto';
import { platformDb, platformTransaction } from './db.js';
import { decodeImageDataUrl } from '../shared/imageCodec.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import {
  DOCUMENT_VERSION, validateLandingDocument, changedSections,
} from './landingDocument.js';

/** Where a served asset URL points. One place, so nothing hand-builds it. */
const ASSET_BASE = '/api/landing/asset';

/**
 * The last complaint made about a stored document, so a page that is being
 * read a thousand times an hour writes one log line about a bad row rather
 * than a thousand identical ones. The condition still has to be visible — it
 * is also reported to the console as `malformed` on the owner's own view —
 * but a log nobody can read through is not visibility.
 */
let lastComplaint = null;

function complain(message) {
  if (lastComplaint === message) return;
  lastComplaint = message;
  console.warn(`[landing] ${message}`);
}

/**
 * The named slots, and how many bytes each may hold — decoded bytes, not the
 * base64 in transit, exactly as `WebAssetService` counts them.
 *
 * The hero is a full-bleed photograph and gets the largest ceiling; the logo is
 * usually a PNG with an alpha channel, which does not compress like a
 * photograph, so it gets a real allowance rather than a token one; a screenshot
 * override replaces one of the captures already in `public/kj/shots/` and is
 * sized to match them.
 */
const FIXED_SLOTS = {
  logo: { maxBytes: 400 * 1024, label: 'logo' },
  hero: { maxBytes: 1200 * 1024, label: 'hero image' },
};

const SHOT_SLOT = /^shot-[a-z0-9][a-z0-9-]{0,31}$/;
const SHOT_RULES = { maxBytes: 800 * 1024, label: 'screenshot' };

/** More overrides than there are captures in `public/kj/shots/`, with room. */
const MAX_SHOT_OVERRIDES = 40;

/**
 * A slot name, or null. Deliberately not an exception: a public URL asking for
 * `/api/landing/asset/../../etc/passwd` is answered with the same 404 as one
 * asking for a slot nobody has uploaded — whether a slot name is even spellable
 * is not the internet's business.
 */
export function normaliseSlot(slot) {
  const name = String(slot || '').trim().toLowerCase();
  if (FIXED_SLOTS[name]) return name;
  if (SHOT_SLOT.test(name)) return name;
  return null;
}

function rulesFor(slot) {
  if (FIXED_SLOTS[slot]) return FIXED_SLOTS[slot];
  if (SHOT_SLOT.test(slot)) return SHOT_RULES;
  throw new ValidationError(`"${slot}" is not a picture this page has a place for`);
}

/**
 * The cache key for one asset's bytes.
 *
 * This is what makes a long cache safe. The bytes behind a slot are immutable
 * until they are replaced, but the URL — unlike a product photo's — does not
 * change when they are, because the slot name IS the address. So the address
 * carries `?v=<tag>`, minted from the row's own `updated_at` and size, and the
 * document that hands the page that URL is served `no-store`. Replace the logo
 * and the next document read carries a different `?v=`, which is a different
 * URL, which no cache anywhere has an entry for: the new logo appears at once
 * while the old bytes may sit in a CDN for a year doing no harm.
 */
export function assetVersionTag(row) {
  if (!row) return null;
  return crypto.createHash('sha1')
    .update(`${row.updated_at || ''}:${row.byte_size || 0}`)
    .digest('hex')
    .slice(0, 10);
}

export const assetUrl = (slot, row) => `${ASSET_BASE}/${slot}?v=${assetVersionTag(row)}`;

const META_COLUMNS = 'id, slot, content_type, byte_size, width, height, updated_at, updated_by';

export class LandingContentService {
  /**
   * The control plane, or null when there is not one open. Never throws — a
   * single-shop build never opens one, and that means "nothing is stored",
   * which means the page's own defaults.
   */
  optionalDb() {
    try {
      return platformDb();
    } catch {
      return null;
    }
  }

  /**
   * The control plane, for a write. Throws when there is none — correctly: the
   * owner routes are only mounted where a console exists.
   */
  requireDb() {
    return platformDb();
  }

  runInTransaction(fn) {
    return platformTransaction(fn);
  }

  // ------------------------------------------------------------------ reading

  /**
   * The stored row, validated. Returns `{ document, updatedAt, updatedBy,
   * malformed }` and never throws — see the module header.
   */
  async storedDocument() {
    const db = this.optionalDb();
    if (!db) return { document: {}, updatedAt: null, updatedBy: null, malformed: false };

    let row = null;
    try {
      row = await db.prepare(
        'SELECT document, updated_at, updated_by FROM landing_content WHERE id = 1',
      ).get();
    } catch (error) {
      // A control plane that predates this feature has no such table. Same
      // answer as an empty one, and the same answer as an unreachable one.
      complain(`could not read the stored content (${error.message}) — serving the page's own defaults`);
      return { document: {}, updatedAt: null, updatedBy: null, malformed: false };
    }
    if (!row || !row.document) return { document: {}, updatedAt: null, updatedBy: null, malformed: false };

    let parsed;
    try {
      parsed = JSON.parse(row.document);
    } catch {
      complain('the stored content is not valid JSON — serving the page\'s own defaults');
      return { document: {}, updatedAt: row.updated_at, updatedBy: row.updated_by, malformed: true };
    }

    // Validated on READ as well as on write. The row could have been written by
    // a hand edit, a restored backup, or a future version of this code; none of
    // those are reasons to render something unvalidated into a public page, and
    // none of them are reasons to answer 500 either.
    const checked = validateLandingDocument(parsed);
    if (!checked.ok) {
      complain(
        `the stored content failed validation (${checked.issues.slice(0, 3).map((i) => `${i.path || 'document'}: ${i.message}`).join('; ')})`
        + ' — serving the page\'s own defaults',
      );
      return { document: {}, updatedAt: row.updated_at, updatedBy: row.updated_by, malformed: true };
    }
    return {
      document: checked.document, updatedAt: row.updated_at, updatedBy: row.updated_by, malformed: false,
    };
  }

  /** Every uploaded asset, as slot -> metadata + the URL this server mints for it. */
  async assetMap() {
    const db = this.optionalDb();
    if (!db) return {};
    let rows = [];
    try {
      rows = await db.prepare(`SELECT ${META_COLUMNS} FROM landing_assets`).all();
    } catch {
      return {};
    }
    const out = {};
    for (const row of rows) {
      if (!normaliseSlot(row.slot)) continue;
      out[row.slot] = {
        url: assetUrl(row.slot, row),
        contentType: row.content_type,
        byteSize: row.byte_size,
        width: row.width ?? null,
        height: row.height ?? null,
        updatedAt: row.updated_at,
      };
    }
    return out;
  }

  /**
   * What `GET /api/landing` answers: the stored (partial) document with the
   * asset URLs written in, for the page to merge onto its own defaults.
   *
   * The three URL fields in the contract are filled here and only here. Nothing
   * an owner typed is involved: `brand.logo`, `hero.image` and a screenshot's
   * `custom` are stripped on write and minted on read from this server's own
   * asset table, so those fields cannot hold anything but a path this server
   * produced.
   *
   * `assets` is carried alongside the document because the document cannot
   * always express an override: a screenshot the owner replaced without editing
   * the shots list has no stored item to attach a `custom` to. Both come from
   * the same read, so they cannot disagree.
   */
  async publicDocument() {
    const [{ document }, assets] = await Promise.all([this.storedDocument(), this.assetMap()]);
    const out = { ...document, version: DOCUMENT_VERSION };

    if (assets.logo) out.brand = { ...(out.brand || {}), logo: assets.logo.url };
    if (assets.hero) out.hero = { ...(out.hero || {}), image: assets.hero.url };

    if (Array.isArray(out.shots?.items)) {
      out.shots = {
        ...out.shots,
        items: out.shots.items.map((item) => {
          const asset = item?.key ? assets[`shot-${item.key}`] : null;
          return asset ? { ...item, custom: asset.url } : item;
        }),
      };
    }

    out.assets = Object.fromEntries(Object.entries(assets).map(([slot, meta]) => [slot, meta.url]));
    return out;
  }

  /**
   * What the console draws its editor from.
   *
   * `defaults` is null on purpose, and the field is here rather than absent so
   * the shape is honest about it: the defaults are baked into
   * `public/kj/defaults.js`, which is a browser module. The server has no copy to
   * hand back and must not grow one — two copies of the default copy is exactly
   * the drift this design exists to avoid. The console reads them from the same
   * module the page does, and `merge` names the rule to apply.
   */
  async ownerView() {
    const [stored, assets] = await Promise.all([this.storedDocument(), this.assetMap()]);
    return {
      document: stored.document,
      malformed: stored.malformed,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      version: DOCUMENT_VERSION,
      assets,
      // The default copy is NOT sent from here, and that is deliberate rather
      // than unfinished: it lives in `public/kj/defaults.js`, the module the
      // landing page itself renders from, and the console imports that same
      // module. A second copy on the server would be a second copy to forget
      // to update, and the failure would be silent — an editor quietly showing
      // last release's words as "the original".
      defaults: null,
      defaultsUrl: '/kj/defaults.js',
      merge: 'deep-merge objects, replace arrays and scalars',
    };
  }

  // ------------------------------------------------------------------ writing

  /**
   * Replace the whole document.
   *
   * The audit row records WHICH SECTIONS changed and how big the result is —
   * never the body. A reader of `platform_audit` wants to answer "who changed
   * the pricing, and when"; a copy of every word of the page on every save
   * answers that question worse, not better (it buries the tenant rows that
   * share the table), and quietly turns an audit log into a second, unversioned
   * store of the site's content.
   */
  async save(candidate, actor = null) {
    const checked = validateLandingDocument(candidate);
    if (!checked.ok) {
      throw new ValidationError('Please correct the highlighted fields', checked.issues);
    }

    const db = this.requireDb();
    const serialised = JSON.stringify(checked.document);
    const now = new Date().toISOString();

    await this.runInTransaction(async () => {
      const before = await this.storedDocument();
      await db.prepare(`
        INSERT INTO landing_content (id, document, version, updated_at, updated_by)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          document = excluded.document,
          version = excluded.version,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(serialised, DOCUMENT_VERSION, now, actor?.id ?? null);

      await this.recordAudit('LANDING_UPDATE', actor, {
        sections: changedSections(before.document, checked.document),
        bytes: Buffer.byteLength(serialised, 'utf8'),
        version: DOCUMENT_VERSION,
        recoveredFromMalformed: before.malformed || undefined,
      });
    });

    return this.publicDocument();
  }

  // ------------------------------------------------------------------- assets

  /** The bytes, for the serving endpoint. Null when the slot is empty. */
  async assetBytes(slot) {
    const db = this.optionalDb();
    if (!db) return null;
    try {
      return await db.prepare(
        'SELECT id, slot, data, content_type, byte_size, updated_at FROM landing_assets WHERE slot = ?',
      ).get(slot);
    } catch {
      return null;
    }
  }

  /**
   * Store or replace one slot's picture.
   *
   * The bytes are proved to be an image by `decodeImageDataUrl`, which sniffs
   * the real type out of the file's own magic number and ignores both the
   * filename and whatever the data URL claimed — the same function the shops'
   * banner and logo uploads use, not a second copy of the same idea. Nothing
   * re-encodes anything, so a PNG logo keeps its transparency.
   *
   * Replacing a slot overwrites its row: the old bytes are gone in the same
   * statement that writes the new ones. There is no orphan to collect later and
   * no second copy of a picture the owner thought he had replaced. The old
   * bytes may still sit in a CDN under the old `?v=` — harmless, because
   * nothing points at that URL any more (see `assetVersionTag`).
   */
  async setAsset(slot, dataUrl, actor = null) {
    const name = normaliseSlot(slot);
    if (!name) throw new ValidationError(`"${slot}" is not a picture this page has a place for`);
    const { maxBytes, label } = rulesFor(name);
    const { data, contentType, width = null, height = null } = decodeImageDataUrl(dataUrl, { maxBytes, label });

    const db = this.requireDb();
    const now = new Date().toISOString();

    await this.runInTransaction(async () => {
      if (SHOT_SLOT.test(name)) {
        const existing = await db.prepare('SELECT COUNT(*) AS n FROM landing_assets WHERE slot LIKE \'shot-%\' AND slot <> ?').get(name);
        if (Number(existing?.n || 0) >= MAX_SHOT_OVERRIDES) {
          throw new ValidationError(`Only ${MAX_SHOT_OVERRIDES} screenshot overrides can be stored — delete one first`);
        }
      }

      await db.prepare(`
        INSERT INTO landing_assets (slot, data, content_type, byte_size, width, height, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET
          data = excluded.data,
          content_type = excluded.content_type,
          byte_size = excluded.byte_size,
          width = excluded.width,
          height = excluded.height,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(name, data, contentType, data.length, width, height, now, actor?.id ?? null);

      await this.recordAudit('LANDING_ASSET_SET', actor, {
        slot: name, contentType, bytes: data.length, width, height,
      });
    });

    const row = await this.requireDb().prepare(`SELECT ${META_COLUMNS} FROM landing_assets WHERE slot = ?`).get(name);
    return { slot: name, url: assetUrl(name, row), contentType, byteSize: data.length, width, height };
  }

  /** Remove an override, so the built-in picture comes back. */
  async clearAsset(slot, actor = null) {
    const name = normaliseSlot(slot);
    if (!name) throw new ValidationError(`"${slot}" is not a picture this page has a place for`);
    const db = this.requireDb();

    return this.runInTransaction(async () => {
      const before = await db.prepare(`SELECT ${META_COLUMNS} FROM landing_assets WHERE slot = ?`).get(name);
      if (!before) throw new NotFoundError('Landing asset', name);
      await db.prepare('DELETE FROM landing_assets WHERE slot = ?').run(name);
      await this.recordAudit('LANDING_ASSET_CLEAR', actor, { slot: name, bytes: before.byte_size });
      return { slot: name, url: null };
    });
  }

  /**
   * One line in `platform_audit`, the same table and the same shape a tenant
   * change writes. A content change is as traceable as a suspension.
   */
  async recordAudit(action, actor, detail) {
    await this.requireDb().prepare(`
      INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run(actor?.id ?? null, action, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }
}

export const landingContentService = new LandingContentService();
export default landingContentService;
