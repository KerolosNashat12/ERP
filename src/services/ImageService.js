/**
 * Product photos.
 *
 * The bytes live in the database, not on a disk. A serverless host gives a
 * function no durable storage, and the shop PC has to keep working with the
 * internet down — keeping the photo in SQLite means it is inside the backup, it
 * travels with the data, and it behaves identically in both places.
 *
 * The browser resizes to 1400px and re-encodes as JPEG before uploading, so
 * what arrives here is already small. The limits below are the backstop rather
 * than the plan: whoever is calling may not be our editor at all, and a 5 MB
 * phone photo must never reach the table.
 *
 * Nothing in here ships a blob unless it was explicitly asked for. `list()`
 * selects columns one by one for that reason — `SELECT *` on this table would
 * push every photo of every product through JSON on a screen that only wanted
 * thumbnails.
 */
import { getDb, transaction } from '../infrastructure/database/connection.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import auditService from './AuditService.js';

/** Decoded, not encoded: the base64 in transit is about a third larger. */
const MAX_BYTES = 400 * 1024;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Everything except `data`. Callers that want the bytes ask for them. */
const META_FIELDS = [
  'id', 'product_id', 'variant_id', 'content_type', 'byte_size', 'width', 'height',
  'alt_en', 'alt_ar', 'display_order', 'created_by', 'created_at',
];
const META_COLUMNS = META_FIELDS.join(', ');
const metaColumns = (alias) => META_FIELDS.map((column) => `${alias}.${column}`).join(', ');

const DATA_URL = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?;base64,([a-z0-9+/=\s]+)$/i;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes actually are, regardless of what the data URL claimed.
 * A declared content type is a request, not a fact, and it ends up in a
 * `Content-Type` header served to the public — so it is taken from the file.
 */
function sniffType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 12
    && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Pixel size straight out of the file header — no image library, which is a
 * hard rule here (a native dependency would break the "copy the folder onto a
 * shop PC" install). Unknown dimensions are not an error: they are metadata the
 * storefront uses to reserve space, so a header this cannot parse stores null.
 */
function readDimensions(bytes, type) {
  try {
    if (type === 'image/png') {
      // IHDR is always the first chunk: 8 magic + 4 length + 4 type.
      if (bytes.toString('latin1', 12, 16) !== 'IHDR') return {};
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }

    if (type === 'image/jpeg') {
      // Walk the segment chain to the frame header; everything before it is
      // metadata of some length that has to be skipped rather than searched.
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return {};
        const marker = bytes[offset + 1];
        // Start-of-frame, any coding: baseline, progressive, arithmetic.
        if (marker >= 0xc0 && marker <= 0xcf
          && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) offset += 2;
        else offset += 2 + bytes.readUInt16BE(offset + 2);
      }
      return {};
    }

    if (type === 'image/webp') {
      const chunk = bytes.toString('latin1', 12, 16);
      if (chunk === 'VP8 ' && bytes.length >= 30) {
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L' && bytes.length >= 25) {
        // 14 bits of width-1 then 14 bits of height-1, little-endian bitstream.
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && bytes.length >= 30) {
        return {
          width: bytes.readUIntLE(24, 3) + 1,
          height: bytes.readUIntLE(27, 3) + 1,
        };
      }
    }
  } catch {
    // A truncated header is the client's problem, not a reason to refuse the
    // upload: the bytes are still a valid picture as far as the browser knows.
  }
  return {};
}

/** `data:image/jpeg;base64,…` -> Buffer, or an error a shop user can act on. */
export function decodeDataUrl(dataUrl) {
  const match = DATA_URL.exec(String(dataUrl || '').trim());
  if (!match) throw new ValidationError('A photo must be sent as a base64 data URL');

  const declared = (match[1] || '').toLowerCase();
  if (declared && !ALLOWED_TYPES.has(declared)) {
    throw new ValidationError('Only JPEG, PNG and WebP photos can be uploaded');
  }

  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!data.length) throw new ValidationError('The photo is empty');

  const contentType = sniffType(data);
  if (!contentType) throw new ValidationError('Only JPEG, PNG and WebP photos can be uploaded');

  if (data.length > MAX_BYTES) {
    throw new ValidationError(
      `The photo is ${Math.round(data.length / 1024)} KB — the limit is ${MAX_BYTES / 1024} KB`,
    );
  }

  return { data, contentType, ...readDimensions(data, contentType) };
}

