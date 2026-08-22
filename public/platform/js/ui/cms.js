/**
 * The landing-page editor's furniture.
 *
 * Four shapes, and one rule behind all of them: the owner is editing a
 * document he cannot see while he edits it, from a laptop on a counter, in
 * whichever of two languages he happens to think in. So:
 *
 *   biField     — both languages, side by side, always. A tabbed
 *                 "English | Arabic" editor hides exactly the half you are
 *                 trying to keep in step with the other.
 *   listEditor  — add, remove and REORDER, with buttons and with Alt+Arrow.
 *                 Not drag: a drag is invisible to a keyboard, awkward under a
 *                 thumb, and impossible to undo halfway through.
 *   switchField — a real checkbox under a drawn track, so Tab reaches it and
 *                 Space toggles it.
 *   assetField  — one picture slot: what is on the page now, what it costs to
 *                 replace, and the NAME of the built-in file removing it
 *                 returns to. A refusal for an oversized file happens when the
 *                 file is chosen, not after a minute of uploading.
 *
 * Nothing in this file talks to the document. Every widget is handed the piece
 * of it that it edits and a callback to say "that changed" — which is what
 * lets one save bar speak for the whole screen.
 */
import api from '../core/api.js';
import { h, mount, confirmDialog } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { state } from './states.js';
import icons from './icons.js';

// ------------------------------------------------------------------ speech

/**
 * One polite live region for the whole screen.
 *
 * Moving a row changes nothing a screen reader would announce by itself — the
 * row moves, the focus stays on the same button, and a blind owner is left
 * guessing whether anything happened. So the move says so, in words, in his
 * own language.
 */
let liveRegion = null;
export function announce(message) {
  if (!liveRegion || !liveRegion.isConnected) {
    liveRegion = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveRegion);
  }
  // Cleared first, so the same sentence twice in a row is still announced twice.
  liveRegion.textContent = '';
  setTimeout(() => { liveRegion.textContent = message; }, 30);
}

// ------------------------------------------------------------- small parts

/** A `{ en, ar }` pair that certainly exists, whatever the document said. */
export function ensurePair(host, key) {
  const value = host[key];
  if (!value || typeof value !== 'object') host[key] = { en: '', ar: '' };
  else {
    if (typeof value.en !== 'string') value.en = '';
    if (typeof value.ar !== 'string') value.ar = '';
  }
  return host[key];
}

export const emptyPair = () => ({ en: '', ar: '' });

/** Bytes, as a person says them. Latin numerals, like the rest of the console. */
export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A warning the owner should read now, not discover on the live site. */
export const warnBox = (message) => h('div', { class: 'otp-warn' }, message);
export const noteBox = (message) => h('div', { class: 'otp-note' }, message);

// ------------------------------------------------------------- bilingual

/**
 * One `{ en, ar }` pair, as two inputs.
 *
 * Each input carries its OWN direction — the Arabic box is right-to-left even
 * when the console is in English, and the English box is left-to-right even
 * when the console is in Arabic — because the text being typed belongs to the
 * public page, not to this screen. Without it, an owner writing English in an
 * Arabic console gets his punctuation thrown to the wrong end of the line.
 */
