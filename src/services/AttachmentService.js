/**
 * Photographs of paper — one mechanism, every owner.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE CONTRACT — read this, not the implementation below.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A supplier payment needs a photograph of the receipt. So does a cost (the
 * electricity bill) and a salary payment (the signed slip). They are the same
 * thing: a picture taken on a phone in a shop, stored, and shown again later.
 * This is that thing, once. Adding the second and third kind of owner requires
 * no change to this file and no new table.
 *
 * ── 1. Declare your kind of owner, in YOUR service, at module load ───────────
 *
 *     import attachmentService from './AttachmentService.js';
 *
 *     attachmentService.registerOwner('cost', {
 *       module: 'costs',                 // for the audit trail
 *       view:   'costs.view',            // who may see the picture
 *       attach: 'costs.update',          // who may add or remove one
 *       exists: async (id) => Boolean(await repositories.costs.findById(id)),
 *       label:  async (id) => `Cost ${id}`,   // what the audit entry calls it
 *     });
 *
 *   `owner_type` is that first string. It is stored on the row, so it may never
 *   be renamed once a shop has data — pick it as carefully as a column name.
 *   An unregistered owner type is refused everywhere, which is what stops a
 *   caller inventing `'users'` and serving photographs past your permissions.
 *
 * ── 2. Attach, inside the transaction that creates the owner row ─────────────
 *
 *     await attachmentService.attach('cost', cost.id, photo, context);
 *
 *   `photo` is what the browser sends: `{ dataUrl, thumbDataUrl, caption }`.
 *   Both data URLs are decoded, SNIFFED (the declared type is a claim, the
 *   bytes are the fact — a PDF renamed .jpg is refused) and size-capped. Call
 *   it inside your own `transaction()` and a photograph that will not store
 *   takes the payment down with it, rather than leaving a payment nobody can
 *   prove or a picture attached to nothing.
 *
 * ── 3. Serve it — you write no route ────────────────────────────────────────
 *
 *   The generic endpoints already exist and read your registration:
 *
 *     GET    /api/attachments/:ownerType/:ownerId      metadata only, no bytes
 *     POST   /api/attachments/:ownerType/:ownerId      add one afterwards
 *     GET    /api/attachments/:id/raw?size=thumb|full  the bytes
 *     DELETE /api/attachments/:id                      remove one
 *
 *   In a list, point every `<img>` at `?size=thumb`; open `?size=full` only
 *   when somebody actually looks. That is the whole reason two blobs are
 *   stored: ten payments cost ten thumbnails (~200 KB), not ten photographs.
 *
 * ── 4. Clean up when your owner row dies ────────────────────────────────────
 *
 *     await attachmentService.detachAll('cost', costId, context);
 *
 *   `owner_id` carries no foreign key — one table cannot point at three — so
 *   the database will not cascade for you. Deleting the owner without this
 *   leaves bytes in the shop's backup forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY IT LOOKS LIKE THIS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `ImageService` and `WebAssetService` were both read before this was written,
 * and the parts that fit are reused rather than re-invented: the bytes live in
 * the database (a serverless host has no durable disk and the shop PC must work
 * offline — so a photograph is inside the backup and travels with the data),
 * the decode/sniff/dimension logic is `shared/imageCodec.js` imported and not
 * copied, and no query ever selects a blob unless the caller asked for bytes.
 *
 * Three things are deliberately different:
 *
 *   · A product photo belongs to a product and a banner belongs to a named
 *     slot — each is one table with a real foreign key. Proof of payment
 *     belongs to whatever paid, and there are three of those coming. So this
 *     one is keyed by (owner_type, owner_id) with a registry deciding what a
 *     valid owner is, instead of a third table shaped like the first two.
 *
 *   · Two blobs, not one. A product photo is shown as a thumbnail and there is
 *     no second size to want; a receipt is scanned in a list and then READ, and
 *     the reading needs the handwriting legible. Storing the readable one and a
 *     small preview of it is what keeps a payments list off the shop's
 *     connection while still letting somebody see the amount written on the
 *     paper. Both come from the browser (`public/js/core/photo.js`); nothing
 *     re-encodes server-side, because an image library would be a native
 *     dependency and this install is "copy the folder onto a shop PC".
 *
 *   · The ceiling is higher than a product photo's 400 KB and the reason is the
 *     handwriting. A receipt downscaled to 1400 px at quality 0.82 like a
 *     product photo turns a biro-written total into grey mush. The browser
 *     sends 1600 px at 0.8 — 250 KB for a typical phone photograph — and the
 *     ceiling here is 1.5 MB, which is a backstop for callers that are not our
 *     editor rather than the plan. What a shop sees on the way in is in
 *     `public/js/core/photo.js`: the phone's 3–8 MB never reaches the network.
 */
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { decodeImageDataUrl } from '../shared/imageCodec.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import auditService from './AuditService.js';

