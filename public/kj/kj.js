/**
 * KJ — the landing page. The document it renders, the two languages it renders
 * it in, and the one form on it.
 *
 * WHAT THIS FILE IS NOT: it is not the page. `index.html` ships the whole
 * landing page in Arabic, already written out, so a visitor whose connection
 * loses this module — or who has JavaScript off entirely — still gets the
 * offer, the three prices, the phone number and the WhatsApp link.
 *
 * THE DOCUMENT. Everything a shop owner can edit from his console lives in one
 * JSON document, and `DEFAULTS` below is that document with the page's own
 * content in it. On boot this file:
 *
 *   1. renders `DEFAULTS` — which, in Arabic, changes nothing at all, because
 *      `index.html` is that same content already written out;
 *   2. fetches `GET /api/landing` and merges what comes back OVER `DEFAULTS`;
 *   3. renders again.
 *
 * There is no loading state and there is nothing to wait for: the page is
 * complete before the fetch is made, complete if the fetch fails, and complete
 * if there is no server behind it at all. The document is an OVERRIDE.
 *
 * NOTHING VISIBLY REBUILDS. Every write below goes through `setText`,
 * `setAttr` or `renderList`, and each of those compares before it assigns — a
 * node whose text already says what the document says is not touched, so no
 * paint, no layout and no reflow happens for it. A deployment nobody has
 * edited performs exactly zero DOM mutations on boot;
 * `tests/kj-landing-check.mjs` asserts that with a `MutationObserver`.
 *
 * NOTHING FROM THE DOCUMENT IS MARKUP. It arrives from a form the owner typed
 * into, so it is written with `textContent` and `setAttribute`, never
 * `innerHTML`, and the only attributes it can reach are ones whose values are
 * validated here: a URL must be an asset path, a phone must be digits, an
 * address must look like an address.
 *
 * On top of all that, the same four enhancements as before: English, the
 * palette derived from one hex, reveal-on-scroll, and the WhatsApp composer.
 *
 * No framework, no build step, no third party. Same rules as the ERP, the
 * storefront and the console.
 */

import { applyTheme, monogramFavicon } from '../shared/brandTheme.js';
import { DEFAULTS } from './defaults.js';

const STORAGE_KEY = 'kj.lang';
const API = '/api/landing';

// =========================================================================
// CHROME STRINGS
//
// The furniture: a skip link, the name of the other language, the words on
// the four page links, and the alt text under each screenshot. These are NOT
// in the landing document, and deliberately: the contract has no nav and no
// alt field, an alt text describes a picture rather than sells anything, and
// the contact section's own labels are the same three words on every version
// of this page. Same `{ ar, en }` shape as everything else, so if the contract
// ever grows a home for them they move without changing shape.
// =========================================================================

