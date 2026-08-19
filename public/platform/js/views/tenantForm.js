/**
 * Shared bits between "create a shop" and the shop's own Settings tab: the
 * module list, the slug rule (mirrors `TenantService.js`'s `SLUG_RE` /
 * `RESERVED_SLUGS` exactly, so a bad slug is caught before the round trip, not
 * after), and the question of where the shop's data lives.
 *
 * The shape of the create form is the point of it: an owner opening a shop
 * types a name. The slug is suggested from that name, the database is made by
 * the server, and everything else — modules, limits, the storefront switch —
 * has a sensible default and is folded away behind one line. The same builder
 * draws the Settings tab with the fold opened out, because there the modules
 * and the limits *are* the screen.
 */
import api from '../core/api.js';
import {
  h, field, textInput, numberInput, checkboxInput, passwordInput, selectInput,
} from '../core/dom.js';
import { t } from '../core/i18n.js';

// Exactly `Object.keys(MODULES)` from `src/shared/permissions.js` — the only
// module names the server will ever accept.
export const MODULE_KEYS = [
  'dashboard', 'suppliers', 'brands', 'categories', 'attributes', 'products',
  'inventory', 'purchases', 'customers', 'sales', 'promotions', 'reports',
  'users', 'audit', 'settings', 'labels', 'weborders',
];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED_SLUGS = new Set(['api', 'platform', 't', 'shop', 'admin', 'assets', 'static']);

// Mirrors `DATABASE_URL_RE` in `src/platform/TenantService.js` exactly, the
// same way `SLUG_RE` above mirrors the server's — a form that rejects what the
// server would accept is its own kind of bug. `file:` is in it because the
// driver treats a local libSQL database like a remote one; it is deliberately
// not mentioned in the hint or the error, because on a hosted deployment it is
// never the answer and suggesting it would send someone down a dead end.
const DB_URL_RE = /^(libsql:\/\/|https:\/\/|file:)/i;

/** Mirrors the server's `assertValidSlug` — same rule, same rejection, before the network call. */
export function validateSlug(slug) {
  if (!slug) return t('slugRequired');
  if (!SLUG_RE.test(slug)) return t('slugInvalid');
  if (RESERVED_SLUGS.has(slug)) return t('slugReserved', { slug });
  return null;
}

export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31)
    .replace(/-+$/g, '') || '';
}

/**
 * What this deployment can do, asked once per session.
 *
 * Deliberately not fetched when this module loads: the console imports every
 * view at boot, including before anyone has signed in, and a 401 from a
 * speculative probe would drop the app back to the sign-in screen. It is asked
 * the first time a form that needs the answer is built, and a probe that fails
 * assumes the conservative answer — no automatic database — so the owner is
 * offered the path that always works rather than one that may not.
 */
let environmentPromise = null;
export function platformEnvironment() {
  if (!environmentPromise) {
    environmentPromise = api.get('/environment')
      .catch(() => ({ hostedControlPlane: false, canProvision: false }));
  }
  return environmentPromise;
}

/**
 * The one word in a sentence that is a thing to be typed, set in the console's
 * monospace so it can be picked out of a line of Arabic prose and copied
 * correctly — a variable name half-remembered is a variable name misspelt.
 */
function withMono(sentence, token) {
  const [before, ...rest] = String(sentence).split(token);
  if (!rest.length) return sentence;
  return [before, h('span', { class: 'mono strong', dir: 'ltr' }, token), rest.join(token)];
}

/**
 * A folded block. `<details>` is the only honest "there is more here" control
 * that works without script, and `.chart-table` is the console's one styling
 * for it (the muted summary with its +/− marker) — reused rather than
 * re-invented under a second name.
 */
const fold = (summary, ...body) => h('details', { class: 'chart-table' },
  h('summary', {}, summary),
  h('div', { class: 'stack' }, ...body));

/**
 * Builds the shared fields (name EN/AR, modules, website switch, limits) used
 * by both the create dialog and the Settings tab. `slugField` is only present
 * when `withSlug` is true (create only — a slug never changes after creation),
 * and `withSlug` is also what decides whether the secondary fields are folded.
 */
