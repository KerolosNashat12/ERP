/**
 * "Which deployment am I looking at?" — answered without being asked, on all
 * three surfaces.
 *
 * ── What it draws ────────────────────────────────────────────────────────────
 * A hazard frame around the whole viewport and one small flag riding on the
 * bottom edge. Nothing else. On production and on a shop PC it draws nothing at
 * all, which is the point: the absence is the signal, so ANY frame at all means
 * "not the real one".
 *
 * ── What it costs the till ───────────────────────────────────────────────────
 * The ERP is what somebody stands at a counter using all day, so this had to be
 * free:
 *
 *   · It never moves the layout. One `position: fixed` overlay, `inset: 0`,
 *     appended to <body> — it is outside the flow entirely, so no element on
 *     any page shifts by a pixel and no scroll height changes.
 *   · It can never swallow a click. `pointer-events: none` on the overlay and
 *     everything in it, so the POS keypad under the bottom edge is exactly as
 *     clickable as it was.
 *   · It covers nothing that is used. Six pixels of the viewport's outer edge
 *     (four on a phone), which on all three surfaces is chrome padding, and an
 *     18px flag in the bottom corner — clear of the ERP's toasts, of the
 *     console's rail and sign-out button, and of the storefront's toast.
 *   · It never animates. No transition, no keyframes, nothing to composite or
 *     repaint. A flashing bar on a screen somebody looks at for eight hours is
 *     how a warning gets taped over, not how it gets read.
 *   · It costs no request. Every surface is handed `deployment` on a call it
 *     was already making before its first paint.
 *
 * ── Why it does not stop being seen after a week ─────────────────────────────
 * A badge in a corner is learned and skipped in days. Three things here are
 * deliberately not that:
 *
 *   1. It is ambient rather than local — the frame changes the shape of the
 *      whole window, so it is in peripheral vision on every screen and cannot
 *      be scrolled past or navigated away from. There is no "the part of the
 *      page where the warning lives" to stop looking at.
 *   2. It is in the browser tab. The title is prefixed, so the tab, the
 *      bookmark, the window switcher and every screenshot anybody pastes into
 *      a chat carry the word — including while the tab is in the background,
 *      where a banner cannot be seen at all.
 *   3. Production is blank. Habituation needs a signal that is always there;
 *      this one is there exactly when it is true, and the two deployments sit
 *      side by side in a browser looking nothing like each other.
 *
 * ── No imports ───────────────────────────────────────────────────────────────
 * On purpose: the three apps have three different i18n modules and three
 * different stylesheets, and this file is loaded by all of them. Every word
 * comes in as an argument from the caller's own dictionary, so the strings stay
 * where the rest of that app's strings are.
 */

const ROOT_ID = 'mm-deployment';
const STYLE_ID = 'mm-deployment-style';

/** Environments that get nothing: the real one, and a machine you stand at. */
const SILENT = new Set(['production', 'local']);