const UI = {
  skipToContent: { ar: 'تخطَّ إلى المحتوى', en: 'Skip to content' },
  langSwitch: { ar: 'English', en: 'العربية' },
  langSwitchLabel: { ar: 'Switch to English', en: 'التبديل إلى العربية' },
  navLabel: { ar: 'روابط الصفحة', en: 'Page links' },
  footNavLabel: { ar: 'روابط التذييل', en: 'Footer links' },
  navPackages: { ar: 'الباقات', en: 'Packages' },
  navSteps: { ar: 'إزاي بنشتغل', en: 'How it works' },
  navFaq: { ar: 'أسئلة شائعة', en: 'FAQ' },
  navContact: { ar: 'كلّمنا', en: 'Contact' },
  optional: { ar: '(اختياري)', en: '(optional)' },

  // The contact section's own words. The document owns the phone number, the
  // WhatsApp number, the address and the hours; these three labels and two
  // buttons are the page's furniture around them.
  contactTitle: { ar: 'كلّمنا', en: 'Talk to us' },
  contactBody: {
    ar: 'لو عندك سؤال قبل ما تحجز، اتصل أو ابعتلنا واتساب — هنرد عليك بنفسنا، مش روبوت.',
    en: 'If you have a question before booking, call us or send a WhatsApp — you will get a person, not a bot.',
  },
  contactPhone: { ar: 'تليفون', en: 'Phone' },
  contactWhatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  contactEmail: { ar: 'البريد الإلكتروني', en: 'Email' },
  contactCall: { ar: 'اتصل بينا دلوقتي', en: 'Call us now' },
  contactWa: { ar: 'كلّمنا على واتساب', en: 'Message us on WhatsApp' },

  // Alt text describes what is ON the screen, for someone who cannot see it.
  // Not the caption again — the caption is the sales line and it is already
  // read out beside the picture. Keyed by the screenshot's own slot, so a shot
  // the owner replaces keeps the description of the thing it shows, and one he
  // adds falls back to its caption rather than to somebody else's description.
  alt: {
    pos: {
      ar: 'شاشة نقطة البيع في النظام: خانة الباركود فوق، وسلة فيها أربع قطع بأسعارها، والإجمالي ٥٬٤٤٩٫٢٠ جنيه، وزر إتمام البيع تحته.',
      en: 'The point-of-sale screen: a barcode field at the top, a basket holding four items with their prices, a total of 5,449.20 EGP and a complete-sale button under it.',
    },
    dashboard: {
      ar: 'لوحة التحكم: مربعات بمبيعات اليوم وإيرادات الشهر وقيمة المخزون، ورسم بياني لمبيعات آخر ٣٠ يومًا، وتنبيه بأصناف قربت تخلص.',
      en: 'The dashboard: tiles for today’s sales, this month’s revenue and stock value, a chart of the last 30 days of sales, and an alert listing items that are running low.',
    },
    products: {
      ar: 'شاشة المنتجات: جدول فيه كود كل صنف واسمه وعدد متغيراته وسعره وكميته في المخزن ومورده وحالته.',
      en: 'The products screen: a table with each item’s code, name, number of variants, price, stock quantity, supplier and status.',
    },
    weborders: {
      ar: 'شاشة طلبات الأونلاين في النظام: جدول بأرقام الطلبات وأسماء العملاء ومدنهم وإجمالي كل طلب وحالته — جديد، تم القبول، قيد التوصيل، تم التسليم.',
      en: 'The web-orders screen: a table of order numbers, customer names, cities, order totals and each order’s stage — new, accepted, out for delivery, delivered.',
    },
    'shop-home': {
      ar: 'الصفحة الرئيسية للمتجر الإلكتروني على موبايل: شريط شحن مجاني فوق، بانر التشكيلة، وأقسام المنتجات تحته.',
      en: 'The online shop’s home page on a phone: a free-delivery strip at the top, the collection banner, and the product categories below it.',
    },
    'shop-product': {
      ar: 'صفحة منتج في المتجر على موبايل: صورة الشنطة، السعر ٢٬٤٥٠ جنيه، اختيار اللون، والكمية، وزر أضف إلى السلة.',
      en: 'A product page in the online shop on a phone: the bag’s photo, a price of 2,450 EGP, colour options, a quantity stepper and an add-to-cart button.',
    },
    'shop-checkout': {
      ar: 'صفحة إتمام الطلب على موبايل: الدفع عند الاستلام مختار، ملخص الطلب بالمنتجات، والإجمالي ٥٬٥٦٣٫٢٠ جنيه، وزر أكّد الطلب.',
      en: 'The checkout on a phone: cash on delivery selected, an order summary listing the items, a total of 5,563.20 EGP and a confirm-order button.',
    },
  },
};

// =========================================================================
// THE DEFAULT DOCUMENT
//
// Every string on this page that the owner can change, in the shape the
// control plane stores and the console edits. This IS the page that ships:
// a deployment that has never been edited, or whose control plane is
// unreachable, renders exactly what `index.html` already says.
//
// Both languages sit side by side in every field. The Arabic is the approved
// copy — Egyptian, written for Egyptian shop owners rather than translated
// into them — and the English beside it is the approved English, not a
// rendering of the Arabic. Neither side is generated from the other.
//
// A price is a NUMBER. The owner types 3500; the page renders ٣٬٥٠٠ for a
// reader in Arabic and 3,500 for a reader in English, with the currency and
// the period from the two fields beside the list.
// =========================================================================


