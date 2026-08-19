/**
 * Shared bits between "create tenant" and "manage tenant": the module list,
 * the slug rule (mirrors `TenantService.js`'s `SLUG_RE` / `RESERVED_SLUGS`
 * exactly, so a bad slug is caught before the round trip, not after), and
 * the module checkbox grid.
 */
import { h, field, textInput, numberInput, checkboxInput } from '../core/dom.js';
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
export function buildTenantFields(initial = {}, { withSlug = true } = {}) {
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
      return out;
    },
    setServerErrors(details = []) {
      // Server validation (zod / TenantService) reports `path` in camelCase
      // matching these same field names — reuse the same error-text slot.
      for (const detail of details) {
        if (detail.path === 'slug' && slugInput) {
          slugError = detail.message;
          slugInput.closest('.field')?.classList.add('error');
          slugInput.closest('.field')?.append(h('span', { class: 'error-text' }, detail.message));
        }
      }
    },
  };
}
