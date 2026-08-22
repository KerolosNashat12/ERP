/**
 * The landing page's content document: what a valid one is, what a safe string
 * is, and how a stored one meets the defaults baked into the page.
 *
 * Nothing here touches a database or a request. It is imported by the service
 * that stores the document, by the routes that serve it, and by the tests —
 * which is the point: the rule that decides whether a value may be rendered
 * into a public page is written once, in one file, on both the read and the
 * write path.
 *
 * ── Validation is the security boundary ──────────────────────────────────────
 * This document is rendered into `/kj`, a page served to the internet with no
 * session. Whatever survives this file is what the page will draw, so the
 * guarantees have to hold here rather than in the browser:
 *
 *   - **Every string is text.** A string containing `<` or `>` is refused, not
 *     escaped. Escaping is a rendering decision that each of a dozen call sites
 *     can get wrong once; a value that cannot contain an angle bracket cannot
 *     open a tag no matter how it is rendered — `innerHTML` included. Control
 *     characters (and the two bidi *overrides*, which can silently reverse a
 *     price line) are stripped before that check, so nothing hides behind them.
 *     LRM/RLM are left alone: real bilingual copy needs them.
 *   - **A price is a number.** Finite, non-negative, capped, rounded to two
 *     decimals — never a formatted string. The page formats it in the reader's
 *     own numerals; a store that accepted "٣٬٥٠٠" would make that impossible.
 *   - **A colour is a hex colour**, normalised by the same `normalizeHexColor`
 *     the shops' branding uses, so a value that reaches a CSS custom property
 *     can only ever be `#rrggbb`.
 *   - **A URL field is never the owner's.** `brand.logo`, `hero.image` and
 *     `shots.items[].custom` are accepted on write and thrown away; on read the
 *     server mints them from its own asset table. There is therefore no input
 *     anywhere in this document that ends up in an `src`, so no `javascript:`,
 *     no `data:text/html`, and no off-site tracking pixel is expressible.
 *   - **Unknown keys are dropped**, not rejected: an older server must not 400
 *     a console that knows one more field than it does, and content it cannot
 *     validate must not be stored for the page to render.
 *
 * ── Partial by design ────────────────────────────────────────────────────────
 * Every field is optional. The defaults live in `public/kj/defaults.js`; the control
 * plane stores only what the owner actually changed. So this schema does not
 * describe a *complete* page — it describes which of a page's fields may be
 * present and what each one is allowed to hold.
 */
import { z } from 'zod';
import { normalizeHexColor } from '../shared/branding.js';

/** Bump only when the shape changes in a way an older page cannot render. */
export const DOCUMENT_VERSION = 1;

/**
 * A whole document, serialised, may not exceed this. The page is copy, not a
 * data store: a quarter of a megabyte is more Arabic and English prose than the
 * longest of these sections could hold, and the ceiling stops the control plane
 * from being used as one.
 */
export const MAX_DOCUMENT_BYTES = 256 * 1024;

/**
 * C0/C1 controls except tab and newline, plus U+202D/U+202E — the two bidi
 * *overrides*. An override can render "3500" as "0053" in a price row, which is
 * a content bug no reviewer would spot in the console's textarea.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202D\u202E]/g;

/** Anything that could begin a tag. See the header: refused, never escaped. */
const MARKUP = /[<>]/;

const text = (max = 2000) => z.string()
  .max(max, `Keep this under ${max} characters`)
  .transform((value) => value.replace(CONTROL_CHARS, '').trim())
  .refine((value) => !MARKUP.test(value), 'This is text, not HTML — remove the < and > characters');

/** Every text field on the page is a bilingual pair; either half may be absent. */
const pair = (max = 2000) => z.object({
  en: text(max).optional(),
  ar: text(max).optional(),
});

/**
 * A name that predates the bilingual rule — a person, a shop, a city in a
 * quote. The contract writes these as bare strings while insisting every text
 * field is a pair, so both are accepted and the page may render either.
 */
const nameOrPair = (max = 120) => z.union([text(max), pair(max)]);

const flag = z.boolean();

/**
 * An identifier this codebase chose: a package id, a screenshot key, an icon
 * name. Lower-cased and constrained to a slug because a screenshot key becomes
 * part of an asset slot and therefore part of a URL.
 */
