/**
 * Shared bits between "create tenant" and "manage tenant": the module list,
 * the slug rule (mirrors `TenantService.js`'s `SLUG_RE` / `RESERVED_SLUGS`
 * exactly, so a bad slug is caught before the round trip, not after), and
 * the module checkbox grid.
 */
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
 * Builds the shared fields (name EN/AR, modules, website switch, limits) used
 * by both the create dialog and the manage page. `slugField` is only present
 * when `withSlug` is true (create only — a slug never changes after creation).
 */
export function buildTenantFields(initial = {}, { withSlug = true, hostedControlPlane = false } = {}) {
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

  const moduleChecks = new Map();
  const moduleGrid = h('div', { class: 'checkbox-grid' },
    ...MODULE_KEYS.map((key) => {
      const checked = (initial.modules || []).includes(key);
      const box = checkboxInput({ label: t(key), checked });
      moduleChecks.set(key, box.querySelector('input'));
      return box;
    }));

  const websiteBox = checkboxInput({
    label: t('websiteEnabled'), checked: initial.websiteEnabled !== false,
  });

  const maxUsersInput = numberInput({ min: '0', value: initial.limits?.maxUsers || '', placeholder: '0' });
  const maxProductsInput = numberInput({ min: '0', value: initial.limits?.maxProducts || '', placeholder: '0' });

  const nodes = [
    h('div', { class: 'grid cols-2' },
      field({ label: `${t('nameEn')} *`, input: nameEnInput }),
      field({ label: t('nameAr'), input: nameArInput })),
    withSlug
      ? field({ label: `${t('slug')} *`, input: slugInput, hint: t('slugAuto') })
      : null,
    databaseChooser ? databaseChooser.node : null,
    field({ label: t('modules'), input: moduleGrid, hint: t('modulesHint') }),
    h('div', { class: 'grid cols-2' },
      field({ label: t('maxUsers'), input: maxUsersInput, hint: t('unlimitedHint') }),
      field({ label: t('maxProducts'), input: maxProductsInput, hint: t('unlimitedHint') })),
    h('div', { class: 'field' }, websiteBox, h('span', { class: 'hint' }, t('websiteEnabledHint'))),
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
 * The "where does this shop's data live?" choice, and the two fields the hosted
 * answer needs.
 *
 * On a hosted control plane the file option is offered but disabled rather than
 * hidden: an owner who has used this form on a shop PC should see why the
 * choice they remember is gone, not wonder where it went.
 *
 * The token field is `type="password"` because it is one — a bearer credential
 * for a whole shop's database, typed at a counter where other people can see
 * the screen. It is write-only from here on: the API returns whether one is
 * set, never the value.
 */
function buildDatabaseChooser(hostedControlPlane) {
  const modeSelect = selectInput({
    options: [
      { value: 'file', label: t('dataLocationFile') },
      { value: 'libsql', label: t('dataLocationHosted') },
    ],
    value: hostedControlPlane ? 'libsql' : 'file',
  });
  if (hostedControlPlane) {
    // A file on a host with no disk is not a worse choice, it is a broken one.
    modeSelect.querySelector('option[value="file"]').disabled = true;
  }

  const urlInput = textInput({ dir: 'ltr', autocomplete: 'off', placeholder: 'libsql://my-shop-owner.turso.io' });
  const tokenInput = passwordInput({ dir: 'ltr', placeholder: '••••••••••••' });
  let errorNode = null;

  const hostedFields = h('div', { class: 'stack' },
    field({ label: `${t('dbUrl')} *`, input: urlInput, hint: t('dbUrlHint') }),
    field({ label: t('dbToken'), input: tokenInput, hint: t('dbTokenHint') }));

  const hint = h('span', { class: 'hint' });
  const node = h('div', { class: 'field' },
    h('label', {}, t('dataLocation')),
    modeSelect,
    hint,
    hostedFields);

  function isHosted() {
    return modeSelect.value === 'libsql';
  }

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
    const hosted = isHosted();
    hostedFields.style.display = hosted ? '' : 'none';
    if (hostedControlPlane) hint.textContent = t('dataLocationHostedOnly');
    else hint.textContent = hosted ? t('dataLocationHostedHint') : t('dataLocationFileHint');
    if (!hosted) clearError();
  }

  modeSelect.addEventListener('change', sync);
  urlInput.addEventListener('input', clearError);
  sync();

  return {
    node,
    validate() {
      clearError();
      if (!isHosted()) return true;
      const url = urlInput.value.trim();
      if (!url) { showError(t('dbUrlRequired')); return false; }
      if (!DB_URL_RE.test(url)) { showError(t('dbUrlInvalid')); return false; }
      return true;
    },
    value() {
      if (!isHosted()) return { mode: 'file' };
      const token = tokenInput.value.trim();
      return { mode: 'libsql', url: urlInput.value.trim(), ...(token ? { authToken: token } : {}) };
    },
    showError,
  };
}
