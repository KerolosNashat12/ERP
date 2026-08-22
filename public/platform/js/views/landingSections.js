/**
 * The landing page, section by section.
 *
 * One entry per section of the contract document, in the order the page itself
 * reads — top of the page first, footer last — because the owner navigates
 * this screen by remembering what he saw when he scrolled the real thing, not
 * by remembering a field name.
 *
 * Every entry is the same four things:
 *
 *   label / sub  what it is called and what it is for, in both languages
 *   toggle       the name of its on/off flag, when it has one. A section with
 *                no flag (the packages, the hero) is one the page cannot be
 *                without.
 *   build        its fields
 *   warn         what is about to happen to the live page if it is saved as
 *                it stands — an empty list, a section switched off, a package
 *                with no bullets. Said here, now, rather than discovered on
 *                the site afterwards.
 *
 * `build(doc, defaults, onChange)` mutates `doc` in place and calls `onChange`
 * on every keystroke. It never saves anything: one save bar speaks for the
 * whole screen.
 */
import { h, selectInput } from '../core/dom.js';
import { t, getLanguage } from '../core/i18n.js';
import {
  biField, plainField, switchField, listEditor, assetField, ensurePair, emptyPair,
} from '../ui/cms.js';

const stack = (...children) => h('div', { class: 'stack' }, children.flat().filter(Boolean));
const sub = (text) => h('p', { class: 'cms-sub' }, text);

/** An array that certainly exists and certainly is an array. */
function list(host, key) {
  if (!Array.isArray(host[key])) host[key] = [];
  return host[key];
}

/**
 * A list whose every entry is nothing but a `{ en, ar }` pair — the hero's
 * three reassurances, the two audience lists, the "in every package" strip and
 * a package's own bullets are all this shape.
 */
function pairList({
  items, label, addLabel, itemName, onChange, area = false, confirmRemove, empty, hint,
}) {
  return listEditor({
    items,
    label,
    hint,
    addLabel: addLabel || t('addRow'),
    itemName,
    onChange,
    confirmRemove,
    empty,
    makeItem: emptyPair,
    renderItem: (item, index) => biField({
      label: itemName(index), hideLabel: true, pair: item, area, rows: 2, onChange,
    }),
  });
}

/** Does anything under this node name the console on the public page? */
const NAMES_CONSOLE = /kj\s*[- ]?\s*admin|كي\s*جي\s*أدمن|لوحة\s*تحكم\s*kj/i;
export function namesConsole(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return NAMES_CONSOLE.test(value);
  if (Array.isArray(value)) return value.some(namesConsole);
  if (typeof value === 'object') return Object.values(value).some(namesConsole);
  return false;
}

// ═══════════════════════════════════════════════════════════════════ brand

