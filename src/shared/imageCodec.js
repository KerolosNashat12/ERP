/**
 * Shared image-bytes handling: decoding a browser-sent data URL, sniffing the
 * real content type from the bytes (never trusting what the data URL claims),
 * and reading pixel dimensions straight out of the file header.
 *
 * Used by everything that stores a photo as a BLOB — product photos and the
 * website banner alike — so this parsing logic exists in exactly one place
 * rather than being copied with the size limit hard-coded differently in each.
 */
import { ValidationError } from './errors.js';

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const DATA_URL = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?;base64,([a-z0-9+/=\s]+)$/i;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes actually are, regardless of what the data URL claimed.
 * A declared content type is a request, not a fact, and it ends up in a
 * `Content-Type` header served to the public — so it is taken from the file.
 */
export function sniffImageType(bytes) {
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
export function readImageDimensions(bytes, type) {
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

/**
 * `data:image/jpeg;base64,…` -> Buffer, or an error a shop user can act on.
 *
 * `maxBytes` and `label` are the caller's own: a product photo and the site
 * banner are shown at different sizes on the page and so allow different
 * ceilings, and the message should say which one it is complaining about.
 */
export function decodeImageDataUrl(dataUrl, { maxBytes, label = 'photo' } = {}) {
  const match = DATA_URL.exec(String(dataUrl || '').trim());
  if (!match) throw new ValidationError(`A ${label} must be sent as a base64 data URL`);

  const declared = (match[1] || '').toLowerCase();
  if (declared && !ALLOWED_IMAGE_TYPES.has(declared)) {
    throw new ValidationError('Only JPEG, PNG and WebP photos can be uploaded');
  }

  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!data.length) throw new ValidationError(`The ${label} is empty`);

  const contentType = sniffImageType(data);
  if (!contentType) throw new ValidationError('Only JPEG, PNG and WebP photos can be uploaded');

  if (maxBytes && data.length > maxBytes) {
    throw new ValidationError(
      `The ${label} is ${Math.round(data.length / 1024)} KB — the limit is ${Math.round(maxBytes / 1024)} KB`,
    );
  }

  return { data, contentType, ...readImageDimensions(data, contentType) };
}