// =========================================================================
// READING THE DOCUMENT SAFELY
//
// Everything below assumes the document is hostile: it came off a form, over
// a network, out of a store that another process writes. Nothing it contains
// can become markup, a scheme, or an exception.
// =========================================================================

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The override, merged onto the defaults. Objects merge key by key; arrays
 * replace whole, because "the owner removed the fourth bullet" and "the owner
 * left the list alone" have to be different things. `undefined` never
 * overrides; `null` and `false` do, because clearing a badge and switching a
 * section off are both edits.
 */
function merge(base, over) {
  if (!isObject(over)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    out[key] = isObject(value) && isObject(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/** `pick(root, 'packages.items')`, and never a throw on a missing branch. */
function pick(root, path) {
  let node = root;
  for (const step of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    node = node[step];
  }
  return node;
}

/**
 * A `{ ar, en }` pair read in the reader's language, falling through to the
 * other language and then to nothing. A pair that is not a pair — a number, a
 * missing branch, an array the console got wrong — reads as empty, and an
 * empty string is what hides the element it was going to fill.
 */
function text(pair, lang) {
  if (typeof pair === 'string') return pair;
  if (!isObject(pair)) return '';
  const own = pair[lang];
  if (typeof own === 'string' && own.trim()) return own;
  const other = pair[lang === 'ar' ? 'en' : 'ar'];
  return typeof other === 'string' ? other : '';
}

/** A list, or an empty one. Never `undefined`, never a string, never an object. */
const list = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
/** The same, for a list of `{ ar, en }` pairs. */
const pairs = (value) => (Array.isArray(value) ? value.filter((v) => isObject(v) || typeof v === 'string') : []);

/** Digits only, in the shape wa.me wants: country code, no plus, no spaces. */
function intlPhone(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('20')) return digits;
  if (digits.startsWith('0')) return `20${digits.slice(1)}`;
  return digits;
}

/** An address, or nothing. No scheme, no space, no newline can get through. */
function safeEmail(raw) {
  const value = String(raw ?? '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? value : '';
}

/**
 * An image URL the page is willing to load. Only the control plane's own asset
 * route and this repo's own folder — a document that says `javascript:` or
 * points at somebody else's host gets nothing, and the built-in is used.
 */
function safeAsset(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  return /^\/(api\/landing\/asset\/[A-Za-z0-9._-]+|kj\/[A-Za-z0-9._/-]+)$/.test(value) ? value : '';
}

const ICONS = new Set(['till', 'boxes', 'globe-bag', 'check', 'phone', 'mail', 'clock']);

// =========================================================================
// LANGUAGE
// =========================================================================

/**
 * Arabic wins on first visit — this page sells to Egyptian shop owners and it
 * is written for them. `localStorage` is read inside a `try` because private
 * browsing on iOS has historically thrown on access, and a storage quirk must
 * not take a sales page down.
 */
function readStored() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'en' || saved === 'ar' ? saved : null;
  } catch {
    return null;
  }
}

let language = readStored() || 'ar';
let doc = DEFAULTS;

const isRtl = () => language === 'ar';

/** The reader's own numerals: ٣٬٥٠٠ in Arabic, 3,500 in English. */
const formatters = {};
function number(value, lang) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  formatters[lang] ??= new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US');
  return formatters[lang].format(n);
}

// =========================================================================
// WRITING TO THE PAGE — the three primitives, and all three compare first
//
// This is what makes the render invisible. `index.html` already says what
// `DEFAULTS` says, so on an unedited deployment every comparison below is
// equal and not one node is written to: no mutation record, no style
// recalculation, no paint. The page does not rebuild itself under the reader
// because, when there is nothing to change, it does not touch itself at all.
// =========================================================================

function setText(node, value) {
  if (!node) return;
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node, name, value) {
  if (!node) return;
  if (value === null || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== String(value)) {
    node.setAttribute(name, String(value));
  }
}

function setHidden(node, hidden) {
  if (!node) return;
  if (node.hidden !== hidden) node.hidden = hidden;
}

