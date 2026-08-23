/**
 * A phone photograph, made small enough to send — the browser half of the
 * attachment contract (see src/services/AttachmentService.js for the other).
 *
 * The shop is on Egyptian mobile data and the phone in the shop takes 3–8 MB
 * pictures. Uploading one of those is thirty seconds of a person standing at a
 * counter watching a spinner, and the file then sits in the database that gets
 * backed up every night. So the bytes are dealt with HERE, before the network:
 * nothing above 25 MB is even opened, and what is sent is a re-encoded JPEG of
 * about 250 KB plus a preview of about 20 KB.
 *
 * Two sizes, deliberately:
 *
 *   readable — 1600 px on the longest edge at quality 0.8. Bigger than the
 *              1400/0.82 a product photo gets, because the thing being
 *              photographed is a receipt with a total written on it in biro,
 *              and the whole point is that somebody can read it later.
 *   preview  — 320 px at 0.72, ~20 KB, for lists. A purchase order with ten
 *              payments pulls ten of these; the readable one is fetched only
 *              when a person opens it.
 *
 * `createImageBitmap(file, { imageOrientation: 'from-image' })` is what makes a
 * photograph taken sideways come out the right way up. A phone writes the
 * rotation into EXIF and leaves the pixels alone, so a naive canvas re-encode
 * throws that tag away and the receipt is stored on its side forever. The
 * orientation is baked into the pixels here, once, which also means every
 * later viewer is right about it without having to care. Browsers without
 * `createImageBitmap` fall back to an <img>, which handles the common cases.
 */
import { t } from './i18n.js';

/** The longest edge and JPEG quality for each of the two sizes. */
const READABLE = { edge: 1600, quality: 0.8 };
const PREVIEW = { edge: 320, quality: 0.72 };

/**
 * What we refuse to even decode.
 *
 * Not the upload ceiling — the server's is 1.5 MB and nothing this produces
 * comes near it. This is the ceiling on the ORIGINAL: a 40 MP raw or a video a
 * file picker let through would be decoded into a canvas the size of the
 * device's memory, and the failure a person sees is a tab that dies rather than
 * a sentence they can act on.
 */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** Both sizes of one file, ready to post. Throws something a person can read. */
export async function preparePhoto(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error(t('photoNotAnImage'));
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(t('photoTooLarge')
      .replace('{size}', Math.round(file.size / (1024 * 1024)))
      .replace('{limit}', Math.round(MAX_SOURCE_BYTES / (1024 * 1024))));
  }

  const source = await decode(file);
  try {
    return {
      dataUrl: render(source, READABLE),
      thumbDataUrl: render(source, PREVIEW),
    };
  } finally {
    source.close?.();
  }
}

/** Roughly how many bytes a base64 data URL will weigh once decoded. */
export const dataUrlBytes = (dataUrl) => {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

/**
 * Pixels, the right way up. `createImageBitmap` decodes off the main thread and
 * is told explicitly to apply the EXIF rotation; the <img> fallback is for
 * browsers that do not have it, where the rotation is applied by the browser's
 * own default image-orientation handling.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through: some browsers reject the option rather than ignoring it.
    }
  }
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(objectUrl); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(t('photoUnreadable'))); };
    image.src = objectUrl;
  });
}

function render(source, { edge, quality }) {
  const width = source.width || source.naturalWidth || 1;
  const height = source.height || source.naturalHeight || 1;
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency: without a white ground, a PNG screenshot of a
  // bank transfer is re-encoded onto black and the black text disappears.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

export default { preparePhoto, dataUrlBytes, MAX_SOURCE_BYTES };