export class ImageService {
  constructor(deps = {}) {
    this.audit = deps.audit || auditService;
  }

  get db() {
    return getDb();
  }

  /**
   * Every photo of a product, in the order staff arranged them — without the
   * bytes. `variant_label` rides along so the gallery can say which colour a
   * photo belongs to without a second request.
   */
  async list(productId) {
    return this.db.prepare(`
      SELECT ${metaColumns('i')},
             v.variant_label,
             v.sku,
             CASE WHEN p.primary_image_id = i.id THEN 1 ELSE 0 END AS is_primary
      FROM product_images i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN product_variants v ON v.id = i.variant_id
      WHERE i.product_id = ?
      ORDER BY i.display_order, i.id
    `).all(Number(productId));
  }

  /**
   * Store one photo. Appended at the end of the order, and adopted as the
   * product's main picture when it has none — the first photo somebody uploads
   * is always the one they meant to represent the product.
   */
  async add(productId, { dataUrl, variantId = null, altEn = null, altAr = null } = {}, context = {}) {
    const { data, contentType, width = null, height = null } = decodeDataUrl(dataUrl);

    return transaction(async () => {
      const product = await this.#requireProduct(productId);
      const variant = await this.#resolveVariant(productId, variantId);

      const next = await this.db.prepare(
        'SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM product_images WHERE product_id = ?',
      ).get(product.id);

      const result = await this.db.prepare(`
        INSERT INTO product_images
          (product_id, variant_id, data, content_type, byte_size, width, height,
           alt_en, alt_ar, display_order, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id, variant, data, contentType, data.length, width, height,
        altEn || null, altAr || null, Number(next?.next || 0), context.actor?.id || null,
      );

      const imageId = Number(result.lastInsertRowid);
      if (!product.primary_image_id) await this.#setPrimaryColumn(product.id, imageId);

      const image = await this.#requireImage(product.id, imageId);
      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'CREATE',
        module: 'products',
        entityType: 'product_image',
        entityId: imageId,
        entityLabel: `${product.sku_prefix} — photo ${imageId}`,
        after: image,
      });
      return image;
    });
  }

  /** Change which variant a photo belongs to, or its alternative text. */
  async update(productId, imageId, { variantId, altEn, altAr } = {}, context = {}) {
    return transaction(async () => {
      const product = await this.#requireProduct(productId);
      const before = await this.#requireImage(productId, imageId);

      const sets = [];
      const params = [];
      if (variantId !== undefined) {
        sets.push('variant_id = ?');
        params.push(await this.#resolveVariant(productId, variantId));
      }
      if (altEn !== undefined) { sets.push('alt_en = ?'); params.push(altEn || null); }
      if (altAr !== undefined) { sets.push('alt_ar = ?'); params.push(altAr || null); }
      if (!sets.length) return before;

      await this.db.prepare(`UPDATE product_images SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, before.id);

      const after = await this.#requireImage(productId, imageId);
      await this.audit.recordChange(context, {
        action: 'UPDATE',
        module: 'products',
        entityType: 'product_image',
        entityId: after.id,
        entityLabel: `${product.sku_prefix} — photo ${after.id}`,
        before,
        after,
      });
      return after;
    });
  }

