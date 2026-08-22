/**
 * Codes that arrive from the API, translated — `public/js/core/i18n.js`.
 *
 * The dictionary in that file is camelCase throughout. The API is not: it
 * sends a web order's status and a dashboard alert's kind the way they are
 * stored — `out_for_delivery`, `low_stock`. `t()`'s last resort is to return
 * the key it was given, so calling it with the raw code does not fail loudly;
 * it returns the code, and a screen renders `OUT_FOR_DELIVERY` looking for all
 * the world like a label somebody wrote badly. That is exactly how it survived
 * unnoticed in both languages until the web-orders screen was photographed for
 * the landing page.
 *
 * `tCode()` is the one conversion, and this file is the fence around it: every
 * code either half of the system actually sends must come back translated, in
 * BOTH languages, and a code nobody has written a word for yet must be caught
 * here rather than on a customer's screen.
 *
 * The module is browser code with no build step, so the three things it
 * touches on the document are stubbed and the real file is imported — the same
 * approach `shop-favorites-store.test.js` takes next door, and for the same
 * reason: this has to test the file the browser loads, not a copy of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { documentElement: {} };

const { t, tCode, setLanguage } = await import('../public/js/core/i18n.js');

/**
 * The codes the server really sends, taken from where it sends them:
 * `STATUSES` in public/js/views/webOrders.js, and the four `type:` values in
 * src/services/DashboardService.js. If either list grows, this one has to
 * grow with it — which is the point.
 */
const WEB_ORDER_STATUSES = ['pending', 'accepted', 'out_for_delivery', 'delivered', 'not_received', 'cancelled'];
const ALERT_TYPES = ['low_stock', 'overdue_receivables', 'promotions_expiring', 'late_deliveries'];
const CODES = [...WEB_ORDER_STATUSES, ...ALERT_TYPES];

/** A translation that is just the key back is a miss wearing a label's clothes. */
const translated = (code) => {
  const out = tCode(code);
  const camel = code.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return out && out !== code && out !== camel;
};

// The subtest context is `ctx`, not `t`: this file imports the dictionary's
// own `t()` and a parameter named `t` would shadow it.
test('API codes are translated, not printed', async (ctx) => {
  await ctx.test('every web-order status has English and Arabic', () => {
    for (const lang of ['en', 'ar']) {
      setLanguage(lang);
      for (const code of WEB_ORDER_STATUSES) {
        assert.ok(translated(code), `${code} has no ${lang} translation — it renders as the code`);
      }
    }
  });

  await ctx.test('every dashboard alert kind has English and Arabic', () => {
    for (const lang of ['en', 'ar']) {
      setLanguage(lang);
      for (const code of ALERT_TYPES) {
        assert.ok(translated(code), `${code} has no ${lang} translation — it renders as the code`);
      }
    }
  });

  await ctx.test('the two languages actually differ', () => {
    // Arabic and English returning the same string would mean the Arabic side
    // fell through to the English dictionary — a miss that `translated()`
    // above cannot see, because a fallback is a real word.
    for (const code of CODES) {
      setLanguage('en');
      const en = tCode(code);
      setLanguage('ar');
      const ar = tCode(code);
      assert.notEqual(ar, en, `${code} is the same in both languages — the Arabic is missing and falling back`);
    }
  });

  await ctx.test('snake_case becomes camelCase, and nothing else changes', () => {
    setLanguage('en');
    assert.equal(tCode('out_for_delivery'), t('outForDelivery'));
    assert.equal(tCode('low_stock'), t('lowStock'));
    // A code that is already one word is left exactly as it is.
    assert.equal(tCode('delivered'), t('delivered'));
  });

  await ctx.test('an unknown code still returns something printable', () => {
    setLanguage('ar');
    // Not a crash and not `undefined`: a code nobody has translated yet is a
    // gap to fix, but it must not take a screen down on the way.
    assert.equal(tCode('a_code_nobody_wrote'), 'aCodeNobodyWrote');
    assert.equal(tCode('a_code_nobody_wrote', 'fallback'), 'fallback');
    assert.equal(tCode(null), '');
    assert.equal(tCode(undefined), '');
  });
});