function setClass(node, name, on) {
  if (!node) return;
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/**
 * A string that is empty hides the element it was going to fill, rather than
 * leaving a blank line where a badge or an inherited-features line used to be.
 * The contract's rule — nothing empty renders — applied one node at a time.
 */
function setTextOrHide(node, value) {
  if (!node) return;
  const empty = !value;
  setHidden(node, empty);
  if (!empty) setText(node, value);
}

// -------------------------------------------------------------- the lists --

/**
 * Prototypes, captured once, before anything is rendered: the shape of one
 * list item as it ships in `index.html`. When the owner adds a sixth bullet
 * the renderer clones the prototype and fills it, so a new item is built out
 * of the same markup as the ones that shipped and cannot drift away from them.
 *
 * `quotes` keeps its prototype in a `<template>` instead of in the list,
 * because that list ships empty and a prototype sitting in it would be an
 * empty card on a page with no script.
 */
const prototypes = new WeakMap();

function captureProto(container) {
  const fromTemplate = container.querySelector(':scope > template[data-proto]');
  if (fromTemplate) {
    prototypes.set(container, [fromTemplate.content.firstElementChild.cloneNode(true)]);
    return;
  }
  // A list whose items come in two shapes (the screenshots: windows and
  // phones) keeps one prototype per shape, chosen by the item's `kind`.
  const kids = [...container.children];
  const desktop = kids.find((n) => n.classList.contains('shot-desktop'));
  const phone = kids.find((n) => n.classList.contains('shot-phone'));
  if (desktop && phone) {
    prototypes.set(container, { desktop: desktop.cloneNode(true), phone: phone.cloneNode(true) });
    return;
  }
  if (kids[0]) prototypes.set(container, [kids[0].cloneNode(true)]);
}

function captureProtos() {
  for (const container of document.querySelectorAll('[data-list], [data-plan-features]')) {
    captureProto(container);
  }
}

function protoFor(container, kind) {
  // A container that did not exist when the page booted — the feature list
  // inside a package the owner added — takes its prototype from the clone it
  // arrived as, which is the same markup by construction.
  if (!prototypes.has(container)) captureProto(container);
  const stored = prototypes.get(container);
  if (!stored) return null;
  if (Array.isArray(stored)) return stored[0];
  return stored[kind] || stored.desktop;
}

/**
 * Reconcile a list against an array: fill the items that are already there,
 * clone the prototype for the ones that are not, and remove what is left over.
 * In-place and in order, so a list the document did not change is a list every
 * node of which is compared and none of which is replaced.
 */
function renderList(container, items, fill, kindOf) {
  if (!container) return;
  const kids = [...container.children].filter((node) => node.tagName !== 'TEMPLATE');
  items.forEach((item, index) => {
    const wanted = protoFor(container, kindOf ? kindOf(item) : null);
    let node = kids[index];
    if (!node) {
      node = wanted.cloneNode(true);
      container.appendChild(node);
    } else if (kindOf && wanted && node.className !== wanted.className) {
      // The owner turned a window into a phone. Same list, different shape.
      const fresh = wanted.cloneNode(true);
      node.replaceWith(fresh);
      node = fresh;
    }
    fill(node, item, index);
  });
  for (let i = items.length; i < kids.length; i += 1) kids[i].remove();
  setHidden(container, items.length === 0);
}

/**
 * The `data-t-item` bindings inside one list item. `data-t-item="title"` reads
 * the item's `title`; a bare `data-t-item` reads the item itself, which is
 * what a list of plain lines (the trust strip, "in every package") is.
 * Bindings inside a NESTED list belong to that list and are skipped here.
 */
function fillItem(node, item) {
  for (const target of node.querySelectorAll('[data-t-item]')) {
    // A binding inside a list NESTED in this one belongs to that list, and is
    // filled when that list is rendered — a package's features are rendered
    // from the package's own array, not from the package. The test is which
    // side of `node` the nested list is on: inside it, skip; around it (which
    // is what a feature line sees), fill.
    const nested = target.closest('[data-plan-features]');
    if (nested && nested !== node && node.contains(nested)) continue;
    const key = target.getAttribute('data-t-item');
    setTextOrHide(target, text(key ? item?.[key] : item, language));
  }
}

// =========================================================================
// THE SECTIONS
// =========================================================================

/**
 * A section is off when the owner switched it off, and off when the list that
 * is the point of it is empty. Off means `hidden`, which on this page means
 * `display: none` — no heading, no box, no gap where it used to be.
 */
function showSection(name, on) {
  setHidden(document.querySelector(`[data-sec="${name}"]`), !on);
}

const enabled = (section) => section?.enabled !== false;

function renderHero() {
  renderList(document.querySelector('[data-list="hero.trust"]'), pairs(doc.hero?.trust), fillItem);

  const image = document.querySelector('[data-hero-image]');
  if (image) {
    const fallback = `/kj/shots/pos-${language}.webp`;
    const custom = safeAsset(doc.hero?.image);
    const wanted = custom || fallback;
    // The frame around the hero is a BROWSER WINDOW — three dots and a title
    // bar — and that is honest around a screen capture and a lie around a
    // photograph of a shop counter, which is what the copy asks the owner to
    // upload here. The moment he uploads one, the window chrome goes.
    setClass(document.querySelector('.hero-shot'), 'is-photo', Boolean(custom));
    if (image.getAttribute('src') !== wanted) {
      // A slot the owner filled and then deleted, or an upload the control
      // plane no longer has, must not leave a broken picture on the page.
      image.onerror = () => {
        image.onerror = null;
        setClass(document.querySelector('.hero-shot'), 'is-photo', false);
        setAttr(image, 'src', fallback);
      };
      setAttr(image, 'src', wanted);
    }
  }
}

function renderOverview() {
  renderList(document.querySelector('[data-list="overview.blocks"]'), list(doc.overview?.blocks), (node, item) => {
    fillItem(node, item);
    const use = node.querySelector('[data-block-icon]');
    const icon = ICONS.has(item.icon) ? item.icon : 'till';
    setAttr(use, 'href', `#i-${icon}`);
  });
}

function renderSteps() {
  const items = list(doc.steps?.items);
  showSection('steps', enabled(doc.steps) && items.length > 0);
  renderList(document.querySelector('[data-list="steps.items"]'), items, (node, item, index) => {
    fillItem(node, item);
    setText(node.querySelector('[data-step-num]'), number(index + 1, language));
  });
}

function renderAudience() {
  const yes = pairs(doc.audience?.yes);
  const no = pairs(doc.audience?.no);
  showSection('audience', enabled(doc.audience) && (yes.length > 0 || no.length > 0));
  renderList(document.querySelector('[data-list="audience.yes"]'), yes, fillItem);
  renderList(document.querySelector('[data-list="audience.no"]'), no, fillItem);
  // A column with nothing in it is a heading over a void.
  setHidden(document.querySelector('.aud-yes'), yes.length === 0);
  setHidden(document.querySelector('.aud-no'), no.length === 0);
}

function renderVersus() {
  const rows = list(doc.versus?.rows);
  showSection('versus', enabled(doc.versus) && rows.length > 0);
  renderList(document.querySelector('[data-list="versus.rows"]'), rows, fillItem);
}

function renderPackages() {
  const items = list(doc.packages?.items);
  showSection('packages', items.length > 0);
  const currency = text(doc.packages?.currency, language);

  renderList(document.querySelector('[data-list="packages.items"]'), items, (card, item) => {
    fillItem(card, item);
    setAttr(card, 'data-plan', String(item.id ?? '').replace(/[^a-z0-9-]/gi, '') || null);

    const price = number(item.price, language);
    setText(card.querySelector('[data-plan-price]'), [price, currency].filter(Boolean).join(' '));

    // The recommendation says so with a class, not with different markup —
    // which is what lets any one of the three be the featured one.
    const featured = item.featured === true;
    setClass(card, 'plan-featured', featured);
    const cta = card.querySelector('.plan-cta');
    setClass(cta, 'btn-primary', featured);
    setClass(cta, 'btn-ghost', !featured);

    renderList(card.querySelector('[data-plan-features]'), pairs(item.features), fillItem);
  });

  const includedItems = pairs(doc.included?.items);
  showSection('included', enabled(doc.included) && includedItems.length > 0);
  renderList(document.querySelector('[data-list="included.items"]'), includedItems, fillItem);
}

function renderShots() {
  const items = list(doc.shots?.items).filter((item) => item.enabled !== false);
  showSection('shots', items.length > 0);

  renderList(
    document.querySelector('[data-list="shots.items"]'),
    items,
    (figure, item) => {
      fillItem(figure, item);
      const key = String(item.key ?? '').replace(/[^a-z0-9-]/gi, '');
      const image = figure.querySelector('img');
      if (!image) return;
      setAttr(image, 'data-shot', key || null);
      setAttr(image, 'data-custom', safeAsset(item.custom) || null);
      // The alt describes the picture; a slot with no description of its own
      // borrows its caption, which is truer than a description of the shot
      // that used to be in this position.
      const described = UI.alt[key] ? text(UI.alt[key], language) : text(item.caption, language);
      setAttr(image, 'alt', described);
      const fallback = key ? `/kj/shots/${key}-${language}.webp` : '';
      const wanted = safeAsset(item.custom) || fallback;
      if (wanted && image.getAttribute('src') !== wanted) {
        image.onerror = () => {
          image.onerror = null;
          if (fallback && wanted !== fallback) setAttr(image, 'src', fallback);
          else setHidden(figure, true);
        };
        setAttr(image, 'src', wanted);
      }
    },
    (item) => (item.kind === 'phone' ? 'phone' : 'desktop'),
  );
}

function renderQuotes() {
  const items = list(doc.quotes?.items);
  showSection('quotes', enabled(doc.quotes) && items.length > 0);
  renderList(document.querySelector('[data-list="quotes.items"]'), items, (node, item) => {
    fillItem(node, item);
    setTextOrHide(node.querySelector('[data-quote-name]'), String(item.name ?? '').trim());
    const where = [item.shop, item.city].map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ');
    setTextOrHide(node.querySelector('[data-quote-shop]'), where);
  });
}

function renderFaq() {
  const items = list(doc.faq?.items);
  showSection('faq', enabled(doc.faq) && items.length > 0);
  renderList(document.querySelector('[data-list="faq.items"]'), items, fillItem);
}

function renderClosing() {
  showSection('closing', enabled(doc.closing));
}

/**
 * The number, in every place it is a link. One field in the document drives
 * the header's WhatsApp button, all three contact cards, both contact buttons,
 * the closing band and the demo form's own action — change it in the console
 * and every one of them moves together, because every one of them is written
 * from here.
 */
function renderContact() {
  const phone = intlPhone(doc.contact?.phone);
  const whatsapp = intlPhone(doc.contact?.whatsapp);
  const email = safeEmail(doc.contact?.email);

  for (const node of document.querySelectorAll('[data-tel]')) {
    setAttr(node, 'href', phone ? `tel:+${phone}` : '#contact');
  }
  for (const node of document.querySelectorAll('[data-wa]')) {
    setAttr(node, 'href', whatsapp ? `https://wa.me/${whatsapp}` : '#contact');
  }
  for (const node of document.querySelectorAll('[data-mailto]')) {
    setAttr(node, 'href', email ? `mailto:${email}` : '#contact');
  }
  setAttr(document.querySelector('[data-wa-action]'), 'action',
    whatsapp ? `https://wa.me/${whatsapp}` : 'https://wa.me/');

  // The value ON the card is what the owner typed, not the dialling form:
  // an Egyptian shop owner reads his own number as 01552526142.
  setTextOrHide(document.querySelector('[data-val="phone"]'), String(doc.contact?.phone ?? '').trim());
  setTextOrHide(document.querySelector('[data-val="whatsapp"]'), String(doc.contact?.whatsapp ?? '').trim());
  setTextOrHide(document.querySelector('[data-val="email"]'), email);
}

function renderBrand() {
  const name = text(doc.brand?.name, language) || 'KJ';
  const logo = safeAsset(doc.brand?.logo);
  for (const image of document.querySelectorAll('[data-brand-logo]')) {
    const monogram = image.previousElementSibling;
    if (!logo) {
      setHidden(image, true);
      setHidden(monogram, false);
      continue;
    }
    if (image.getAttribute('src') !== logo) {
      image.onerror = () => { image.onerror = null; setHidden(image, true); setHidden(monogram, false); };
      setAttr(image, 'src', logo);
    }
    setHidden(image, false);
    setHidden(monogram, true);
  }
  setClass(document.documentElement, 'has-logo', Boolean(logo));
  return name;
}

/**
 * `dir` on `<html>` is the ONLY thing that mirrors this page. `kj.css` has no
 * `left`, no `right` and no `[dir=rtl]` block in it — every edge is written as
 * an inline-start or inline-end — so flipping this attribute is the whole
 * translation of the layout.
 */
function renderDocumentChrome() {
  const root = document.documentElement;
  if (root.lang !== language) root.lang = language;
  const dir = isRtl() ? 'rtl' : 'ltr';
  if (root.dir !== dir) root.dir = dir;

  const title = text(doc.seo?.title, language);
  const description = text(doc.seo?.description, language);
  if (document.title !== title) document.title = title;
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    setAttr(document.querySelector(selector), 'content', description);
  }
  setAttr(document.querySelector('meta[property="og:title"]'), 'content', title);
  setAttr(document.querySelector('meta[property="og:locale"]'), 'content', isRtl() ? 'ar_EG' : 'en_US');
}