  /**
   * Delete a photo. There is no foreign key from `products.primary_image_id`
   * (the two tables point at each other, which cannot be expressed in a schema
   * that must create from empty), so clearing it is this method's job: promote
   * the next photo in order, or leave the product with none.
   */
  async remove(productId, imageId, context = {}) {
    return transaction(async () => {
      const product = await this.#requireProduct(productId);
      const image = await this.#requireImage(productId, imageId);

      await this.db.prepare('DELETE FROM product_images WHERE id = ?').run(image.id);

      let promoted = product.primary_image_id;
      if (product.primary_image_id === image.id) {
        const next = await this.db.prepare(
          'SELECT id FROM product_images WHERE product_id = ? ORDER BY display_order, id LIMIT 1',
        ).get(productId);
        promoted = next ? next.id : null;
        await this.#setPrimaryColumn(productId, promoted);
      }

      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'DELETE',
        module: 'products',
        entityType: 'product_image',
        entityId: image.id,
        entityLabel: `${product.sku_prefix} — photo ${image.id}`,
        before: image,
        after: { primary_image_id: promoted },
      });
      return { deleted: true, primary_image_id: promoted };
    });
  }

  /**
   * Rewrite the display order. Ids the caller left out keep their relative
   * order at the end rather than being dropped: the gallery may have been open
   * while somebody else added a photo, and losing it would be the worse answer.
   */
  async reorder(productId, orderedIds = [], context = {}) {
    return transaction(async () => {
      const product = await this.#requireProduct(productId);
      const current = await this.db.prepare(
        'SELECT id FROM product_images WHERE product_id = ? ORDER BY display_order, id',
      ).all(productId);
      const known = new Set(current.map((row) => row.id));

      const wanted = [];
      for (const raw of orderedIds) {
        const id = Number(raw);
        if (!known.has(id)) throw new ValidationError(`Photo ${raw} does not belong to this product`);
        if (!wanted.includes(id)) wanted.push(id);
      }
      for (const row of current) {
        if (!wanted.includes(row.id)) wanted.push(row.id);
      }

      const update = this.db.prepare('UPDATE product_images SET display_order = ? WHERE id = ?');
      for (const [index, id] of wanted.entries()) await update.run(index, id);

      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'REORDER',
        module: 'products',
        entityType: 'product_image',
        entityId: productId,
        entityLabel: `${product.sku_prefix} — ${wanted.length} photos`,
        before: { order: current.map((row) => row.id) },
        after: { order: wanted },
      });
      return { rows: await this.list(productId) };
    });
  }

  /** The photo that represents the product in listings and on the shop. */
  async setPrimary(productId, imageId, context = {}) {
    return transaction(async () => {
      const product = await this.#requireProduct(productId);
      const image = await this.#requireImage(productId, imageId);
      await this.#setPrimaryColumn(productId, image.id);

      await this.audit.record({
        actor: context.actor,
        request: context.request,
        action: 'SET_PRIMARY',
        module: 'products',
        entityType: 'product_image',
        entityId: image.id,
        entityLabel: `${product.sku_prefix} — photo ${image.id}`,
        before: { primary_image_id: product.primary_image_id },
        after: { primary_image_id: image.id },
      });
      return { primary_image_id: image.id };
    });
  }

  /** The bytes, for the authenticated serving endpoint. */
  async bytes(imageId) {
    return this.db.prepare(
      'SELECT id, data, content_type, byte_size, created_at FROM product_images WHERE id = ?',
    ).get(Number(imageId));
  }

  /**
   * The bytes, for the public shop.
   *
   * The publish gate is enforced in the query rather than by the caller. Image
   * ids are sequential and therefore trivially guessable, so an unpublished
   * product's photos have to be unreachable, not merely unlinked — otherwise
   * next season's range is on the internet the moment it is photographed.
   */
  async publishedBytes(imageId) {
    return this.db.prepare(`
      SELECT i.id, i.data, i.content_type, i.byte_size, i.created_at
      FROM product_images i
      JOIN products p ON p.id = i.product_id
      WHERE i.id = ? AND p.is_published = 1
    `).get(Number(imageId));
  }

  // ------------------------------------------------------------- internals

  async #requireProduct(productId) {
    const product = await this.db.prepare(
      'SELECT id, sku_prefix, name_en, primary_image_id FROM products WHERE id = ?',
    ).get(Number(productId));
    if (!product) throw new NotFoundError('Product', productId);
    return product;
  }

  /** Reads back metadata only — the blob never leaves this file by accident. */
  async #requireImage(productId, imageId) {
    const image = await this.db.prepare(
      `SELECT ${META_COLUMNS} FROM product_images WHERE id = ? AND product_id = ?`,
    ).get(Number(imageId), Number(productId));
    if (!image) throw new NotFoundError('Product photo', imageId);
    return image;
  }

  /** A photo may be pinned to one variant, but only to a variant of its own product. */
  async #resolveVariant(productId, variantId) {
    if (variantId === null || variantId === undefined || variantId === '') return null;
    const variant = await this.db.prepare(
      'SELECT id FROM product_variants WHERE id = ? AND product_id = ?',
    ).get(Number(variantId), Number(productId));
    if (!variant) throw new ValidationError('That variant belongs to a different product');
    return variant.id;
  }

  async #setPrimaryColumn(productId, imageId) {
    await this.db.prepare('UPDATE products SET primary_image_id = ? WHERE id = ?')
      .run(imageId, Number(productId));
  }
}

export const imageService = new ImageService();
export default imageService;