function brandSection(doc, defaults, onChange, assets) {
  const brand = doc.brand;

  /**
   * The colour, three ways into the same value: the operating system's own
   * picker, the hex an owner was sent by a designer, and the six the console
   * itself is built from. The text box is the one that can be wrong, so it is
   * the one that says so.
   */
  const hex = h('input', {
    class: 'input hex', type: 'text', dir: 'ltr', spellcheck: 'false',
    value: brand.accent || '#4f46e5', 'aria-label': t('fAccent'),
  });
  const swatch = h('input', {
    type: 'color', value: /^#[0-9a-f]{6}$/i.test(brand.accent || '') ? brand.accent : '#4f46e5',
    'aria-label': t('fAccent'),
  });
  const bad = h('span', { class: 'error-text', style: { display: 'none' } }, t('fAccentInvalid'));

  const setAccent = (value, from) => {
    const ok = /^#[0-9a-f]{6}$/i.test(value);
    bad.style.display = ok ? 'none' : '';
    if (from !== 'hex') hex.value = value;
    if (ok && from !== 'swatch') swatch.value = value;
    if (ok) { brand.accent = value.toLowerCase(); onChange(); }
  };
  hex.addEventListener('input', () => setAccent(hex.value.trim(), 'hex'));
  swatch.addEventListener('input', () => setAccent(swatch.value, 'swatch'));

  const PRESETS = ['#4f46e5', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#15803d'];

  return stack(
    sub(t('secBrandSub')),
    biField({ label: t('fBrandName'), pair: ensurePair(brand, 'name'), required: true, onChange }),
    biField({ label: t('fBrandTagline'), pair: ensurePair(brand, 'tagline'), onChange }),
    h('div', { class: 'field' },
      h('label', {}, t('fAccent')),
      h('div', { class: 'accent-row' },
        swatch, hex,
        h('div', { class: 'accent-swatches' }, PRESETS.map((colour) => h('button', {
          type: 'button', style: { background: colour }, title: colour, 'aria-label': colour,
          onclick: () => setAccent(colour, 'preset'),
        })))),
      h('span', { class: 'hint' }, t('fAccentHint')),
      bad),
    /**
     * The three picture fields are the one thing on this screen that is NOT
     * part of the document being saved. The server strips `brand.logo`,
     * `hero.image` and a screenshot's `custom` on write and mints them back on
     * read from its own asset table — so an upload is live the moment it
     * lands, and writing the URL into the draft here would only invent a
     * change that can never be saved away. The asset map is the truth; the
     * field says so in words.
     */
    assetField({
      slot: 'logo',
      label: t('fLogo'),
      hint: t('fLogoHint'),
      maxBytes: 400 * 1024,
      isSet: () => Boolean(assets.logo),
      onSet: (meta) => { assets.logo = meta || true; },
      onClear: () => { delete assets.logo; },
    }),
  );
}

// ═════════════════════════════════════════════════════════════════ contact

function contactSection(doc, defaults, onChange) {
  const c = doc.contact;
  return stack(
    sub(t('secContactSub')),
    h('div', { class: 'grid cols-2' },
      plainField({
        label: t('fPhone'), value: c.phone, hint: t('fPhoneHint'), inputmode: 'tel',
        onChange: (v) => { c.phone = v; onChange(); },
      }),
      plainField({
        label: t('fWhatsapp'), value: c.whatsapp, hint: t('fWhatsappHint'), inputmode: 'tel',
        onChange: (v) => { c.whatsapp = v; onChange(); },
      })),
    plainField({
      label: t('fEmail'), value: c.email, type: 'email', inputmode: 'email',
      onChange: (v) => { c.email = v; onChange(); },
    }),
    biField({ label: t('fHours'), pair: ensurePair(c, 'hours'), onChange }),
  );
}

// ═════════════════════════════════════════════════════════════════════ seo

function seoSection(doc, defaults, onChange) {
  return stack(
    sub(t('secSeoSub')),
    biField({ label: t('fSeoTitle'), pair: ensurePair(doc.seo, 'title'), onChange }),
    biField({
      label: t('fSeoDescription'), pair: ensurePair(doc.seo, 'description'),
      hint: t('fSeoDescriptionHint'), area: true, rows: 3, onChange,
    }),
  );
}

// ════════════════════════════════════════════════════════════════════ hero

function heroSection(doc, defaults, onChange, assets) {
  const hero = doc.hero;
  return stack(
    sub(t('secHeroSub')),
    biField({ label: t('fHeroEyebrow'), pair: ensurePair(hero, 'eyebrow'), onChange }),
    biField({ label: t('fHeroTitle'), pair: ensurePair(hero, 'title'), area: true, rows: 2, required: true, onChange }),
    biField({ label: t('fHeroSubtitle'), pair: ensurePair(hero, 'subtitle'), area: true, onChange }),
    h('div', { class: 'grid cols-2' },
      biField({ label: t('fPrimaryCta'), pair: ensurePair(hero, 'primaryCta'), onChange }),
      biField({ label: t('fSecondaryCta'), pair: ensurePair(hero, 'secondaryCta'), onChange })),
    pairList({
      items: list(hero, 'trust'),
      label: t('fTrust'),
      itemName: (i) => `${t('fTrustOne')} ${i + 1}`,
      onChange,
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
    }),
    assetField({
      slot: 'hero',
      label: t('fHeroImage'),
      maxBytes: 1200 * 1024,
      isSet: () => Boolean(assets.hero),
      onSet: (meta) => { assets.hero = meta || true; },
      onClear: () => { delete assets.hero; },
    }),
  );
}

// ════════════════════════════════════════════════════════════════ overview

const BLOCK_ICONS = ['till', 'boxes', 'globe-bag'];
const blockIconLabel = (key) => ({
  till: t('iconTill'), boxes: t('iconBoxes'), 'globe-bag': t('iconGlobeBag'),
}[key] || key);

function overviewSection(doc, defaults, onChange) {
  const ov = doc.overview;
  return stack(
    sub(t('secOverviewSub')),
    biField({ label: t('fOverviewTitle'), pair: ensurePair(ov, 'title'), onChange }),
    biField({ label: t('fOverviewIntro'), pair: ensurePair(ov, 'intro'), area: true, onChange }),
    listEditor({
      items: list(ov, 'blocks'),
      label: t('fOverviewBlocks'),
      addLabel: t('fBlock'),
      itemName: (i) => `${t('fBlock')} ${i + 1}`,
      onChange,
      makeItem: () => ({ icon: 'till', title: emptyPair(), body: emptyPair() }),
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      renderItem: (item, index) => [
        h('div', { class: 'field' },
          h('label', {}, `${t('fBlockIcon')} — ${t('fBlock')} ${index + 1}`),
          selectInput({
            options: BLOCK_ICONS.map((key) => ({ value: key, label: blockIconLabel(key) })),
            value: item.icon || 'till',
            'aria-label': `${t('fBlockIcon')} — ${t('fBlock')} ${index + 1}`,
            onchange: (event) => { item.icon = event.target.value; onChange(); },
          })),
        biField({
          label: `${t('fBlockTitle')} — ${t('fBlock')} ${index + 1}`,
          hideLabel: true, pair: ensurePair(item, 'title'), onChange,
        }),
        biField({
          label: `${t('fBlockBody')} — ${t('fBlock')} ${index + 1}`,
          hideLabel: true, pair: ensurePair(item, 'body'), area: true, rows: 2, onChange,
        }),
      ],
    }),
    biField({ label: t('fOverviewClosing'), pair: ensurePair(ov, 'closing'), area: true, rows: 2, onChange }),
  );
}

// ═══════════════════════════════════════════════════════════════════ steps

function stepsSection(doc, defaults, onChange) {
  const s = doc.steps;
  return stack(
    sub(t('secStepsSub')),
    biField({ label: t('fStepsTitle'), pair: ensurePair(s, 'title'), onChange }),
    biField({ label: t('fStepsNote'), pair: ensurePair(s, 'note'), onChange }),
    listEditor({
      items: list(s, 'items'),
      label: t('fSteps'),
      addLabel: t('fStep'),
      itemName: (i) => `${t('fStep')} ${i + 1}`,
      onChange,
      makeItem: () => ({ title: emptyPair(), body: emptyPair() }),
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      renderItem: (item, index) => [
        biField({
          label: `${t('fStepTitle')} — ${t('fStep')} ${index + 1}`,
          hideLabel: true, pair: ensurePair(item, 'title'), onChange,
        }),
        biField({
          label: `${t('fStepBody')} — ${t('fStep')} ${index + 1}`,
          hideLabel: true, pair: ensurePair(item, 'body'), area: true, rows: 2, onChange,
        }),
      ],
    }),
  );
}

// ════════════════════════════════════════════════════════════════ audience

function audienceSection(doc, defaults, onChange) {
  const a = doc.audience;
  return stack(
    sub(t('secAudienceSub')),
    biField({ label: t('fAudienceTitle'), pair: ensurePair(a, 'title'), onChange }),
    h('div', { class: 'panel stack' },
      biField({ label: t('fYesTitle'), pair: ensurePair(a, 'yesTitle'), onChange }),
      pairList({
        items: list(a, 'yes'),
        label: t('fYesItems'),
        itemName: (i) => `${t('fAudienceItem')} ${i + 1}`,
        onChange,
        empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      })),
    h('div', { class: 'panel stack' },
      biField({ label: t('fNoTitle'), pair: ensurePair(a, 'noTitle'), onChange }),
      pairList({
        items: list(a, 'no'),
        label: t('fNoItems'),
        itemName: (i) => `${t('fAudienceItem')} ${i + 1}`,
        onChange,
        empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      })),
    biField({ label: t('fAudienceClosing'), pair: ensurePair(a, 'closing'), area: true, rows: 2, onChange }),
  );
}

// ══════════════════════════════════════════════════════════════════ versus

function versusSection(doc, defaults, onChange) {
  const v = doc.versus;
  return stack(
    sub(t('secVersusSub')),
    biField({ label: t('fVersusTitle'), pair: ensurePair(v, 'title'), onChange }),
    listEditor({
      items: list(v, 'rows'),
      label: t('fVersusRows'),
      addLabel: t('fVersusRow'),
      itemName: (i) => `${t('fVersusRow')} ${i + 1}`,
      onChange,
      makeItem: () => ({ before: emptyPair(), after: emptyPair() }),
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      renderItem: (item, index) => [
        biField({
          label: `${t('fBefore')} — ${t('fVersusRow')} ${index + 1}`,
          pair: ensurePair(item, 'before'), area: true, rows: 2, onChange,
        }),
        biField({
          label: `${t('fAfter')} — ${t('fVersusRow')} ${index + 1}`,
          pair: ensurePair(item, 'after'), area: true, rows: 2, onChange,
        }),
      ],
    }),
  );
}

// ════════════════════════════════════════════════════════════════ packages

/** A new package's id: readable, unique, and never colliding with an old one. */
function nextPackageId(items) {
  let n = items.length + 1;
  const taken = new Set(items.map((item) => item.id));
  while (taken.has(`pkg-${n}`)) n += 1;
  return `pkg-${n}`;
}

const pkgLabel = (item, index) => {
  const lang = getLanguage();
  const name = item?.name?.[lang] || item?.name?.en || item?.name?.ar;
  return name ? `${t('fPackage')} — ${name}` : `${t('fPackage')} ${index + 1}`;
};

function packagesSection(doc, defaults, onChange) {
  const p = doc.packages;
  const items = list(p, 'items');
  const lang = getLanguage();

  /** Every price's neighbour, so changing the currency updates all of them
   *  without rebuilding a card the owner is typing into. */
  const suffixes = [];
  // Joined with a space, not a slash: the period field carries its own
  // separator ("/ month", "/ شهريًا"), and adding a second one prints "EGP / /
  // month" next to every price.
  const suffixText = () => [p.currency?.[lang] || p.currency?.en, p.period?.[lang] || p.period?.en]
    .map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  const refreshSuffixes = () => { for (const node of suffixes) node.textContent = suffixText(); };

  /** Only one package can be the highlighted one. Turning this one on turns
   *  the others off in place — no rebuild, so the focus stays on the switch. */
  const featureSwitches = new Map();

  const listNode = listEditor({
    items,
    label: t('fPackages'),
    addLabel: t('fPackage'),
    itemName: (i) => pkgLabel(items[i], i),
    onChange,
    makeItem: () => ({
      id: nextPackageId(items),
      name: emptyPair(),
      price: 0,
      badge: null,
      featured: false,
      oneLiner: emptyPair(),
      inherits: null,
      features: [],
      cta: emptyPair(),
    }),
    confirmRemove: (item, index) => ({
      title: t('pkgRemoveTitle', { name: pkgLabel(item, index) }),
      message: t('pkgRemoveBody', { n: item.features?.length || 0 }),
    }),
    empty: { title: t('listEmptyTitle'), message: t('pkgEmptyWarn') },
    renderItem: (item, index) => {
      const name = pkgLabel(item, index);

      const price = h('input', {
        class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', dir: 'ltr',
        value: item.price === null || item.price === undefined ? '' : String(item.price),
        'aria-label': `${t('fPrice')} — ${name}`,
        oninput: (event) => {
          const raw = event.target.value;
          item.price = raw === '' ? null : Number(raw);
          onChange();
        },
      });
      const sfx = h('span', { class: 'sfx' }, suffixText());
      suffixes.push(sfx);

      // A badge and an "everything in the package before" line are each a
      // pair or nothing at all. The switch fills a slot rather than rebuilding
      // the card, so turning one on with the keyboard does not lose the key.
      const badgeSlot = h('div', {});
      const fillBadge = () => {
        badgeSlot.replaceChildren(item.badge
          ? biField({ label: `${t('fBadge')} — ${name}`, hideLabel: true, pair: item.badge, onChange })
          : document.createComment(''));
      };
      fillBadge();

      const inheritSlot = h('div', {});
      const fillInherit = () => {
        inheritSlot.replaceChildren(item.inherits
          ? biField({ label: `${t('fInherits')} — ${name}`, hideLabel: true, pair: item.inherits, onChange })
          : document.createComment(''));
      };
      fillInherit();

      const featured = switchField({
        label: `${t('fFeatured')} — ${name}`,
        checked: Boolean(item.featured),
        onText: t('fFeatured'),
        offText: t('fFeatured'),
        onChange: (on) => {
          item.featured = on;
          if (on) {
            for (const other of items) {
              if (other === item || !other.featured) continue;
              other.featured = false;
              featureSwitches.get(other)?.set(false);
            }
          }
          onChange();
        },
      });
      featureSwitches.set(item, featured);

      return [
        h('div', { class: 'row tight' },
          h('span', { class: 'tag quiet mono', dir: 'ltr' }, `${t('fPackageId')} ${item.id || '—'}`),
          h('span', { class: 'spacer' }),
          featured),
        h('div', { class: 'grid cols-2' },
          biField({
            label: `${t('fPackageName')} — ${name}`, hideLabel: true,
            pair: ensurePair(item, 'name'), required: true, onChange,
          }),
          h('div', { class: 'field' },
            h('label', { class: 'sr-only' }, `${t('fPrice')} — ${name}`),
            h('div', { class: 'suffixed' }, price, sfx),
            h('span', { class: 'hint' }, t('fPriceHint')))),
        biField({
          label: `${t('fOneLiner')} — ${name}`, hideLabel: true,
          pair: ensurePair(item, 'oneLiner'), area: true, rows: 2, onChange,
        }),
        h('div', { class: 'row tight' },
          switchField({
            label: `${t('fHasBadge')} — ${name}`,
            checked: Boolean(item.badge),
            onText: t('fHasBadge'),
            offText: t('fHasBadge'),
            onChange: (on) => { item.badge = on ? emptyPair() : null; fillBadge(); onChange(); },
          }),
          switchField({
            label: `${t('fHasInherits')} — ${name}`,
            checked: Boolean(item.inherits),
            onText: t('fHasInherits'),
            offText: t('fHasInherits'),
            onChange: (on) => { item.inherits = on ? emptyPair() : null; fillInherit(); onChange(); },
          })),
        badgeSlot,
        inheritSlot,
        pairList({
          items: list(item, 'features'),
          label: `${t('fFeatures')} — ${name}`,
          itemName: (i) => `${t('fFeature')} ${i + 1}`,
          onChange,
          confirmRemove: (bullet, bulletIndex, count) => (count === 1
            ? { title: t('removeRowTitle'), message: t('pkgNoFeaturesWarn', { name }) }
            : { title: t('removeRowTitle'), message: t('removeRowBody') }),
          empty: { title: t('listEmptyTitle'), message: t('pkgNoFeaturesWarn', { name }) },
        }),
        biField({
          label: `${t('fPackageCta')} — ${name}`, hideLabel: true,
          pair: ensurePair(item, 'cta'), onChange,
        }),
      ];
    },
  });

  const currency = biField({ label: t('fCurrency'), pair: ensurePair(p, 'currency'), hint: t('fCurrencyHint'), onChange: () => { refreshSuffixes(); onChange(); } });
  const period = biField({ label: t('fPeriod'), pair: ensurePair(p, 'period'), onChange: () => { refreshSuffixes(); onChange(); } });

  return stack(
    sub(t('secPackagesSub')),
    biField({ label: t('fPackagesTitle'), pair: ensurePair(p, 'title'), onChange }),
    biField({ label: t('fPackagesNote'), pair: ensurePair(p, 'note'), area: true, rows: 2, onChange }),
    biField({ label: t('fPackagesReassure'), pair: ensurePair(p, 'reassure'), area: true, rows: 2, onChange }),
    h('div', { class: 'grid cols-2' }, currency, period),
    listNode,
  );
}

// ════════════════════════════════════════════════════════════════ included

function includedSection(doc, defaults, onChange) {
  const inc = doc.included;
  return stack(
    sub(t('secIncludedSub')),
    biField({ label: t('fIncludedTitle'), pair: ensurePair(inc, 'title'), onChange }),
    pairList({
      items: list(inc, 'items'),
      label: t('fIncludedItems'),
      itemName: (i) => `${t('fIncludedItem')} ${i + 1}`,
      onChange,
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════ shots

/**
 * The captures that ship in the app: one per slot per language, under
 * `/kj/shots/`. Naming the file is what makes "remove mine" a destination
 * rather than a hole — the owner can see exactly what comes back.
 */
const shotDefaultFile = (key) => `${key}-${getLanguage()}.webp`;
const shotDefaultSrc = (key) => `/kj/shots/${shotDefaultFile(key)}`;

function shotsSection(doc, defaults, onChange, assets) {
  const sh = doc.shots;
  const items = list(sh, 'items');

  return stack(
    sub(t('secShotsSub')),
    biField({ label: t('fShotsTitle'), pair: ensurePair(sh, 'title'), onChange }),
    biField({ label: t('fShotsNote'), pair: ensurePair(sh, 'note'), onChange }),
    h('div', { class: 'otp-note' }, t('shotsFixedNote')),
    listEditor({
      items,
      label: t('secShots'),
      itemName: (i) => `${t('secShots')} — ${items[i]?.key || i + 1}`,
      onChange,
      removable: false,
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      renderItem: (item, index) => {
        const name = `${item.key || index + 1}`;
        const shownWarn = h('div', {});
        const refreshWarn = () => {
          shownWarn.replaceChildren(item.enabled === false
            ? h('div', { class: 'otp-warn' }, t('fShotShownOff'))
            : document.createComment(''));
        };
        refreshWarn();
        return [
          h('div', { class: 'row tight' },
            h('span', { class: 'tag quiet mono', dir: 'ltr' }, name),
            h('span', { class: 'spacer' }),
            switchField({
              label: `${t('fShotShown')} — ${name}`,
              checked: item.enabled !== false,
              onText: t('fShotShown'),
              offText: t('fShotShown'),
              onChange: (on) => { item.enabled = on; refreshWarn(); onChange(); },
            })),
          shownWarn,
          biField({
            label: `${t('fShotCaption')} — ${name}`, hideLabel: true,
            pair: ensurePair(item, 'caption'), onChange,
          }),
          h('div', { class: 'field' },
            h('label', {}, `${t('fShotKind')} — ${name}`),
            selectInput({
              options: [
                { value: 'desktop', label: t('shotDesktop') },
                { value: 'phone', label: t('shotPhone') },
              ],
              value: item.kind || 'desktop',
              'aria-label': `${t('fShotKind')} — ${name}`,
              onchange: (event) => { item.kind = event.target.value; onChange(); },
            })),
          assetField({
            slot: `shot-${item.key}`,
            label: `${t('fShotCustom')} — ${name}`,
            maxBytes: 800 * 1024,
            defaultFile: shotDefaultFile(item.key),
            defaultSrc: shotDefaultSrc(item.key),
            isSet: () => Boolean(assets[`shot-${item.key}`]),
            onSet: (meta) => { assets[`shot-${item.key}`] = meta || true; },
            onClear: () => { delete assets[`shot-${item.key}`]; },
          }),
        ];
      },
    }),
  );
}

// ══════════════════════════════════════════════════════════════════ quotes

function quotesSection(doc, defaults, onChange) {
  const q = doc.quotes;
  const items = list(q, 'items');
  return stack(
    sub(t('secQuotesSub')),
    biField({ label: t('fQuotesTitle'), pair: ensurePair(q, 'title'), onChange }),
    listEditor({
      items,
      label: t('fQuotes'),
      addLabel: t('fQuote'),
      itemName: (i) => `${t('fQuote')} ${i + 1}`,
      onChange,
      makeItem: () => ({
        quote: emptyPair(), name: '', shop: '', city: '',
      }),
      // The section only exists while it has something in it — so removing the
      // last one is removing the section, and it says so.
      confirmRemove: (item, index, count) => (count === 1
        ? { title: t('quoteRemoveLastTitle'), message: t('quoteRemoveLastBody') }
        : { title: t('removeRowTitle'), message: t('removeRowBody') }),
      empty: { title: t('listEmptyTitle'), message: t('quotesEmptyMsg') },
      renderItem: (item, index) => [
        biField({
          label: `${t('fQuoteText')} — ${t('fQuote')} ${index + 1}`,
          hideLabel: true, pair: ensurePair(item, 'quote'), area: true, rows: 3, onChange,
        }),
        h('div', { class: 'grid cols-3' },
          plainField({
            label: `${t('fQuoteName')} — ${t('fQuote')} ${index + 1}`, hideLabel: true,
            placeholder: t('fQuoteName'), dir: 'auto', value: item.name,
            onChange: (v) => { item.name = v; onChange(); },
          }),
          plainField({
            label: `${t('fQuoteShop')} — ${t('fQuote')} ${index + 1}`, hideLabel: true,
            placeholder: t('fQuoteShop'), dir: 'auto', value: item.shop,
            onChange: (v) => { item.shop = v; onChange(); },
          }),
          plainField({
            label: `${t('fQuoteCity')} — ${t('fQuote')} ${index + 1}`, hideLabel: true,
            placeholder: t('fQuoteCity'), dir: 'auto', value: item.city,
            onChange: (v) => { item.city = v; onChange(); },
          })),
      ],
    }),
  );
}

// ════════════════════════════════════════════════════════════════════ demo

function demoSection(doc, defaults, onChange) {
  const d = doc.demo;
  if (!d.fields || typeof d.fields !== 'object') d.fields = {};
  const f = d.fields;
  return stack(
    sub(t('secDemoSub')),
    biField({ label: t('fDemoTitle'), pair: ensurePair(d, 'title'), onChange }),
    biField({ label: t('fDemoBody'), pair: ensurePair(d, 'body'), area: true, onChange }),
    h('div', { class: 'grid cols-2' },
      biField({ label: t('fDemoButton'), pair: ensurePair(d, 'button'), onChange }),
      biField({ label: t('fDemoSmall'), pair: ensurePair(d, 'small'), onChange })),
    h('div', { class: 'panel stack' },
      h('span', { class: 'small strong' }, t('fDemoFields')),
      biField({ label: t('fDemoName'), pair: ensurePair(f, 'name'), onChange }),
      biField({ label: t('fDemoPhone'), pair: ensurePair(f, 'phone'), onChange }),
      biField({ label: t('fDemoShopType'), pair: ensurePair(f, 'shopType'), onChange }),
      biField({ label: t('fDemoBranches'), pair: ensurePair(f, 'branches'), onChange }),
      biField({ label: t('fDemoMessage'), pair: ensurePair(f, 'message'), onChange })),
  );
}

// ═════════════════════════════════════════════════════════════════════ faq

function faqSection(doc, defaults, onChange) {
  const faq = doc.faq;
  return stack(
    sub(t('secFaqSub')),
    biField({ label: t('fFaqTitle'), pair: ensurePair(faq, 'title'), onChange }),
    listEditor({
      items: list(faq, 'items'),
      label: t('fFaqItems'),
      addLabel: t('fFaqItem'),
      itemName: (i) => `${t('fFaqItem')} ${i + 1}`,
      onChange,
      makeItem: () => ({ q: emptyPair(), a: emptyPair() }),
      empty: { title: t('listEmptyTitle'), message: t('sectionEmptyWarn') },
      renderItem: (item, index) => [
        biField({
          label: `${t('fFaqQ')} — ${index + 1}`, pair: ensurePair(item, 'q'), onChange,
        }),
        biField({
          label: `${t('fFaqA')} — ${index + 1}`, pair: ensurePair(item, 'a'), area: true, rows: 3, onChange,
        }),
      ],
    }),
  );
}

// ═════════════════════════════════════════════════════════════════ closing

function closingSection(doc, defaults, onChange) {
  const c = doc.closing;
  return stack(
    sub(t('secClosingSub')),
    biField({ label: t('fClosingTitle'), pair: ensurePair(c, 'title'), onChange }),
    biField({ label: t('fClosingBody'), pair: ensurePair(c, 'body'), area: true, onChange }),
    h('div', { class: 'grid cols-2' },
      biField({ label: t('fPrimaryCta'), pair: ensurePair(c, 'primaryCta'), onChange }),
      biField({ label: t('fSecondaryCta'), pair: ensurePair(c, 'secondaryCta'), onChange })),
  );
}

// ══════════════════════════════════════════════════════════════════ footer

function footerSection(doc, defaults, onChange) {
  const f = doc.footer;
  return stack(
    sub(t('secFooterSub')),
    biField({ label: t('fFooterLine'), pair: ensurePair(f, 'line'), onChange }),
    biField({ label: t('fFooterMadeIn'), pair: ensurePair(f, 'madeIn'), onChange }),
    biField({ label: t('fFooterRights'), pair: ensurePair(f, 'rights'), onChange }),
  );
}

// ═══════════════════════════════════════════════════════════ the registry

/** "This list is empty, so the section vanishes" — the one warning that
 *  applies to half the sections on the page. */
const emptyListWarn = (arr) => (Array.isArray(arr) && arr.length === 0 ? t('sectionEmptyWarn') : null);

export const SECTIONS = [
  { key: 'brand', label: 'secBrand', build: brandSection },
  { key: 'contact', label: 'secContact', build: contactSection },
  { key: 'seo', label: 'secSeo', build: seoSection },
  {
    key: 'hero',
    label: 'secHero',
    build: heroSection,
    warn: (doc) => [emptyListWarn(doc.hero?.trust)],
  },
  {
    key: 'overview',
    label: 'secOverview',
    build: overviewSection,
    warn: (doc) => [emptyListWarn(doc.overview?.blocks)],
  },
  {
    key: 'steps',
    label: 'secSteps',
    toggle: true,
    build: stepsSection,
    warn: (doc) => [emptyListWarn(doc.steps?.items)],
  },
  {
    key: 'audience',
    label: 'secAudience',
    toggle: true,
    build: audienceSection,
    warn: (doc) => [
      (doc.audience?.yes?.length === 0 && doc.audience?.no?.length === 0) ? t('sectionEmptyWarn') : null,
    ],
  },
  {
    key: 'versus',
    label: 'secVersus',
    toggle: true,
    build: versusSection,
    warn: (doc) => [emptyListWarn(doc.versus?.rows)],
  },
  {
    key: 'packages',
    label: 'secPackages',
    build: packagesSection,
    warn: (doc) => {
      const items = doc.packages?.items || [];
      if (!items.length) return [t('pkgEmptyWarn')];
      const out = [];
      if (!items.some((item) => item.featured)) out.push(t('pkgNoFeaturedWarn'));
      items.forEach((item, index) => {
        if (!item.features?.length) out.push(t('pkgNoFeaturesWarn', { name: pkgLabel(item, index) }));
      });
      return out;
    },
  },
  {
    key: 'included',
    label: 'secIncluded',
    toggle: true,
    build: includedSection,
    warn: (doc) => [emptyListWarn(doc.included?.items)],
  },
  {
    key: 'shots',
    label: 'secShots',
    build: shotsSection,
    warn: (doc) => {
      const items = doc.shots?.items || [];
      if (!items.length) return [t('sectionEmptyWarn')];
      return items.every((item) => item.enabled === false) ? [t('sectionEmptyWarn')] : [];
    },
  },
  {
    key: 'quotes',
    label: 'secQuotes',
    toggle: true,
    build: quotesSection,
    warn: (doc) => [doc.quotes?.items?.length ? null : t('quotesEmptyMsg')],
  },
  { key: 'demo', label: 'secDemo', build: demoSection },
  {
    key: 'faq',
    label: 'secFaq',
    toggle: true,
    build: faqSection,
    warn: (doc) => [emptyListWarn(doc.faq?.items)],
  },
  { key: 'closing', label: 'secClosing', toggle: true, build: closingSection },
  { key: 'footer', label: 'secFooter', build: footerSection },
];

export default SECTIONS;