export function buildTenantFields(initial = {}, {
  withSlug = true, hostedControlPlane = false, foldAdvanced = withSlug,
} = {}) {
  const nameEnInput = textInput({ value: initial.nameEn || '' });
  const nameArInput = textInput({ value: initial.nameAr || '', dir: 'rtl' });

  let slugInput = null;
  let slugTouched = false;
  let slugError = null;
  let slugErrorNode = null;

  if (withSlug) {
    slugInput = textInput({ value: initial.slug || '', dir: 'ltr', autocomplete: 'off' });
    slugInput.addEventListener('input', () => { slugTouched = true; validateSlugField(); });
    nameEnInput.addEventListener('input', () => {
      if (slugTouched) return;
      slugInput.value = slugify(nameEnInput.value);
      validateSlugField();
    });
  }

  function validateSlugField() {
    if (!slugInput) return true;
    slugError = validateSlug(slugInput.value.trim());
    slugInput.closest('.field')?.classList.toggle('error', Boolean(slugError));
    if (slugErrorNode) slugErrorNode.remove();
    if (slugError) {
      slugErrorNode = h('span', { class: 'error-text' }, slugError);
      slugInput.closest('.field')?.append(slugErrorNode);
    }
    return !slugError;
  }

  // Where the shop's data lives. Only asked on creation: an existing tenant's
  // database cannot be swapped from this form, because moving a live shop from
  // one database to another is a migration, not a field edit.
  const databaseChooser = withSlug ? buildDatabaseChooser(hostedControlPlane) : null;

  /**
   * A brand-new shop gets every module. The server stores exactly what this
   * form sends and defaults to nothing, so an unticked grid would open a shop
   * whose sidebar is empty — the opposite of what an owner who typed a name
   * and pressed Create meant.
   */
  const initialModules = initial.modules || (withSlug ? MODULE_KEYS : []);

  const moduleChecks = new Map();
  const moduleGrid = h('div', { class: 'checkbox-grid' },
    ...MODULE_KEYS.map((key) => {
      const box = checkboxInput({ label: t(key), checked: initialModules.includes(key) });
      moduleChecks.set(key, box.querySelector('input'));
      return box;
    }));

  const websiteBox = checkboxInput({
    label: t('websiteEnabled'), checked: initial.websiteEnabled !== false,
  });

  const maxUsersInput = numberInput({ min: '0', value: initial.limits?.maxUsers || '', placeholder: '0' });
  const maxProductsInput = numberInput({ min: '0', value: initial.limits?.maxProducts || '', placeholder: '0' });

  const advanced = [
    field({ label: t('modules'), input: moduleGrid, hint: t('modulesHint') }),
    h('div', { class: 'grid cols-2' },
      field({ label: t('maxUsers'), input: maxUsersInput, hint: t('unlimitedHint') }),
      field({ label: t('maxProducts'), input: maxProductsInput, hint: t('unlimitedHint') })),
    h('div', { class: 'field' }, websiteBox, h('span', { class: 'hint' }, t('websiteEnabledHint'))),
  ];

  const nodes = [
    h('div', { class: 'grid cols-2' },
      field({ label: `${t('nameEn')} *`, input: nameEnInput }),
      field({ label: t('nameAr'), input: nameArInput })),
    withSlug
      ? field({ label: `${t('slug')} *`, input: slugInput, hint: t('slugAuto') })
      : null,
    databaseChooser ? databaseChooser.node : null,
    foldAdvanced
      ? fold(t('advancedOptions'), h('span', { class: 'hint' }, t('advancedHint')), ...advanced)
      : h('div', { class: 'stack' }, ...advanced),
  ];

  return {
    nodes,
    validate() {
      let ok = true;
      if (!nameEnInput.value.trim()) {
        ok = false;
        nameEnInput.closest('.field')?.classList.add('error');
        nameEnInput.closest('.field')?.append(h('span', { class: 'error-text' }, t('nameEnRequired')));
      }
      if (withSlug && !validateSlugField()) ok = false;
      if (databaseChooser && !databaseChooser.validate()) ok = false;
      return ok;
    },
    values() {
      const modules = MODULE_KEYS.filter((key) => moduleChecks.get(key).checked);
      const maxUsers = maxUsersInput.value === '' ? 0 : Number(maxUsersInput.value);
      const maxProducts = maxProductsInput.value === '' ? 0 : Number(maxProductsInput.value);
      const out = {
        nameEn: nameEnInput.value.trim(),
        nameAr: nameArInput.value.trim() || nameEnInput.value.trim(),
        modules,
        websiteEnabled: websiteBox.querySelector('input').checked,
        limits: { maxUsers, maxProducts },
      };
      if (withSlug) out.slug = slugInput.value.trim();
      if (databaseChooser) out.database = databaseChooser.value();
      return out;
    },
    setServerErrors(details = []) {
      // Server validation (zod / TenantService) reports `path` in camelCase
      // matching these same field names — reuse the same error-text slot.
      for (const detail of details) {
        if (detail.path.startsWith('database') && databaseChooser) {
          databaseChooser.showError(detail.message);
        }
        if (detail.path === 'slug' && slugInput) {
          slugError = detail.message;
          slugInput.closest('.field')?.classList.add('error');
          slugInput.closest('.field')?.append(h('span', { class: 'error-text' }, detail.message));
        }
      }
    },
  };
}