export function biField({
  label, pair, hint, area = false, rows = 3, required = false, onChange, placeholder = {},
  hideLabel = false,
}) {
  const inputs = {};
  const errorText = h('span', { class: 'error-text', style: { display: 'none' } });

  const one = (lang) => {
    const langLabel = lang === 'en' ? t('inEnglish') : t('inArabic');
    const props = {
      class: area ? 'textarea' : 'input',
      dir: lang === 'en' ? 'ltr' : 'rtl',
      lang,
      value: pair?.[lang] ?? '',
      placeholder: placeholder[lang] || '',
      'aria-label': `${label} — ${langLabel}`,
      oninput: (event) => {
        pair[lang] = event.target.value;
        node.classList.remove('error');
        errorText.style.display = 'none';
        onChange?.();
      },
    };
    if (area) props.rows = rows;
    const input = h(area ? 'textarea' : 'input', props);
    if (area) input.value = pair?.[lang] ?? '';
    inputs[lang] = input;
    return h('div', { class: `bi-one ${lang}` },
      h('span', { class: 'bi-tag', 'aria-hidden': 'true' }, lang === 'en' ? 'EN' : 'ع'),
      input);
  };

  const node = h('div', { class: 'field bi-field' },
    // Inside a list row the row's own name is already on screen and read out
    // by the group label; a second copy above every pair is noise. The name
    // still reaches a screen reader, through each input's aria-label.
    (label && !hideLabel) ? h('label', {}, required ? `${label} *` : label) : null,
    h('div', { class: 'bi-pair' }, one('en'), one('ar')),
    hint ? h('span', { class: 'hint' }, hint) : null,
    errorText);

  /** Both halves or neither: a page that is bilingual in one field and not in
   *  the next is worse than one that is short in both. */
  node.validate = () => {
    if (!required) return true;
    const ok = Boolean(pair.en?.trim()) && Boolean(pair.ar?.trim());
    node.classList.toggle('error', !ok);
    errorText.textContent = ok ? '' : t('bothLanguagesNeeded');
    errorText.style.display = ok ? 'none' : '';
    return ok;
  };
  node.focusFirst = () => inputs.en.focus();
  return node;
}

/** A plain single-language box — a phone number, an email, a city. */
export function plainField({
  label, value, hint, onChange, type = 'text', dir = 'ltr', inputmode, placeholder,
  hideLabel = false, ariaLabel,
}) {
  const input = h('input', {
    class: 'input',
    type,
    dir,
    inputmode,
    placeholder,
    value: value ?? '',
    'aria-label': ariaLabel || ((label && hideLabel) ? label : null),
    oninput: (event) => onChange(event.target.value),
  });
  return h('div', { class: 'field' },
    (label && !hideLabel) ? h('label', {}, label) : null,
    input,
    hint ? h('span', { class: 'hint' }, hint) : null);
}

// ---------------------------------------------------------------- switches

export function switchField({
  label, checked, onChange, onText, offText,
}) {
  const input = h('input', {
    type: 'checkbox',
    checked: Boolean(checked),
    'aria-label': label,
    onchange: (event) => {
      text.textContent = event.target.checked ? (onText || t('on')) : (offText || t('off'));
      onChange(event.target.checked);
    },
  });
  const text = h('span', { class: 'txt' }, checked ? (onText || t('on')) : (offText || t('off')));
  const node = h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), text);
  node.input = input;
  /** Set it from somewhere else — turning one package's highlight on has to
   *  turn the others off, without rebuilding the row the owner is standing in
   *  and throwing his focus away with it. */
  node.set = (next) => {
    input.checked = Boolean(next);
    text.textContent = input.checked ? (onText || t('on')) : (offText || t('off'));
  };
  return node;
}

// ------------------------------------------------------------------ lists

/**
 * A list of anything: package bullets, FAQ entries, steps, quotes, trust lines.
 *
 * `items` is the live array out of the document — every operation mutates it in
 * place and then calls `onChange`, so the screen's one dirty-check sees it.
 *
 *   itemName(index)  the row's name in words, for the aria labels and the
 *                    confirmations. "Bullet 3", not "item 3".
 *   renderItem(item, index)  the row's fields.
 *   makeItem()       a new, empty item — omit to forbid adding.
 *   removable(count) false to forbid removing at this length.
 *   confirmRemove(item, index, count)  { title, message } to ask first, or
 *                    null to remove straight away. This is where "you are
 *                    about to delete the last quote, and the whole section
 *                    with it" gets said.
 */