// =========================================================================
// THE RENDER
// =========================================================================

/**
 * One pass. Lists first, so a clone the document asked for exists before the
 * plain strings are painted into it, then every `data-t` on the page.
 */
function render() {
  const root = { ...doc, ui: UI };

  renderHero();
  renderOverview();
  renderSteps();
  renderAudience();
  renderVersus();
  renderPackages();
  renderShots();
  renderQuotes();
  renderFaq();
  renderClosing();
  renderContact();

  const name = renderBrand();
  renderDocumentChrome();

  // The words. Four attributes, because a page has four kinds of string in
  // it: the words you read, the alt text you hear instead of a picture, the
  // label a control announces itself with, and the ghost text in a field.
  for (const node of document.querySelectorAll('[data-t]')) {
    setText(node, text(pick(root, node.getAttribute('data-t')), language));
  }
  for (const node of document.querySelectorAll('[data-t-alt]')) {
    setAttr(node, 'alt', text(pick(root, node.getAttribute('data-t-alt')), language));
  }
  for (const node of document.querySelectorAll('[data-t-label]')) {
    setAttr(node, 'aria-label', text(pick(root, node.getAttribute('data-t-label')), language));
  }
  for (const node of document.querySelectorAll('[data-t-placeholder]')) {
    setAttr(node, 'placeholder', text(pick(root, node.getAttribute('data-t-placeholder')), language));
  }

  // The screenshots come in `-ar` / `-en` pairs and every pair is identical
  // in dimensions, so this swap cannot move anything on the page.
  for (const image of document.querySelectorAll('[data-shot]')) {
    const key = image.getAttribute('data-shot');
    const custom = image.dataset.custom;
    if (!custom && key) setAttr(image, 'src', `/kj/shots/${key}-${language}.webp`);
  }

  observeReveals();
  return name;
}