/**
 * Decoded bytes, not encoded — the base64 in transit is about a third larger.
 *
 * FULL is what somebody reads a handwritten receipt off; THUMB is what ten of
 * them cost in a list. Both are backstops: the browser aims far below each.
 */
export const MAX_FULL_BYTES = 1_500 * 1024;
export const MAX_THUMB_BYTES = 96 * 1024;

/** Everything except the two blobs. Callers that want bytes ask for bytes. */
const META_COLUMNS = [
  'id', 'owner_type', 'owner_id', 'content_type', 'byte_size', 'thumb_byte_size',
  'width', 'height', 'caption', 'created_by', 'created_at',
].join(', ');

export class AttachmentService {
  constructor(deps = {}) {
    this.audit = deps.audit || auditService;
    /** @type {Map<string, object>} owner type -> its rules. See registerOwner. */
    this.owners = new Map();
  }

  get db() {
    return getDb();
  }

  /**
   * Declare a kind of row that can carry photographs. Called by the service
   * that owns those rows, at module load. Registering the same type twice with
   * different rules is a programming error, not a shop's problem, so it throws.
   */
  registerOwner(ownerType, rules) {
    const type = String(ownerType || '').trim();
    if (!type) throw new Error('An attachment owner type cannot be empty');
    for (const required of ['module', 'view', 'attach']) {
      if (!rules?.[required]) throw new Error(`Attachment owner "${type}" needs a ${required}`);
    }
    const existing = this.owners.get(type);
    if (existing && existing !== rules) {
      throw new Error(`Attachment owner "${type}" is already registered`);
    }
    this.owners.set(type, { exists: async () => true, label: (id) => `${type} ${id}`, ...rules });
    return this;
  }

  /**
   * The rules for a type, or a refusal. An owner type arrives from a URL, so
   * this is a trust boundary rather than a lookup: an unregistered one is not
   * a 500 and not an empty list, it is "no such thing".
   */
  owner(ownerType) {
    const rules = this.owners.get(String(ownerType || ''));
    if (!rules) throw new NotFoundError('Attachment owner type', ownerType);
    return rules;
  }

  /** Metadata for everything attached to one row, oldest first. No bytes. */
  async list(ownerType, ownerId) {
    this.owner(ownerType);
    return this.db.prepare(
      `SELECT ${META_COLUMNS} FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY id`,
    ).all(String(ownerType), Number(ownerId));
  }

  /**
   * Metadata for many owners at once, as `{ [ownerId]: [row, …] }`.
   *
   * A payments list needs the thumbnail of each of its ten payments, and asking
   * ten times is ten round trips to a database that may be on the other side of
   * the internet. Ids come from rows this process just read, never from a
   * caller, so interpolating them after `Number()` is safe and lets one
   * prepared statement serve any length.
   */
  async listMany(ownerType, ownerIds = []) {
    this.owner(ownerType);
    const ids = [...new Set(ownerIds.map(Number).filter(Number.isInteger))];
    const grouped = Object.fromEntries(ids.map((id) => [id, []]));
    if (!ids.length) return grouped;
    const rows = await this.db.prepare(`
      SELECT ${META_COLUMNS} FROM attachments
      WHERE owner_type = ? AND owner_id IN (${ids.join(',')})
      ORDER BY owner_id, id
    `).all(String(ownerType));
    for (const row of rows) grouped[row.owner_id].push(row);
    return grouped;
  }

  /** One row's metadata, with its owner type — the serving route needs both. */
  async find(id) {
    const row = await this.db.prepare(
      `SELECT ${META_COLUMNS} FROM attachments WHERE id = ?`,
    ).get(Number(id));
    if (!row) throw new NotFoundError('Attachment', id);
    return row;
  }