export function listEditor({
  items, label, hint, addLabel, itemName, renderItem, makeItem,
  onChange, confirmRemove, empty, reorderable = true, removable = true, max,
}) {
  const rowsHost = h('div', { class: 'list-rows' });
  const count = h('span', { class: 'n' });

  const addButton = makeItem
    ? h('button', {
      class: 'btn sm',
      type: 'button',
      onclick: async () => {
        if (max && items.length >= max) return;
        items.push(makeItem());
        onChange?.();
        refresh({ index: items.length - 1, role: 'first' });
        announce(t('addedRow', { n: items.length }));
      },
    }, h('span', { class: 'plus' }, '+'), addLabel || t('addRow'))
    : null;

  const node = h('div', { class: 'list-editor' },
    h('div', { class: 'list-head' },
      label ? h('span', { class: 'lbl' }, label) : null,
      count,
      h('span', { class: 'spacer' }),
      addButton),
    rowsHost,
    reorderable ? h('span', { class: 'list-hint' }, hint || t('reorderHint')) : (hint ? h('span', { class: 'list-hint' }, hint) : null));

  function move(from, to) {
    if (to < 0 || to >= items.length) return;
    const [row] = items.splice(from, 1);
    items.splice(to, 0, row);
    onChange?.();
    refresh({ index: to, role: to < from ? 'up' : 'down' });
    announce(t('movedTo', { n: to + 1, total: items.length }));
  }

  async function remove(index) {
    const ask = confirmRemove
      ? confirmRemove(items[index], index, items.length)
      : { title: t('removeRowTitle'), message: t('removeRowBody') };
    if (ask) {
      const ok = await confirmDialog({
        title: ask.title, message: ask.message, confirmLabel: t('removeRow'), danger: true,
      });
      if (!ok) return;
    }
    items.splice(index, 1);
    onChange?.();
    refresh({ index: Math.min(index, items.length - 1), role: 'rm' });
    announce(t('removedRow', { n: items.length }));
  }

  /**
   * Rebuild, then put the focus back where the person left it. Without this,
   * moving a row three places with the keyboard means pressing Tab back to the
   * row three times — which is the same as not being able to reorder at all.
   */
  function refresh(focus) {
    count.textContent = t('listCount', { n: items.length });
    if (!items.length) {
      mount(rowsHost, state({
        icon: 'box',
        title: empty?.title || t('listEmptyTitle'),
        message: empty?.message,
      }));
      if (focus && addButton) addButton.focus();
      return;
    }

    mount(rowsHost, ...items.map((item, index) => {
      const name = itemName ? itemName(index, item) : `${index + 1}`;
      const tool = (role, icon, labelText, disabled, onClick, extra = '') => h('button', {
        class: `icon-btn ${role} ${extra}`.trim(),
        type: 'button',
        disabled,
        title: `${labelText} — ${name}`,
        'aria-label': `${labelText} — ${name}`,
        html: icon,
        dataset: { role, index: String(index) },
        onclick: onClick,
      });

      return h('div', {
        class: 'lrow',
        role: 'group',
        'aria-label': `${name} (${index + 1}/${items.length})`,
      },
      reorderable ? h('div', { class: 'lrow-rank', 'aria-hidden': 'true' }, String(index + 1)) : null,
      h('div', { class: 'lrow-body' }, renderItem(item, index)),
      h('div', { class: 'lrow-tools' },
        reorderable ? tool('up', icons.arrowUp, t('moveUp'), index === 0, () => move(index, index - 1)) : null,
        reorderable ? tool('down', icons.arrowUp, t('moveDown'), index === items.length - 1, () => move(index, index + 1)) : null,
        removable ? tool('rm', icons.trash, t('removeRow'), false, () => remove(index)) : null));
    }));

    if (!focus) return;
    const row = rowsHost.children[Math.max(0, Math.min(focus.index, rowsHost.children.length - 1))];
    if (!row) { addButton?.focus(); return; }
    if (focus.role === 'first') {
      (row.querySelector('input, textarea, select') || row).focus();
      return;
    }
    // A disabled arrow cannot hold focus — a row moved to the top loses its
    // "up" button, so the focus goes to the other one rather than to nowhere.
    const wanted = row.querySelector(`.icon-btn.${focus.role}:not(:disabled)`);
    const fallback = row.querySelector('.icon-btn:not(:disabled)');
    (wanted || fallback || row).focus();
  }

  /**
   * Alt + ↑ / ↓ from anywhere inside a row. Alt is not an editing chord in a
   * text box, so this never fights with typing, and it is the one gesture that
   * lets somebody reorder six bullets without leaving the field they are in.
   */
  if (reorderable) {
    rowsHost.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const row = event.target.closest('.lrow');
      if (!row) return;
      const index = [...rowsHost.children].indexOf(row);
      if (index < 0) return;
      event.preventDefault();
      const to = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= items.length) return;
      const active = event.target;
      const tag = active.tagName;
      const selector = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        ? `${tag.toLowerCase()}[aria-label="${CSS.escape(active.getAttribute('aria-label') || '')}"]`
        : null;
      move(index, to);
      // Keep the caret in the same box in the row that just moved.
      if (selector) {
        const moved = rowsHost.children[to];
        const same = moved?.querySelectorAll('input, textarea, select')[
          [...row.querySelectorAll('input, textarea, select')].indexOf(active)];
        (same || moved?.querySelector('.icon-btn:not(:disabled)'))?.focus();
      }
    });
  }

  node.refresh = refresh;
  refresh();
  return node;
}