function setLanguage(next) {
  const value = next === 'en' ? 'en' : 'ar';
  if (value === language) return;
  language = value;
  try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage is a nicety */ }
  render();
}

function wireLanguageToggle() {
  const button = document.querySelector('[data-lang-toggle]');
  if (!button) return;
  button.hidden = false;
  button.addEventListener('click', () => setLanguage(isRtl() ? 'en' : 'ar'));
}

// =========================================================================
// THE FORM
// =========================================================================

/**
 * There is no backend behind this page and none is invented here.
 *
 * The form is a WhatsApp composer: it takes what the visitor typed, writes it
 * into a message addressed to the number IN THE DOCUMENT, and opens WhatsApp
 * with that message already in the box. Nothing is posted anywhere, no
 * third-party form service is called, and the visitor sends the message
 * themselves — which is also why the lead actually arrives instead of landing
 * in an inbox nobody owns.
 *
 * With this file gone the `<form>` still works: it is a plain GET to wa.me and
 * none of its fields carry a `name`, so an unenhanced submit opens the same
 * WhatsApp conversation — just empty. A form that silently does nothing would
 * be worse than no form; this one degrades to the WhatsApp button underneath.
 */
function wireDemoForm() {
  const form = document.querySelector('[data-demo-form]');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    const value = (id) => document.getElementById(id)?.value.trim() || '';
    // Every line below is built out of strings that are already on the page:
    // the button's own label, then each field's own label followed by what was
    // typed into it. An empty field contributes no line at all.
    const lines = [text(doc.demo?.button, language), ''];
    for (const [id, key] of [
      ['demo-name', 'name'],
      ['demo-phone', 'phone'],
      ['demo-shop-type', 'shopType'],
      ['demo-branches', 'branches'],
      ['demo-message', 'message'],
    ]) {
      const typed = value(id);
      if (typed) lines.push(`${text(doc.demo?.fields?.[key], language)}: ${typed}`);
    }
    // Nothing typed at all — let the plain GET through and open the chat.
    if (lines.length === 2) return;
    const whatsapp = intlPhone(doc.contact?.whatsapp);
    if (!whatsapp) return;
    event.preventDefault();
    window.open(
      `https://wa.me/${whatsapp}?text=${encodeURIComponent(lines.join('\n'))}`,
      '_blank',
      'noopener',
    );
  });
}