const slug = (max = 32) => z.string()
  .trim()
  .toLowerCase()
  .regex(new RegExp(`^[a-z0-9][a-z0-9-]{0,${max - 1}}$`), 'Use lowercase letters, numbers and hyphens');

const price = z.number()
  .finite('A price must be a number')
  .min(0, 'A price cannot be negative')
  .max(1_000_000, 'That price looks like a mistake')
  .transform((value) => Math.round(value * 100) / 100);

const hexColor = z.string()
  .transform((value) => normalizeHexColor(value))
  .refine((value) => value !== null, 'Use a colour like #4f46e5');

/** Digits and the punctuation a phone number is written with, nothing else. */
const phone = z.string()
  .max(32)
  .transform((value) => value.replace(/[^\d+\-\s()]/g, '').trim());

const email = z.string()
  .max(200)
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[a-z]{2,}$/i.test(value),
    'That does not look like an email address');

/**
 * A field whose value this server mints and the owner may not set.
 *
 * Accepted rather than rejected so the console can PUT back the document it
 * was given (which carries the minted URLs) without having to strip them
 * first — and then discarded, so nothing an owner typed can ever reach an
 * `src` attribute. `undefined` disappears in `JSON.stringify`.
 */
const minted = z.unknown().transform(() => undefined);

const list = (item, max) => z.array(item).max(max, `That is more than ${max} entries`);

export const landingDocumentSchema = z.object({
  version: z.literal(DOCUMENT_VERSION).optional(),

  brand: z.object({
    name: pair(120).optional(),
    tagline: pair(300).optional(),
    accent: hexColor.optional(),
    logo: minted.optional(),
  }).optional(),

  contact: z.object({
    phone: phone.optional(),
    whatsapp: phone.optional(),
    email: email.optional(),
    hours: pair(200).optional(),
  }).optional(),

  seo: z.object({
    title: pair(200).optional(),
    description: pair(400).optional(),
  }).optional(),

  hero: z.object({
    eyebrow: pair(160).optional(),
    title: pair(300).optional(),
    subtitle: pair(600).optional(),
    primaryCta: pair(80).optional(),
    secondaryCta: pair(80).optional(),
    trust: list(pair(160), 8).optional(),
    image: minted.optional(),
  }).optional(),

  overview: z.object({
    title: pair(200).optional(),
    intro: pair(1200).optional(),
    blocks: list(z.object({
      icon: slug().optional(),
      title: pair(160).optional(),
      body: pair(1200).optional(),
    }), 12).optional(),
    closing: pair(1200).optional(),
  }).optional(),

  steps: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    note: pair(600).optional(),
    items: list(z.object({
      title: pair(160).optional(),
      body: pair(1200).optional(),
    }), 20).optional(),
  }).optional(),

  audience: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    yesTitle: pair(160).optional(),
    yes: list(pair(300), 20).optional(),
    noTitle: pair(160).optional(),
    no: list(pair(300), 20).optional(),
    closing: pair(600).optional(),
  }).optional(),

  versus: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    rows: list(z.object({
      before: pair(300).optional(),
      after: pair(300).optional(),
    }), 20).optional(),
  }).optional(),

  packages: z.object({
    title: pair(200).optional(),
    note: pair(600).optional(),
    reassure: pair(600).optional(),
    currency: pair(40).optional(),
    period: pair(40).optional(),
    items: list(z.object({
      id: slug().optional(),
      name: pair(80).optional(),
      price: price.optional(),
      badge: pair(40).nullable().optional(),
      featured: flag.optional(),
      oneLiner: pair(300).optional(),
      inherits: pair(200).nullable().optional(),
      features: list(pair(300), 40).optional(),
      cta: pair(80).optional(),
    }), 8).optional(),
  }).optional(),

  included: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    items: list(pair(300), 40).optional(),
  }).optional(),

  shots: z.object({
    title: pair(200).optional(),
    note: pair(600).optional(),
    items: list(z.object({
      key: slug().optional(),
      kind: z.enum(['desktop', 'phone']).optional(),
      caption: pair(300).optional(),
      enabled: flag.optional(),
      custom: minted.optional(),
    }), 32).optional(),
  }).optional(),

  quotes: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    items: list(z.object({
      quote: pair(600).optional(),
      name: nameOrPair(120).optional(),
      shop: nameOrPair(120).optional(),
      city: nameOrPair(120).optional(),
    }), 24).optional(),
  }).optional(),

  demo: z.object({
    title: pair(200).optional(),
    body: pair(1200).optional(),
    button: pair(80).optional(),
    small: pair(300).optional(),
    fields: z.object({
      name: pair(80).optional(),
      phone: pair(80).optional(),
      shopType: pair(80).optional(),
      branches: pair(80).optional(),
      message: pair(80).optional(),
    }).optional(),
  }).optional(),

  faq: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    items: list(z.object({
      q: pair(300).optional(),
      a: pair(2000).optional(),
    }), 40).optional(),
  }).optional(),

  closing: z.object({
    enabled: flag.optional(),
    title: pair(200).optional(),
    body: pair(1200).optional(),
    primaryCta: pair(80).optional(),
    secondaryCta: pair(80).optional(),
  }).optional(),

  footer: z.object({
    line: pair(300).optional(),
    madeIn: pair(120).optional(),
    rights: pair(300).optional(),
  }).optional(),
});