// ----------------------------------------------------------------- assets

/**
 * What the server will actually keep. Not a guess: `decodeImageDataUrl` sniffs
 * the type out of the file's own magic number and refuses anything that is not
 * one of these three, so offering SVG in the file picker would only produce a
 * refusal after the upload.
 */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** `file` -> `data:image/png;base64,…`, byte for byte. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t('imageNotAnImage')));
    reader.readAsDataURL(file);
  });
}

/**
 * Upload one picture.
 *
 * A base64 data URL in `data`, which is the shape the owner routes accept and
 * the same one the ERP's own logo and banner uploads use. The bytes are sent
 * untouched — no canvas, no re-encode: a logo is usually a PNG with an alpha
 * channel and re-encoding one is how a shop's mark ends up in a white box.
 * The size ceiling below is the server's own, so an oversized file is refused
 * here, against the file the owner just pointed at, rather than after the
 * upload.
 */
async function uploadAsset(slot, file) {
  const data = await readAsDataUrl(file);
  return api.post(`/landing/asset/${encodeURIComponent(slot)}`, { data });
}

/**
 * One image slot.
 *
 *   slot         'logo' | 'hero' | 'shot-pos' …
 *   isSet()      does the document currently point at an uploaded picture?
 *   onSet()      / onClear()  write that back into the document
 *   defaultFile  the NAME of the built-in this returns to, so "remove" is a
 *                known destination rather than a hole
 *   defaultSrc   and its picture, so he can see it before choosing
 *   maxBytes     refused here, before a single byte is sent
 */