// =========================================================================
// REVEAL
// =========================================================================

/**
 * A section fading up as it arrives — and nothing else. It exists only when
 * this file runs (the attribute below is what arms the CSS), it is entirely
 * inside `prefers-reduced-motion: no-preference` in the sheet, and it never
 * hides anything permanently: an element that is not observed, or a browser
 * with no `IntersectionObserver`, keeps the page exactly as it is.
 *
 * `observeReveals` runs again after every render, because a card the document
 * added is a card nobody is watching yet — and an unwatched card in an armed
 * page would be a card that never fades in.
 */
let observer = null;
const watched = new WeakSet();

function observeReveals() {
  if (!observer) return;
  for (const target of document.querySelectorAll('[data-reveal]')) {
    if (watched.has(target) || target.dataset.reveal === 'in') continue;
    watched.add(target);
    observer.observe(target);
  }
}

function wireReveal() {
  if (!('IntersectionObserver' in window)) return;
  if (!document.querySelector('[data-reveal]')) return;
  document.documentElement.dataset.reveal = 'armed';
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.dataset.reveal = 'in';
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
  observeReveals();
}

// =========================================================================
// BOOT
// =========================================================================

/**
 * The palette, from the one hex in the document — the same function the
 * storefront paints a shop's colour with and the ERP previews it with, so
 * KJ's own page cannot derive its indigo differently from the product it is
 * selling. `brandTheme` normalises the hex itself, so a colour the owner
 * mistyped falls back rather than blanking the page.
 */
function paintTheme(name) {
  const accent = doc.brand?.accent;
  applyTheme(document.documentElement, { accent, dark: true });
  const monogram = (name || 'KJ').slice(0, 2).toUpperCase();
  setAttr(document.querySelector('link[rel="icon"]'), 'href', monogramFavicon(monogram, { accent, dark: true }));
}

captureProtos();
paintTheme(render());
wireLanguageToggle();
wireDemoForm();
wireReveal();

/**
 * And only now, over the top of a page that is already finished, whatever the
 * owner has edited. No spinner, no skeleton, no `await` before the first
 * paint: if this never answers, or answers with rubbish, the reader keeps the
 * page they already have.
 */
fetch(API, { cache: 'no-store', credentials: 'omit' })
  .then((response) => (response.ok ? response.json() : null))
  .then((stored) => {
    if (!isObject(stored)) return;
    doc = merge(DEFAULTS, stored);
    paintTheme(render());
  })
  .catch(() => { /* the page is already complete; there is nothing to report */ });
