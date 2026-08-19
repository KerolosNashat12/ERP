/**
 * Named image slots for the public website — the hero banner and the shop's
 * logo today, and whatever else earns a slot later (see `web_assets` in
 * schema.js).
 *
 * Modelled closely on ImageService: the bytes live in the database rather than
 * on a disk (the shop PC has to work with the internet down, and a serverless
 * host has no durable disk at all), and the decoding/sniffing/dimension logic
 * is the exact same code — imported from shared/imageCodec.js, not copied —
 * because a banner and a product photo are the same kind of BLOB with a
 * different size ceiling.
 *
 * A slot is a row, not a table and not a second service: the logo is stored,
 * limited, audited and served by exactly the code the banner already uses.
 *
 * What differs per slot is only how big the picture is allowed to be and what
 * to call it when refusing one. The FORMAT is not a per-slot decision and must
 * not become one: `decodeImageDataUrl` sniffs the real type out of the bytes
 * and stores it, so a logo uploaded as a PNG is kept as a PNG and served with
 * `Content-Type: image/png`. Nothing here re-encodes anything, which is what
 * lets a logo keep its transparency — a logo flattened to JPEG would carry a
 * white box across every dark header on the site.
 */
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { decodeImageDataUrl } from '../shared/imageCodec.js';
import { ValidationError } from '../shared/errors.js';
import auditService from './AuditService.js';

/**
 * Decoded bytes, not encoded: the base64 in transit is about a third larger.
 *
 * The banner is shown full-bleed behind text at a much larger area of the
 * screen than a product thumbnail, so its ceiling is higher than a product
 * photo's. The logo is drawn at header size but is usually a PNG with an alpha
 * channel, which does not compress the way a photograph does — so it gets the
 * product-photo ceiling rather than a token one.
 */
const SLOTS = {
  banner: { maxBytes: 600 * 1024, label: 'banner image' },
  logo: { maxBytes: 400 * 1024, label: 'logo' },
};

/** A slot name always comes from this codebase; an unknown one is a bug, not a shop's typo. */
function rulesFor(slot) {
  const rules = SLOTS[slot];
  if (!rules) throw new ValidationError(`Unknown website image slot "${slot}"`);
  return rules;
}

/** Everything except `data`. Callers that want the bytes ask for them. */
const META_COLUMNS = 'id, content_type, byte_size, width, height, updated_at, updated_by';

export class WebAssetService {
  constructor(deps = {}) {
    this.audit = deps.audit || auditService;
  }

  get db() {
    return getDb();
  }

  /** Metadata only — the ERP settings screen never needs the bytes themselves. */
  async get(slot = 'banner') {
    const row = await this.db.prepare(
      `SELECT ${META_COLUMNS} FROM web_assets WHERE slot = ?`,
    ).get(slot);
    return this.#shape(row);
  }

  /** The bytes, for a serving endpoint — private (ERP) or public (shop), both raw. */
  async bytes(slot = 'banner') {
    return this.db.prepare(
      'SELECT id, data, content_type, byte_size, updated_at FROM web_assets WHERE slot = ?',
    ).get(slot);
  }

  /** Store or replace the image in a slot. Returns the same shape as `get()`. */
  async set(dataUrl, context = {}, slot = 'banner') {
    const { maxBytes, label } = rulesFor(slot);
    const { data, contentType, width = null, height = null } = decodeImageDataUrl(dataUrl, {
      maxBytes,
      label,
    });

    return transaction(async () => {
      const before = await this.get(slot);

      await this.db.prepare(`
        INSERT INTO web_assets (slot, data, content_type, byte_size, width, height, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(slot) DO UPDATE SET
          data = excluded.data,
          content_type = excluded.content_type,
          byte_size = excluded.byte_size,
          width = excluded.width,
          height = excluded.height,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(slot, data, contentType, data.length, width, height, context.actor?.id || null);

      const after = await this.get(slot);
      await this.audit.recordChange(context, {
        action: before.hasImage ? 'UPDATE' : 'CREATE',
        module: 'settings',
        entityType: 'web_asset',
        entityId: slot,
        entityLabel: `Website ${slot} image`,
        before,
        after,
      });
      return after;
    });
  }

  /** Remove the image from a slot; the settings the banner still shows are untouched. */
  async clear(context = {}, slot = 'banner') {
    return transaction(async () => {
      const before = await this.get(slot);
      if (!before.hasImage) return before;

      await this.db.prepare('DELETE FROM web_assets WHERE slot = ?').run(slot);

      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'DELETE',
        module: 'settings',
        entityType: 'web_asset',
        entityId: slot,
        entityLabel: `Website ${slot} image`,
        before,
        after: { hasImage: false },
      });
      return { hasImage: false };
    });
  }

  #shape(row) {
    if (!row) return { hasImage: false, contentType: null, width: null, height: null, byteSize: null, updatedAt: null };
    return {
      hasImage: true,
      contentType: row.content_type,
      width: row.width ?? null,
      height: row.height ?? null,
      byteSize: row.byte_size,
      updatedAt: row.updated_at,
    };
  }
}

export const webAssetService = new WebAssetService();
export default webAssetService;
