/**
 * The landing page, editable.
 *
 * One JSON document is the whole public page. This screen is the only place it
 * can be written, and it is written by somebody standing behind a counter on a
 * laptop, in Arabic, who has never seen the word "hero" used about a website.
 *
 * The four decisions that shape everything below:
 *
 * 1. ONE SECTION AT A TIME. Two hundred inputs on one page is "everything" and
 *    also unusable. The rail lists the sections in the order the page reads,
 *    top to bottom, and one is open at a time. The address remembers which
 *    (`#/landing?s=packages`) so a reload does not throw him back to the top.
 *
 * 2. SAVING IS THE WHOLE DOCUMENT, ONCE, AND HE PRESSES IT. The contract has
 *    exactly one write — `PUT /api/platform/landing`, the whole document,
 *    validated and audited as a unit. A per-section Save button would therefore
 *    be a lie: it would silently post every other section's unsaved edits too.
 *    So there is one save bar, it is always on screen, and it says in words
 *    whether this document is saved — a toast that has already faded is not a
 *    state.
 *
 * 3. NOTHING IS LOST BY SURPRISE. Leaving with unsaved work is intercepted
 *    three ways: the browser's own prompt on a reload or a close, a dialog on
 *    any link out of this screen, and — for everything neither of those can
 *    catch, a back button most of all — the draft is kept in this browser and
 *    offered back the next time the screen opens.
 *
 * 4. THE WARNING COMES BEFORE THE DAMAGE. Emptying a package's bullets,
 *    switching a section off, deleting the last quote: each of those is a
 *    legitimate thing to do and each quietly removes something from the live
 *    site. Every one of them says so at the moment it happens, and keeps
 *    saying so, in the section, until it is saved or undone.
 *
 * Images are the one exception to (2), and they have to be: they are their own
 * endpoints, so an upload lands immediately. The screen says so rather than
 * pretending otherwise — "Uploaded. It appears on the page once you save."
 */
import api from '../core/api.js';
import {
  h, mount, modal, toast, toastError, confirmDialog, selectInput, debounce,
} from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageHead, card, segmented } from '../ui/page.js';
import { loadInto, skCard, skBlock, skLine } from '../ui/states.js';
import { timeOfDay as fmtTime } from '../ui/format.js';
import { warnBox, announce } from '../ui/cms.js';
import { SECTIONS, namesConsole } from './landingSections.js';
import icons from '../ui/icons.js';

/** Where the public page lives, and where an unsaved draft waits. */
const PUBLIC_PAGE = '/kj';
const DRAFT_KEY = 'mm.platform.landing.draft';

const clone = (value) => (typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value)));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The document the owner edits is the stored one laid over the defaults, so a
 * field nobody has ever touched still arrives with the words the page ships
 * with — and can be edited rather than being an empty box. Arrays are replaced
 * whole: a list the owner has shortened must stay short, not be topped back up
 * from the default.
 */
function mergeDocument(base, over) {
  if (over === null || over === undefined) return clone(base);
  if (Array.isArray(base) || Array.isArray(over)) return clone(over);
  if (typeof base !== 'object' || typeof over !== 'object') return clone(over);
  const out = clone(base);
  for (const [key, value] of Object.entries(over)) {
    out[key] = key in out ? mergeDocument(out[key], value) : clone(value);
  }
  return out;
}

/** The public document carries the asset map beside it; the DOCUMENT is what
 *  gets saved, so the map never travels inside it. */
function stripEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { assets, ...rest } = value;
  return rest;
}

/**
 * The words the page ships with.
 *
 * This screen needs them for two things a CMS cannot be without: showing a
 * field nobody has edited with the text a visitor is actually reading, and
 * offering "restore the original".
 *
 * There is exactly ONE copy of that text and it is `public/kj/defaults.js` —
 * the same module the landing page itself renders from. Loaded here rather
 * than served by the API on purpose: a second copy on the server is a second
 * copy to forget to update, and the failure would be silent (an editor quietly
 * showing last release's words as "the original").
 *
 * It is imported dynamically because this console must still open on a
 * deployment where `/kj` is not mounted at all. When it cannot be reached the
 * screen still works: every field is editable, the restore buttons switch off,
 * and a banner says why rather than leaving an owner to wonder where his page
 * went.
 */