/**
 * Validate a candidate document.
 *
 * Returns `{ ok, document, issues }` rather than throwing, because the two
 * callers want opposite things from a failure: the owner's PUT wants the list
 * of problems to show him, and the public read wants to shrug and serve the
 * page. Neither wants an exception.
 *
 * The round trip through JSON is deliberate: it drops the `undefined`s the
 * minted-URL fields leave behind, so what comes back out is exactly what will
 * be stored.
 */
export function validateLandingDocument(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, document: null, issues: [{ path: '', message: 'The document must be an object' }] };
  }

  const result = landingDocumentSchema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      document: null,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const document = JSON.parse(JSON.stringify({ ...result.data, version: DOCUMENT_VERSION }));
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      document: null,
      issues: [{ path: '', message: `The page content is ${Math.round(bytes / 1024)} KB — the limit is ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB` }],
    };
  }
  return { ok: true, document, issues: [] };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * How a stored document meets the defaults baked into the page.
 *
 * **Objects deep-merge field by field. Arrays and scalars replace wholesale.**
 *
 * The case that decided it, and the reason the rule is worth stating rather
 * than assuming: the owner edits one package's price, and a later release adds
 * a seventh entry to the default FAQ.
 *
 *   - He edited `packages`, so `packages.items` is stored — the whole array,
 *     because a list is a list: its membership and its order are his. The price
 *     he typed is what the page shows.
 *   - He never touched `faq`, so nothing is stored under it and he gets the
 *     new default list, seventh entry included. A release can still ship copy
 *     to every deployment that has not overridden it.
 *   - Had he edited the FAQ too, he would keep his own six and NOT receive the
 *     seventh. That is the deliberate half of the trade: there is no position
 *     in a list somebody curated at which a new entry could be inserted without
 *     guessing, and a page that grows a section behind its owner's back — after
 *     he reviewed it — is worse than one that is a release behind.
 *
 * Everything else follows from the same rule. `packages.title` alone can be
 * overridden without freezing `packages.items`, because `packages` is an object
 * and only the field he changed is stored. `badge: null` erases a default
 * badge, because null is a value and replaces.
 */
export function mergeLandingDocument(defaults, stored) {
  if (stored === undefined) return defaults;
  if (!isPlainObject(defaults) || !isPlainObject(stored)) return stored;

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(value) && isPlainObject(defaults[key])
      ? mergeLandingDocument(defaults[key], value)
      : value;
  }
  return merged;
}

/**
 * Which top-level sections differ between two documents — the audit line's
 * whole content. See `LandingContentService.save`.
 */
export function changedSections(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.delete('version');
  const changed = [];
  for (const key of keys) {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}

export default {
  DOCUMENT_VERSION,
  MAX_DOCUMENT_BYTES,
  landingDocumentSchema,
  validateLandingDocument,
  mergeLandingDocument,
  changedSections,
};