export function assetField({
  slot, label, hint, isSet, onSet, onClear, defaultFile, defaultSrc, maxBytes = 2 * 1024 * 1024,
}) {
  let picked = null;          // the chosen file, not yet uploaded
  let pickedUrl = null;       // its object URL, for the preview
  let uploadedThisVisit = false;
  // The slot name IS the address, so a replaced picture would come back out of
  // the browser's cache looking identical without this.
  let cacheBust = Date.now();

  const preview = h('div', { class: 'asset-preview' });
  const meta = h('div', { class: 'asset-meta' });
  const errorSlot = h('div', {});
  const actions = h('div', { class: 'asset-actions' });
  const fileInput = h('input', {
    class: 'asset-file',
    type: 'file',
    accept: ALLOWED_IMAGE_TYPES.join(','),
    id: `asset-${slot}`,
    onchange: (event) => choose(event.target.files?.[0] || null),
  });

  const showError = (message) => mount(errorSlot, message ? warnBox(message) : null);

  function releasePick() {
    if (pickedUrl) URL.revokeObjectURL(pickedUrl);
    pickedUrl = null;
    picked = null;
    fileInput.value = '';
  }

  /**
   * The refusal happens here — on a file the owner has just pointed at, with
   * its real size in the sentence — rather than after an upload that fails.
   */
  function choose(file) {
    showError(null);
    if (!file) return;
    if (!file.type.startsWith('image/') || !ALLOWED_IMAGE_TYPES.includes(file.type)) {
      releasePick();
      showError(t('imageNotAnImage'));
      return;
    }
    if (file.size > maxBytes) {
      releasePick();
      showError(t('imageTooBig', { size: fmtBytes(file.size), max: fmtBytes(maxBytes) }));
      return;
    }
    if (pickedUrl) URL.revokeObjectURL(pickedUrl);
    picked = file;
    pickedUrl = URL.createObjectURL(file);
    render();
  }

  async function doUpload() {
    if (!picked) return;
    const file = picked;
    mount(actions, h('span', { class: 'small muted' }, t('imageUploading')));
    try {
      const stored = await uploadAsset(slot, file);
      releasePick();
      uploadedThisVisit = true;
      cacheBust = Date.now();
      onSet(stored);
      render();
    } catch (error) {
      showError(error.message || t('somethingWrong'));
      render();
    }
  }

  async function doRemove() {
    const ok = await confirmDialog({
      title: t('imageRemoveTitle'),
      message: defaultFile
        ? t('imageRemoveBody', { file: defaultFile })
        : t('imageRemoveBodyNoDefault'),
      confirmLabel: t('imageRemove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/landing/asset/${encodeURIComponent(slot)}`);
      uploadedThisVisit = true;
      onClear();
      render();
    } catch (error) {
      // A slot that was already empty is the outcome the owner asked for.
      if (error.status === 404) { uploadedThisVisit = true; onClear(); render(); return; }
      showError(error.message || t('somethingWrong'));
    }
  }

  function render() {
    const set = isSet();
    // A picture that has just been replaced must not come back out of the
    // browser's cache looking unchanged.
    const src = picked
      ? pickedUrl
      : (set ? `/api/landing/asset/${encodeURIComponent(slot)}?v=${cacheBust}` : defaultSrc);

    mount(preview, src
      ? h('img', {
        src,
        alt: '',
        onerror: (event) => { event.target.replaceWith(h('span', { class: 'none' }, t('imageNone'))); },
      })
      : h('span', { class: 'none' }, t('imageNone')));

    mount(meta,
      picked
        ? h('span', {}, t('imagePicked', { name: picked.name, size: fmtBytes(picked.size) }))
        : h('span', {}, set
          ? t('imageCustomInUse')
          : (defaultFile ? t('imageDefaultInUse', { file: defaultFile }) : t('imageNone'))));

    mount(actions,
      picked
        ? [
          h('button', { class: 'btn primary sm', type: 'button', onclick: doUpload }, t('imageUpload')),
          h('button', {
            class: 'btn ghost sm',
            type: 'button',
            onclick: () => { releasePick(); render(); },
          }, t('imageCancelPick')),
        ]
        : [
          // A real button, not a <label for> dressed as one: a label needs a
          // hand-written keyboard to behave like a button, and it would also
          // become a second accessible name for the file input, which already
          // has the field's own label above it.
          h('button', {
            class: 'btn sm',
            type: 'button',
            onclick: () => fileInput.click(),
          }, h('span', { html: icons.image }), set ? t('imageReplace') : t('imageChoose')),
          set ? h('button', { class: 'btn danger sm', type: 'button', onclick: doRemove }, t('imageRemove')) : null,
        ]);

    mount(pendingSlot, uploadedThisVisit && !picked
      ? noteBox(set ? t('imageUploaded') : t('imageRemoved'))
      : null);
  }

  const pendingSlot = h('div', {});
  const node = h('div', { class: 'field' },
    label ? h('label', { for: `asset-${slot}` }, label) : null,
    h('div', { class: 'asset-field' },
      preview,
      h('div', { class: 'asset-side' },
        meta,
        actions,
        h('span', { class: 'hint' }, hint ? `${hint} ${t('imageMaxHint', { max: fmtBytes(maxBytes) })}` : t('imageMaxHint', { max: fmtBytes(maxBytes) })),
        errorSlot,
        pendingSlot)),
    fileInput);

  render();
  node.refresh = render;
  return node;
}

export default {
  announce, ensurePair, emptyPair, fmtBytes, warnBox, noteBox,
  biField, plainField, switchField, listEditor, assetField,
};
