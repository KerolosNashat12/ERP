/**
 * KJ Admin has to know about every module the ERP has — الهدر included.
 *
 * ── The bug this file exists because of ──────────────────────────────────────
 * `MODULE_KEYS` in `public/platform/js/views/tenantForm.js` is the list of
 * switches the owner console draws when he opens a shop's settings. It is a
 * hand-written copy of `Object.keys(MODULES)` from `src/shared/permissions.js`,
 * because the console is browser code that cannot import a server module.
 *
 * Two modules shipped — wastage and trash — and that copy was not updated. The
 * server knew them, the ERP knew them, the entitlement ledger knew them, and
 * the one screen the owner uses to sell a module to a shop did not draw a box
 * for either. He found it himself, opened a shop's settings and said: الهدر
 * هنا مش باين اصلا.
 *
 * Nothing failed. No error, no 500, no red anywhere — the list was simply
 * short, which is the kind of bug a test has to catch because a person only
 * catches it by already knowing what should have been there.
 *
 * ── What is fenced here ──────────────────────────────────────────────────────
 *   1. every module the server defines has a switch in the console;
 *   2. the console offers nothing the server would refuse;
 *   3. every module has a NAME in both languages — an unlabelled checkbox is
 *      not much better than a missing one, and the console is bilingual.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
/*
 * The console's `tenantForm.js` pulls in its DOM helpers, and those attach one
 * keydown listener at module scope. Nothing here renders anything — the two
 * lists and the dictionary are what is under test — so the document is stubbed
 * to the three things that get touched on the way in, exactly as the ERP's own
 * i18n test does next door.
 */
globalThis.document = {
  documentElement: {},
  addEventListener() {},
  createElement: () => ({ append() {}, setAttribute() {}, style: {} }),
  getElementById: () => null,
};

const { MODULES } = await import('../src/shared/permissions.js');
const { MODULE_KEYS } = await import('../public/platform/js/views/tenantForm.js');
const { t, setLanguage } = await import('../public/platform/js/core/i18n.js');

test('every module the server knows can be switched on from KJ Admin', () => {
  const server = Object.keys(MODULES);
  const missing = server.filter((key) => !MODULE_KEYS.includes(key));
  assert.deepEqual(missing, [],
    `these modules exist but the console cannot sell them: ${missing.join(', ')}`);
});

test('and the console offers nothing the server would refuse', () => {
  const server = new Set(Object.keys(MODULES));
  const unknown = MODULE_KEYS.filter((key) => !server.has(key));
  assert.deepEqual(unknown, [],
    `the console draws switches for modules the server does not have: ${unknown.join(', ')}`);
});

test('every switch has a name, in both languages', () => {
  for (const language of ['en', 'ar']) {
    setLanguage(language);
    for (const key of MODULE_KEYS) {
      const label = t(key);
      assert.notEqual(label, key,
        `module "${key}" has no ${language} name in the console dictionary`);
      assert.ok(label.trim().length > 1, `module "${key}" has an empty ${language} name`);
    }
  }
  setLanguage('en');
});