async function loadDefaults(payload) {
  if (payload?.defaults && typeof payload.defaults === 'object') return payload.defaults;
  try {
    const module = await import(payload?.defaultsUrl || '/kj/defaults.js');
    const value = module?.DEFAULTS;
    // A shape check, not a schema: if this is not recognisably the page's
    // document, an empty editor is a better answer than a wrong one.
    return (value && value.packages && value.hero && value.footer) ? value : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────── the screen

export async function landingView(root, route) {
  const host = h('div', {});
  mount(root, host);
  let teardown = () => {};

  loadInto(host, {
    skeleton: () => h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('div', { style: { flex: '1' } },
        skLine('260px', 24),
        h('span', { style: { display: 'block', height: '10px' } }),
        skLine('420px', 11))),
      skCard(skBlock(420))),
    load: async () => {
      const payload = await api.get('/landing');
      return { payload, defaults: await loadDefaults(payload) };
    },
    render: ({ payload, defaults }) => {
      const screen = buildScreen(payload, defaults, route);
      teardown = screen.teardown;
      return screen.node;
    },
  });

  // The router calls this when the screen is replaced. It is the last chance
  // to keep work the owner has not saved.
  return () => teardown();
}

function buildScreen(payload, builtIn, route) {
  const defaults = builtIn || {};
  const hasDefaults = Boolean(builtIn);
  const doc = mergeDocument(defaults, stripEnvelope(payload?.document));

  let saved = clone(doc);      // what the live page has
  let draft = clone(doc);      // what he is typing
  let lastSavedAt = payload?.updatedAt || null;
  let leaving = false;         // a leave he has already agreed to

  /**
   * Which slots hold an uploaded picture. Owned by the server, not by the
   * document — so it is read from the server's own answer and kept up to date
   * by the picture fields, never inferred from a URL in the draft.
   */
  const assets = { ...(payload?.assets || {}) };

  const known = new Set(SECTIONS.map((section) => section.key));
  let active = known.has(route?.query?.s) ? route.query.s : SECTIONS[0].key;

  const navHost = h('nav', { class: 'cms-nav', 'aria-label': t('landingSection') });
  const navSelect = selectInput({
    options: [], value: active, 'aria-label': t('landingSection'),
    onchange: (event) => open(event.target.value),
  });
  const panelHost = h('div', {});
  // The bar IS the sticky element and its parent is the whole screen. Mounting
  // a `.cms-bar` inside a plain wrapper would make that wrapper the containing
  // block — 66px tall, exactly the bar — and `position: sticky` with nowhere to
  // travel is `position: static` wearing a hat.
  const barHost = h('div', { class: 'cms-bar' });
  const draftBanner = h('div', {});

  // ── what has changed ────────────────────────────────────────────────────

  const sectionDirty = (key) => !same(draft[key], saved[key]);
  const dirtyKeys = () => SECTIONS.map((s) => s.key).filter(sectionDirty);
  const isDirty = () => dirtyKeys().length > 0;

  /** Kept in this browser, not on the server. A crash, a closed lid or a back
   *  button is not a reason to retype a page. */
  const stash = debounce(() => {
    try {
      if (isDirty()) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: draft, at: Date.now() }));
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch { /* private mode: the three guards below still hold */ }
  }, 400);

  const dropStash = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* fine */ } };

  /** Every keystroke lands here — and nothing is rebuilt. The bar, the rail's
   *  dots and the section's warnings are repainted; the fields are not, or the
   *  caret would jump on every letter. */
  function onChange() {
    renderBar();
    renderNav();
    refreshWarnings();
    stash();
  }

  // ── the rail ────────────────────────────────────────────────────────────

  function navLabel(section) {
    const off = section.toggle && draft[section.key]?.enabled === false;
    return { label: t(section.label), off, changed: sectionDirty(section.key) };
  }

  function renderNav() {
    mount(navHost, ...SECTIONS.map((section) => {
      const meta = navLabel(section);
      return h('button', {
        type: 'button',
        class: `cms-nav-item${section.key === active ? ' active' : ''}`,
        'aria-current': section.key === active ? 'true' : null,
        onclick: () => open(section.key),
      },
      h('span', { class: 'lbl' }, meta.label),
      meta.off ? h('span', { class: 'off' }, t('off')) : null,
      meta.changed ? h('span', { class: 'dot', title: t('cmsSectionChanged'), role: 'img', 'aria-label': t('cmsSectionChanged') }) : null);
    }));

    mount(navSelect, ...SECTIONS.map((section) => {
      const meta = navLabel(section);
      const marks = `${meta.off ? ` (${t('off')})` : ''}${meta.changed ? ' •' : ''}`;
      return h('option', { value: section.key }, `${meta.label}${marks}`);
    }));
    navSelect.value = active;
  }

  // ── one section ─────────────────────────────────────────────────────────

  let warnHost = h('div', {});

  /**
   * Everything this section is about to do to the live page, listed under the
   * fields that do it, recomputed on every keystroke.
   */
  function refreshWarnings() {
    const section = SECTIONS.find((s) => s.key === active);
    if (!section) return;
    const messages = [];
    if (section.toggle && draft[section.key]?.enabled === false) messages.push(t('sectionOffWarn'));
    for (const message of section.warn?.(draft) || []) if (message) messages.push(message);
    // The one thing the contract forbids outright, checked on the words he
    // actually typed rather than on the words that shipped.
    if (namesConsole(draft[section.key])) messages.push(t('kjMentionWarn'));
    mount(warnHost, ...messages.map(warnBox));
  }

  function open(key) {
    if (!known.has(key)) return;
    active = key;
    const url = `#/landing?s=${key}`;
    if (window.location.hash !== url) window.history.replaceState(null, '', url);
    renderNav();
    renderSection();
    window.scrollTo({ top: 0 });
  }

  function renderSection() {
    const section = SECTIONS.find((s) => s.key === active);
    const changed = sectionDirty(section.key);
    warnHost = h('div', { class: 'stack', style: { gap: 'var(--s2)' } });

    const actions = [];

    if (section.toggle) {
      actions.push(h('label', { class: 'switch' },
        h('input', {
          type: 'checkbox',
          checked: draft[section.key]?.enabled !== false,
          'aria-label': `${t(section.label)} — ${t('sectionShown')}`,
          onchange: (event) => {
            draft[section.key].enabled = event.target.checked;
            event.target.parentElement.querySelector('.txt').textContent = event.target.checked
              ? t('sectionShown') : t('sectionHidden');
            onChange();
          },
        }),
        h('span', { class: 'track', 'aria-hidden': 'true' }),
        h('span', { class: 'txt' }, draft[section.key]?.enabled !== false ? t('sectionShown') : t('sectionHidden'))));
    }

    if (changed) {
      actions.push(h('span', { class: 'tag warn' }, t('cmsSectionChanged')));
      actions.push(h('button', {
        class: 'btn ghost sm',
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: t('cmsRevertSectionTitle', { name: t(section.label) }),
            message: t('cmsRevertSectionBody'),
            confirmLabel: t('cmsRevertSection'),
          });
          if (!ok) return;
          draft[section.key] = clone(saved[section.key]);
          renderAll();
        },
      }, t('cmsRevertSection')));
    }

    const hasDefault = hasDefaults && section.key in defaults;
    actions.push(h('button', {
      class: 'btn sm',
      type: 'button',
      disabled: !hasDefault,
      title: hasDefault ? undefined : t('cmsNoDefaults'),
      onclick: async () => {
        const ok = await confirmDialog({
          title: t('restoreSectionTitle', { name: t(section.label) }),
          message: t('restoreSectionBody'),
          confirmLabel: t('restoreSection'),
        });
        if (!ok) return;
        draft[section.key] = clone(defaults[section.key]);
        renderAll();
        toast(t('restoreSectionDone', { name: t(section.label) }), 'warn');
      },
    }, h('span', { html: icons.refresh }), t('restoreSection')));

    const body = section.build(draft, defaults, onChange, assets);

    mount(panelHost, card({
      className: 'section-card',
      title: t(section.label),
      actions,
      body: h('div', { class: 'stack' }, warnHost, body),
    }));
    refreshWarnings();
  }

  // ── the save bar ────────────────────────────────────────────────────────

  const saveButton = h('button', { class: 'btn primary', type: 'button', onclick: () => save() });
  const discardButton = h('button', {
    class: 'btn',
    type: 'button',
    onclick: async () => {
      const ok = await confirmDialog({
        title: t('cmsDiscardTitle'), message: t('cmsDiscardBody'), confirmLabel: t('cmsDiscard'), danger: true,
      });
      if (!ok) return;
      draft = clone(saved);
      dropStash();
      renderAll();
      announce(t('cmsAllSaved'));
    },
  }, t('cmsDiscard'));

  function renderBar() {
    const n = dirtyKeys().length;
    const dirty = n > 0;
    saveButton.textContent = t('cmsSave');
    saveButton.disabled = !dirty;
    discardButton.style.display = dirty ? '' : 'none';

    const words = dirty
      ? (n === 1 ? t('cmsDirtyOne') : t('cmsDirtyMany', { n }))
      : (lastSavedAt ? t('cmsSavedAt', { time: fmtTime(lastSavedAt) }) : t('cmsNeverSaved'));

    barHost.classList.toggle('dirty', dirty);
    mount(barHost,
      h('div', { class: `cms-state ${dirty ? 'dirty' : 'saved'}`, 'aria-live': 'polite' },
        h('span', { class: 'mark', html: dirty ? icons.alert : icons.check }),
        h('b', {}, words)),
      h('span', { class: 'spacer' }),
      discardButton,
      saveButton);
  }

  /**
   * What must be true before this document is worth sending. Deliberately
   * short: the server validates, and a console that refuses to save a page
   * because a tagline is blank is a console that loses an afternoon's work.
   */
  function firstProblem() {
    const filled = (pair) => Boolean(pair?.en?.trim()) && Boolean(pair?.ar?.trim());
    if (!filled(draft.brand?.name)) return { section: 'brand', message: t('bothLanguagesNeeded') };
    if (!filled(draft.hero?.title)) return { section: 'hero', message: t('bothLanguagesNeeded') };
    for (const item of draft.packages?.items || []) {
      if (!filled(item.name)) return { section: 'packages', message: t('bothLanguagesNeeded') };
      const price = Number(item.price);
      if (item.price === null || item.price === '' || !Number.isFinite(price) || price < 0) {
        return { section: 'packages', message: t('fPriceInvalid') };
      }
    }
    return null;
  }

  async function save() {
    const problem = firstProblem();
    if (problem) {
      open(problem.section);
      // The inline marks come from the fields themselves, so they can only be
      // asked once the offending section is on screen.
      for (const field of panelHost.querySelectorAll('.bi-field')) field.validate?.();
      panelHost.querySelector('.bi-field.error input, .bi-field.error textarea')?.focus();
      toast(`${t('cmsFixFirst')} — ${problem.message}`, 'error', 5200);
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = t('cmsSaving');
    try {
      // The answer to a PUT is what `GET /api/landing` now says: the document
      // as the server validated it, with the picture URLs it mints itself. That
      // — not what was sent — is what the live page reads, so it becomes the
      // draft and the baseline both. Anything the validator normalised or
      // discarded shows up here rather than as a phantom unsaved change.
      const response = await api.put('/landing', draft);
      if (response && typeof response === 'object' && !Array.isArray(response)) {
        if (response.assets) {
          for (const key of Object.keys(assets)) delete assets[key];
          Object.assign(assets, response.assets);
        }
        draft = mergeDocument(defaults, stripEnvelope(response));
      }
      saved = clone(draft);
      lastSavedAt = new Date().toISOString();
      dropStash();
      renderAll();
      toast(t('cmsSaved'));
      announce(t('cmsSaved'));
      refreshPreview();
    } catch (error) {
      toastError(error);
      renderBar();
    }
  }

  // ── leaving ─────────────────────────────────────────────────────────────

  const onBeforeUnload = (event) => {
    if (!isDirty() || leaving) return undefined;
    // Writing the draft here too: `stash` is debounced and a closing tab does
    // not wait for a timer.
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: draft, at: Date.now() })); } catch { /* fine */ }
    event.preventDefault();
    event.returnValue = '';
    return '';
  };

  /**
   * Any link out of this screen — the rail, the console's mark, anything an
   * owner can click — stops and asks. Captured on the way down so it runs
   * before the anchor does anything, and before the router hears about it.
   */
  const onDocumentClick = (event) => {
    if (!isDirty() || leaving) return;
    const anchor = event.target.closest?.('a[href^="#/"]');
    if (!anchor) return;
    const target = anchor.getAttribute('href');
    if (target.startsWith('#/landing')) return;
    event.preventDefault();
    event.stopPropagation();
    askBeforeLeaving(() => { window.location.hash = target; });
  };

  function askBeforeLeaving(go) {
    const dialog = modal({
      title: t('cmsLeaveTitle'),
      size: 'narrow',
      body: h('p', { class: 'muted', style: { margin: 0 } }, t('cmsLeaveBody')),
      footer: [
        h('button', {
          class: 'btn danger',
          onclick: () => {
            leaving = true;
            try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: draft, at: Date.now() })); } catch { /* fine */ }
            dialog.close();
            toast(t('cmsKeptDraft'), 'warn', 6000);
            go();
          },
        }, t('cmsLeaveGo')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn primary',
          onclick: () => { dialog.close(); save(); },
        }, t('cmsLeaveStay')),
      ],
    });
  }

  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('click', onDocumentClick, true);

  const teardown = () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    document.removeEventListener('click', onDocumentClick, true);
    // Whatever route change got past the guard — a back button, most likely —
    // does not get to take the work with it.
    if (isDirty() && !leaving) {
      try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ doc: draft, at: Date.now() })); } catch { /* fine */ }
      toast(t('cmsKeptDraft'), 'warn', 6000);
    }
  };

  // ── the draft that survived last time ───────────────────────────────────

  function offerStashedDraft() {
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch { stored = null; }
    if (!stored?.doc || same(stored.doc, saved)) { mount(draftBanner); return; }

    mount(draftBanner, h('div', { class: 'otp-warn', style: { display: 'grid', gap: 'var(--s3)' } },
      h('div', {}, h('b', {}, t('cmsDraftFoundTitle')), ' — ', t('cmsDraftFoundBody')),
      h('div', { class: 'row tight' },
        h('button', {
          class: 'btn primary sm',
          type: 'button',
          onclick: () => {
            draft = mergeDocument(defaults, stored.doc);
            mount(draftBanner);
            renderAll();
            toast(t('cmsDraftRestored'), 'warn');
          },
        }, t('cmsDraftRestore')),
        h('button', {
          class: 'btn sm',
          type: 'button',
          onclick: () => { dropStash(); mount(draftBanner); },
        }, t('cmsDraftDrop')))));
  }

  // ── the live page, in a frame ───────────────────────────────────────────

  let previewFrame = null;
  const refreshPreview = () => {
    if (previewFrame?.isConnected) previewFrame.src = `${PUBLIC_PAGE}?v=${Date.now()}`;
  };

  /**
   * Honest about what it is: the PUBLISHED page in an iframe, not a rendering
   * of the draft. The console does not own the page's markup — a second, hand-
   * written copy of it here would drift from the real one within a week, and a
   * preview that lies is worse than a link.
   */
  function openPreview() {
    let width = 'desktop';
    const frameWrap = h('div', { class: 'preview-frame' });
    const build = () => {
      frameWrap.className = `preview-frame${width === 'phone' ? ' phone' : ''}`;
      previewFrame = h('iframe', {
        src: `${PUBLIC_PAGE}?v=${Date.now()}`,
        title: t('previewTitle'),
        loading: 'lazy',
      });
      mount(frameWrap, previewFrame);
    };
    build();

    modal({
      title: t('previewTitle'),
      size: 'wide',
      body: h('div', { class: 'preview-shell' },
        h('div', { class: 'row tight', style: { width: '100%' } },
          segmented([
            { value: 'desktop', label: t('previewDesktop') },
            { value: 'phone', label: t('previewPhone') },
          ], width, (value) => { width = value; build(); }),
          h('span', { class: 'spacer' }),
          h('a', {
            class: 'btn sm', href: PUBLIC_PAGE, target: '_blank', rel: 'noopener',
          }, h('span', { html: icons.external }), t('openInNewTab'))),
        h('p', { class: 'small muted', style: { margin: 0 } }, t('previewNote')),
        frameWrap),
      onClose: () => { previewFrame = null; },
    });
  }

  // ── put it together ─────────────────────────────────────────────────────

  function renderAll() {
    renderNav();
    renderSection();
    renderBar();
    stash();
  }

  const head = pageHead({
    title: t('landing'),
    subtitle: t('landingSubtitle'),
    actions: [
      h('button', { class: 'btn', type: 'button', onclick: openPreview },
        h('span', { html: icons.eye }), t('previewPage')),
      h('a', { class: 'btn', href: PUBLIC_PAGE, target: '_blank', rel: 'noopener' },
        h('span', { html: icons.external }), t('openLandingPage')),
    ],
  });

  renderAll();
  offerStashedDraft();

  /**
   * Two things the owner has to be told the moment this screen opens, because
   * neither is his doing and both change what he is looking at.
   */
  const notices = h('div', { class: 'stack', style: { gap: 'var(--s2)' } },
    payload?.malformed
      ? warnBox(`${t('cmsMalformedTitle')} — ${t('cmsMalformedBody')}`)
      : null,
    hasDefaults ? null : warnBox(t('cmsNoDefaults')));

  const node = h('div', {},
    head,
    notices,
    draftBanner,
    h('div', { class: 'cms-layout' },
      h('div', {},
        navHost,
        h('div', { class: 'cms-nav-select field' },
          h('label', { for: 'cms-section-select' }, t('landingSection')),
          navSelect)),
      panelHost),
    barHost);

  navSelect.id = 'cms-section-select';
  return { node, teardown };
}

export default landingView;