  /**
   * The bytes, for the serving endpoint. `size` is 'thumb' or 'full'; a row
   * whose thumbnail failed to arrive falls back to the full picture rather
   * than serving a broken image.
   */
  async bytes(id, size = 'full') {
    const row = await this.db.prepare(
      `SELECT id, data, thumb, content_type, thumb_content_type, byte_size,
              thumb_byte_size, created_at
       FROM attachments WHERE id = ?`,
    ).get(Number(id));
    if (!row) throw new NotFoundError('Attachment', id);
    if (size === 'thumb' && row.thumb && row.thumb_byte_size > 0) {
      return {
        id: `${row.id}t`,
        data: row.thumb,
        content_type: row.thumb_content_type || row.content_type,
        byte_size: row.thumb_byte_size,
        created_at: row.created_at,
      };
    }
    return {
      id: row.id,
      data: row.data,
      content_type: row.content_type,
      byte_size: row.byte_size,
      created_at: row.created_at,
    };
  }

  /**
   * Store one photograph against an owner row.
   *
   * Safe to call inside a caller's own transaction (`transaction()` nests), and
   * that is how it is meant to be used: the receipt and the payment it proves
   * are one act, and a photograph that will not store must take the payment
   * with it rather than leave a payment with no proof.
   */
  async attach(ownerType, ownerId, photo = {}, context = {}) {
    const rules = this.owner(ownerType);
    const id = Number(ownerId);

    const full = decodeImageDataUrl(photo.dataUrl, {
      maxBytes: MAX_FULL_BYTES,
      label: 'photograph',
    });
    // Optional, and never fatal on its own: an old browser that could not build
    // a preview should still be able to attach the receipt. Lists fall back to
    // the full picture for that row alone.
    const thumb = photo.thumbDataUrl
      ? decodeImageDataUrl(photo.thumbDataUrl, { maxBytes: MAX_THUMB_BYTES, label: 'preview' })
      : null;

    return transaction(async () => {
      // The owner has to exist, and it is the OWNING service that says so —
      // this file has no idea what a purchase payment is.
      if (!(await rules.exists(id))) throw new NotFoundError(String(ownerType), ownerId);

      const result = await this.db.prepare(`
        INSERT INTO attachments
          (owner_type, owner_id, data, thumb, content_type, thumb_content_type,
           byte_size, thumb_byte_size, width, height, caption, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(ownerType), id, full.data, thumb ? thumb.data : null,
        full.contentType, thumb ? thumb.contentType : null,
        full.data.length, thumb ? thumb.data.length : 0,
        full.width ?? null, full.height ?? null,
        photo.caption ? String(photo.caption).slice(0, 300) : null,
        context.actor?.id || null,
      );

      const row = await this.find(Number(result.lastInsertRowid));
      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'ATTACH',
        module: rules.module,
        entityType: 'attachment',
        entityId: row.id,
        entityLabel: await rules.label(id),
        after: row,
      });
      return row;
    });
  }

  /** Remove one photograph. The owner row is untouched. */
  async remove(id, context = {}) {
    return transaction(async () => {
      const row = await this.find(id);
      const rules = this.owner(row.owner_type);
      await this.db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'DETACH',
        module: rules.module,
        entityType: 'attachment',
        entityId: row.id,
        entityLabel: await rules.label(row.owner_id),
        before: row,
      });
      return { deleted: true };
    });
  }

  /**
   * Every photograph of one owner row, gone. For the owning service to call
   * when it deletes that row — there is no foreign key to cascade for it.
   * Returns how many were removed so the caller can audit it in one line.
   */
  async detachAll(ownerType, ownerId, context = {}) {
    const rules = this.owner(ownerType);
    const id = Number(ownerId);
    const rows = await this.list(ownerType, id);
    if (!rows.length) return { deleted: 0 };
    await this.db.prepare('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?')
      .run(String(ownerType), id);
    await this.audit.record({
      actor: context.actor,
      request: context.request,
      action: 'DETACH',
      module: rules.module,
      entityType: 'attachment',
      entityId: id,
      entityLabel: await rules.label(id),
      before: { count: rows.length, ids: rows.map((row) => row.id) },
    });
    return { deleted: rows.length };
  }
}

export const attachmentService = new AttachmentService();
export default attachmentService;