/**
 * "Where does this shop's data live?" — one question with a default the owner
 * should never have to touch.
 *
 * When the server says it can provision, **Create a database for me** is the
 * answer and the URL and token fields do not exist on the page at all: an
 * owner opening their fourth shop should type a name and press Create.
 *
 * When it says it cannot, the automatic option is still listed — disabled, with
 * one plain line naming `TURSO_API_TOKEN`, because "the option I remember is
 * gone" is a worse thing to hand somebody than "here is why it is greyed out".
 * The manual path stays exactly where it was, one choice away.
 *
 * The token field is `type="password"` because it is one — a bearer credential
 * for a whole shop's database, typed at a counter where other people can see
 * the screen. It is write-only from here on: the API returns whether one is
 * set, never the value.
 */
function buildDatabaseChooser(hostedControlPlane) {
  const modeSelect = selectInput({
    options: [
      { value: 'auto', label: t('dataLocationAuto') },
      { value: 'libsql', label: t('dataLocationExisting') },
      { value: 'file', label: t('dataLocationFile') },
    ],
    value: 'auto',
  });
  const optionFor = (value) => modeSelect.querySelector(`option[value="${value}"]`);

  const urlInput = textInput({ dir: 'ltr', autocomplete: 'off', placeholder: 'libsql://my-shop-owner.turso.io' });
  const tokenInput = passwordInput({ dir: 'ltr', placeholder: '••••••••••••' });
  let errorNode = null;

  const hostedFields = h('div', { class: 'stack' },
    field({ label: `${t('dbUrl')} *`, input: urlInput, hint: t('dbUrlHint') }),
    field({ label: t('dbToken'), input: tokenInput, hint: t('dbTokenHint') }));

  const hint = h('span', { class: 'hint' }, t('dataLocationChecking'));
  /**
   * The line that names what has to be configured. Plainly said and plainly
   * styled: nothing here has gone wrong, and an alarm-coloured box would tell
   * an owner that something had. It sits under the choice rather than inside
   * the hint so that it stays on the page when they switch to the manual path
   * and get on with their day.
   */
  const provisionNote = h('div', {
    class: 'small muted', style: { display: 'none', marginTop: 'var(--s1)' },
  }, withMono(t('dataLocationAutoOff'), 'TURSO_API_TOKEN'));

  const node = h('div', { class: 'field' },
    h('label', {}, t('dataLocation')),
    modeSelect,
    hint,
    provisionNote,
    hostedFields);

  // Until the probe answers, the automatic path is assumed and no fields are
  // shown — the common case, and the one that keeps the form from flickering
  // a URL box into existence and out again on every open.
  let canProvision = true;
  let hosted = hostedControlPlane;

  const isExisting = () => modeSelect.value === 'libsql';

  function clearError() {
    node.classList.remove('error');
    if (errorNode) { errorNode.remove(); errorNode = null; }
  }

  function showError(message) {
    clearError();
    node.classList.add('error');
    errorNode = h('span', { class: 'error-text' }, message);
    hint.after(errorNode);
  }

  function sync() {
    const existing = isExisting();
    hostedFields.style.display = existing ? '' : 'none';
    if (existing) hint.textContent = t('dataLocationHostedHint');
    else if (modeSelect.value === 'auto') hint.textContent = t('dataLocationAutoHint');
    else hint.textContent = hosted ? t('dataLocationHostedOnly') : t('dataLocationFileHint');
    if (!existing) clearError();
  }

  modeSelect.addEventListener('change', sync);
  urlInput.addEventListener('input', clearError);
  sync();

  platformEnvironment().then((environment) => {
    canProvision = Boolean(environment.canProvision);
    hosted = Boolean(environment.hostedControlPlane);
    // A file on a host with no disk of its own is not a worse choice, it is a
    // broken one.
    optionFor('file').disabled = hosted;
    optionFor('auto').disabled = !canProvision;
    provisionNote.style.display = canProvision ? 'none' : '';
    if (!canProvision) modeSelect.value = hosted ? 'libsql' : 'file';
    sync();
  });

  return {
    node,
    validate() {
      clearError();
      if (!isExisting()) return true;
      const url = urlInput.value.trim();
      if (!url) { showError(t('dbUrlRequired')); return false; }
      if (!DB_URL_RE.test(url)) { showError(t('dbUrlInvalid')); return false; }
      return true;
    },
    value() {
      if (modeSelect.value === 'auto') return { mode: 'auto' };
      if (modeSelect.value === 'file') return { mode: 'file' };
      const token = tokenInput.value.trim();
      return { mode: 'libsql', url: urlInput.value.trim(), ...(token ? { authToken: token } : {}) };
    },
    showError,
  };
}