const CSS = `
#${ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  --mm-dep-w: 6px;
  --mm-dep-h: 18px;
  --mm-dep-hi: #f59e0b;
  --mm-dep-lo: #1f2937;
}
#${ROOT_ID} * { pointer-events: none; }
#${ROOT_ID} .mm-dep-e {
  position: absolute;
  background-color: var(--mm-dep-hi);
  background-image: repeating-linear-gradient(
    -45deg, var(--mm-dep-hi) 0 8px, var(--mm-dep-lo) 8px 16px);
}
/* Physical left/right for the uprights: both are painted, so there is no side
   to mirror and a logical property would only invite a bug. */
#${ROOT_ID} .mm-dep-t { inset-block-start: 0; inset-inline: 0; height: var(--mm-dep-w); }
#${ROOT_ID} .mm-dep-b { inset-block-end: 0; inset-inline: 0; height: var(--mm-dep-w); }
#${ROOT_ID} .mm-dep-l { inset-block: 0; left: 0; width: var(--mm-dep-w); }
#${ROOT_ID} .mm-dep-r { inset-block: 0; right: 0; width: var(--mm-dep-w); }
#${ROOT_ID} .mm-dep-f {
  position: absolute;
  inset-block-end: 0;
  inset-inline-end: 0;
  height: var(--mm-dep-h);
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  overflow: hidden;
  white-space: nowrap;
  background: var(--mm-dep-hi);
  color: #111827;
  font-family: inherit;
  font-size: 10px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: .1em;
  text-transform: uppercase;
  border-start-start-radius: 7px;
}
/* The storefront's flag spans the bottom edge instead of tucking into a
   corner: a customer is being told not to place an order, which is a sentence,
   not a tag. Still fixed, still outside the flow, still un-clickable. */
#${ROOT_ID}[data-wide="1"] .mm-dep-f {
  inset-inline: 0;
  border-start-start-radius: 0;
}
/* Arabic joins its letters. Tracking would pull them apart, and there is no
   upper case to ask for. */
#${ROOT_ID}[data-lang="ar"] .mm-dep-f {
  letter-spacing: normal;
  text-transform: none;
  font-size: 11px;
  font-weight: 700;
}
@media (max-width: 480px) {
  #${ROOT_ID} { --mm-dep-w: 4px; --mm-dep-h: 16px; }
  #${ROOT_ID} .mm-dep-f { font-size: 9px; padding: 0 7px; }
  #${ROOT_ID}[data-lang="ar"] .mm-dep-f { font-size: 10px; }
}
/* A fixed element is repeated on every printed page by some browsers, and a
   receipt is not where this belongs. */
@media print { #${ROOT_ID} { display: none !important; } }
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/* ------------------------------------------------------------ the tab title */

let titleTag = '';
let titleWatcher = null;

const prefixed = (value) => (titleTag && !value.startsWith(`[${titleTag}]`)
  ? `[${titleTag}] ${value}`
  : value);

/**
 * Keep the prefix through the other apps' own title writes.
 *
 * All three surfaces rename the tab after boot — the ERP from the shop's
 * settings, the storefront on every route change — so setting it once here
 * would last until the first navigation. A MutationObserver on the <title>
 * element costs nothing (a title changes a handful of times in a session) and
 * cannot be forgotten by whoever writes the next screen.
 */
function holdTitle(doc) {
  const apply = () => {
    const next = prefixed(doc.title);
    if (next !== doc.title) doc.title = next;
  };
  apply();
  if (titleWatcher || !doc.querySelector('title') || typeof MutationObserver !== 'function') return;
  titleWatcher = new MutationObserver(apply);
  titleWatcher.observe(doc.querySelector('title'), { childList: true, characterData: true, subtree: true });
}

/* ---------------------------------------------------------------- the frame */

/**
 * Draw, or remove, the deployment frame.
 *
 * @param {{environment?: string}|null|undefined} deployment
 *        Straight off `/api/session`, `/api/shop/config` or
 *        `/api/platform/auth/*`. A missing or unreadable value draws nothing —
 *        the guard in `platform/controlPlaneIdentity.js` is what actually
 *        stands between staging and production's data; this is for people.
 * @param {object} options
 * @param {string} options.label   the short word for the flag and the tab.
 * @param {string} [options.detail] a longer sentence; used instead of `label`
 *        on the flag when there is room, e.g. the storefront's warning.
 * @param {boolean} [options.wide] flag spans the bottom edge (the storefront).
 * @param {string} [options.lang]  'ar' or 'en' — decides tracking and case.
 * @param {Document} [options.doc]
 * @returns {boolean} whether a frame is now on screen.
 */
export function applyDeploymentBanner(deployment, options = {}) {
  const doc = options.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return false;

  const environment = String(deployment?.environment || '').toLowerCase();
  const existing = doc.getElementById(ROOT_ID);

  if (!environment || SILENT.has(environment)) {
    if (existing) existing.remove();
    return false;
  }

  const lang = options.lang === 'ar' ? 'ar' : 'en';
  const label = String(options.label || environment);
  const text = String(options.detail || label);

  ensureStyle(doc);
  const root = existing || doc.createElement('div');
  if (!existing) {
    root.id = ROOT_ID;
    for (const edge of ['t', 'b', 'l', 'r']) {
      const bar = doc.createElement('i');
      bar.className = `mm-dep-e mm-dep-${edge}`;
      bar.setAttribute('aria-hidden', 'true');
      root.appendChild(bar);
    }
    const flag = doc.createElement('span');
    flag.className = 'mm-dep-f';
    // Announced once by a screen reader, and never a landmark somebody has to
    // tab through — the whole overlay is inert.
    flag.setAttribute('role', 'status');
    root.appendChild(flag);
    doc.body.appendChild(root);
  }
  root.dataset.env = environment;
  root.dataset.lang = lang;
  root.dataset.wide = options.wide ? '1' : '0';
  const flag = root.querySelector('.mm-dep-f');
  if (flag.textContent !== text) flag.textContent = text;

  titleTag = label;
  holdTitle(doc);
  return true;
}

export default { applyDeploymentBanner };
