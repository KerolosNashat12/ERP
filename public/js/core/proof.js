/**
 * A photograph of paper, in the browser — the viewing half of the attachment
 * contract (see src/services/AttachmentService.js for the server's, and
 * core/photo.js for what happens to the bytes on the way in).
 *
 * This exists as a module rather than three copies because there are now three
 * things that carry a photograph — a supplier payment, a cost, a salary
 * payment — and every one of them needs the same three pieces: the URL of the
 * bytes at the right size, a way to open the readable one over the page, and a
 * picker that compresses on the phone before anything is sent. Copying that
 * into each screen is how the thumbnail in one list quietly starts fetching the
 * full photograph while the other does not.
 *
 * The size rule is the whole reason two blobs are stored, so it lives here and
 * nowhere else: a LIST points at `?size=thumb` (~20 KB), and `?size=full` is
 * fetched only when a person actually opens one.
 */
import { h, mount, modal, toast } from './ui.js';
import { t } from './i18n.js';
import { fileSize, dateTime } from './format.js';
import { apiBase } from './api.js';
import { preparePhoto, dataUrlBytes } from './photo.js';

/** The URL of one attachment's bytes. `thumb` in lists, `full` when opened. */
export const proofUrl = (attachmentId, size) =>
  `${apiBase()}/api/attachments/${attachmentId}/raw?size=${size}`;

/** The readable photograph, opened over the page so a bill can be read. */
export function openProof(attachment, caption) {
  return modal({
    title: caption || t('proofOfPayment'),
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('img', { class: 'proof-full', src: proofUrl(attachment.id, 'full'), alt: caption || t('proofOfPayment') }),
      h('div', { class: 'muted small' },
        [fileSize(attachment.byte_size),
          attachment.width ? `${attachment.width}×${attachment.height}` : null,
          dateTime(attachment.created_at)].filter(Boolean).join(' · '))),
  });
}

/**
 * The thumbnails on one row, each opening its readable original.
 * Returns an em dash when there is nothing attached, so a table cell that has
 * no picture still looks like a cell.
 */
export function proofThumbs(attachments = [], caption = '') {
  if (!attachments.length) return h('span', { class: 'muted' }, '—');
  return h('div', { class: 'row-actions' }, attachments.map((attachment) => h('img', {
    class: 'proof-thumb',
    loading: 'lazy',
    // The preview, never the readable photograph. See AttachmentService.
    src: proofUrl(attachment.id, 'thumb'),
    alt: caption || t('proofOfPayment'),
    title: t('openFullSize'),
    onclick: () => openProof(attachment, caption),
  })));
}

/**
 * The picker.
 *
 * Everything expensive happens here, on the phone, before anything is sent:
 * `preparePhoto` bakes in the rotation the camera recorded in EXIF, scales to
 * something readable and re-encodes, so what crosses the shop's mobile
 * connection is a quarter of a megabyte instead of eight. The person sees the
 * picture they chose and what it now weighs, which is the honest answer to "did
 * that work?" — and if the original was too big to open at all, they get a
 * sentence with both numbers in it.
 *
 * `label` and `hint` are passed in because the same control photographs a
 * supplier's receipt on one screen and an electricity bill on the next.
 */
export function proofPicker({ hint = null, alt = null, multiple = false, onExtra = null } = {}) {
  let photo = null;
  let busy = false;

  const preview = h('div', { class: 'proof-picker' });
  const input = h('input', {
    type: 'file',
    accept: 'image/*',
    /*
     * NO `capture` ATTRIBUTE. It used to say `capture: 'environment'`, on the
     * reasoning that somebody adding a bill is standing in front of it.
     *
     * That reasoning was wrong about how this shop actually works, and the
     * attribute does not do what it sounds like. On iOS, `capture` does not
     * "offer the camera first" — it REMOVES every other option: the sheet with
     * Photo Library on it never appears and the camera opens straight away. A
     * shop owner who photographed a supplier's invoice this morning, or was
     * sent one on WhatsApp, had no way to attach it at all. He reported it in
     * those words: «انا محتاج هنا اضيف صور من الجاليري عادي مش لازم افتح واصور
     * دلوقتي».
     *
     * Without it, iOS shows the normal sheet — Photo Library, Take Photo,
     * Choose File — so taking one NOW still costs one extra tap and picking an
     * old one becomes possible at all. Strictly more, never less.
     */
    ...(multiple ? { multiple: true } : {}),
    style: { display: 'none' },
    onchange: async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (!files.length) return;
      busy = true;
      render();
      try {
        photo = await preparePhoto(files[0]);
        /*
         * Anything past the first is handed back to whoever owns the list.
         * A paper invoice is several pages and they are all in the gallery
         * together — picking them one at a time, through a sheet each time, is
         * the work this is meant to remove. A picker with nowhere to put the
         * extras keeps the first and says so rather than dropping them
         * silently.
         */
        if (files.length > 1) {
          if (onExtra) await onExtra(files.slice(1));
          else toast(t('onePhotoOnlyHere'), 'warn', 5000);
        }
      } catch (error) {
        photo = null;
        toast(error.message, 'error', 6000);
      } finally {
        busy = false;
        render();
      }
    },
  });

  function render() {
    mount(preview,
      photo ? h('img', { src: photo.thumbDataUrl || photo.dataUrl, alt: alt || t('proofOfPayment') }) : null,
      h('button', {
        class: 'btn sm', type: 'button', onclick: () => input.click(),
      }, photo ? t('retakePhoto') : `📷 ${t('addPhoto')}`),
      photo ? h('button', {
        class: 'btn sm ghost', type: 'button', onclick: () => { photo = null; render(); },
      }, t('removePhoto')) : null,
      h('span', { class: 'muted small' },
        busy
          ? t('preparingPhoto')
          : (photo
            ? t('photoReady').replace('{size}', fileSize(dataUrlBytes(photo.dataUrl)))
            : (hint || t('proofHint')))));
  }

  render();
  return {
    node: h('div', { class: 'stack' }, input, preview),
    value: () => photo,
    isBusy: () => busy,
    clear: () => { photo = null; render(); },
    /**
     * Fill this picker from a File the person already chose elsewhere — how a
     * multi-page list turns one gallery selection into several pages. The
     * preparation is the same code path as a hand-picked file, so a photo that
     * arrived this way is resized, rotated and weighed exactly like any other.
     */
    accept: async (file) => {
      busy = true;
      render();
      try {
        photo = await preparePhoto(file);
      } catch (error) {
        photo = null;
        toast(error.message, 'error', 6000);
      } finally {
        busy = false;
        render();
      }
    },
  };
}

export default { proofUrl, openProof, proofThumbs, proofPicker };
