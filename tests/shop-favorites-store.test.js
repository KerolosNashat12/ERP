/**
 * The customer's side of the favourites list — `public/shop/js/core/favorites.js`.
 *
 * `shop-favorites.test.js` next door defends the SERVER's half of the same
 * feature: what `GET /api/shop/products?ids=…` is allowed to answer. This file
 * defends what the browser is allowed to do with that answer, which is the
 * half that can destroy something. There is no account behind this list. It is
 * a row of ids in one browser's `localStorage`, it is the only copy that
 * exists, and if the page deletes it there is nothing to restore it from.
 *
 * So the rule under test is narrow on purpose: the lookup is allowed to prune
 * exactly the ids it ASKED about and got no answer for, and nothing else, ever.
 * A request that failed, a body that was not a list of rows, an id hearted in
 * another tab while the request was in flight — none of those is evidence that
 * a product was unpublished, and every one of them would otherwise arrive here
 * looking like an empty answer.
 *
 * The module is browser code with no build step, so it is imported as-is and
 * the three things it touches on `window` are stubbed. That is the point: this
 * runs the file the browser actually loads, not a copy of its logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Enough of `localStorage` to be written to, read back and thrown by. */
class MemoryStorage {
  #map = new Map();

  getItem(key) { return this.#map.has(key) ? this.#map.get(key) : null; }

  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.#map.set(key, String(value));
  }

  removeItem(key) { this.#map.delete(key); }
}

const storage = new MemoryStorage();
const storageListeners = [];

// Set before the import below, because `favorites.js` reads `apiBase()` and
// `localStorage` while it is still evaluating.
globalThis.window = {
  location: { pathname: '/shop/', origin: 'http://127.0.0.1' },
  localStorage: storage,
  addEventListener: (type, fn) => { if (type === 'storage') storageListeners.push(fn); },
};

const KEY = 'mm.shop.favorites.v1:/';
const favorites = await import('../public/shop/js/core/favorites.js');

/** Put a list into storage and make the module re-read it, as a fresh tab would. */
function given(ids) {
  storage.setItem(KEY, JSON.stringify(ids));
  // `key: null` is "the whole store changed", which the module treats as ours.
  storageListeners.forEach((fn) => fn({ key: null }));
  assert.deepEqual(favorites.list(), ids, 'fixture did not load');
}

const stored = () => JSON.parse(storage.getItem(KEY));

test('the favourites list a shopper carries', async (t) => {
  await t.test('reconcile drops what the shop no longer publishes', () => {
    given([5, 6, 7]);
    // 6 did not come back: unpublished, deleted, or its brand taken down.
    const dropped = favorites.reconcile([5, 6, 7], [5, 7]);
    assert.deepEqual(dropped, [6]);
    assert.deepEqual(favorites.list(), [5, 7]);
    // And it is gone from storage, not just from memory — the whole point is
    // that the customer stops carrying a dead id on every future visit.
    assert.deepEqual(stored(), [5, 7]);
  });

  await t.test('the customer\'s own order survives the pruning', () => {
    given([9, 4, 1, 7]);
    favorites.reconcile([9, 4, 1, 7], [1, 9]);
    assert.deepEqual(favorites.list(), [9, 1]);
  });

  await t.test('an id nobody asked about is not an id anybody answered for', () => {
    // The second tab case, and the reason `reconcile` takes two lists rather
    // than one: 8 was hearted somewhere else while this page's request was in
    // flight, so it arrived in the list after the request left and the shop was
    // never asked whether it exists.
    given([5, 6]);
    favorites.reconcile([5, 6], [5, 6]);
    given([8, 5, 6]);
    const dropped = favorites.reconcile([5, 6], [5]);
    assert.deepEqual(dropped, [6]);
    assert.deepEqual(favorites.list(), [8, 5], 'an unasked id must survive');
  });

  await t.test('nothing missing means no write and no change fired', () => {
    given([2, 3]);
    let fired = 0;
    const off = favorites.onChange(() => { fired += 1; });
    const dropped = favorites.reconcile([2, 3], [3, 2]);
    off();
    assert.deepEqual(dropped, []);
    assert.equal(fired, 0, 'a no-op reconcile must not tell the whole page it changed');
    assert.deepEqual(favorites.list(), [2, 3]);
  });

  await t.test('a reconcile that prunes fires exactly one change', () => {
    given([2, 3, 4]);
    const seen = [];
    const off = favorites.onChange((next) => seen.push(next));
    favorites.reconcile([2, 3, 4], [2]);
    off();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], [2]);
  });

  // ------------------------------------------------- the rule that matters

  await t.test('an answer that is not a list cannot empty the list', () => {
    // A fetch that rejected, a proxy's HTML error page, an older API, a future
    // change to the payload shape. Every one of them reaches a caller holding
    // something that is not an array of rows, and every one of them would wipe
    // a saved list if "no ids came back" were read as "none of them exist".
    for (const notAnAnswer of [undefined, null, '', 0, false, {}, { rows: [] }, 'ERROR']) {
      given([11, 12, 13]);
      const dropped = favorites.reconcile([11, 12, 13], notAnAnswer);
      assert.deepEqual(dropped, [], `found=${JSON.stringify(notAnAnswer)} must prune nothing`);
      assert.deepEqual(favorites.list(), [11, 12, 13]);
      assert.deepEqual(stored(), [11, 12, 13]);
    }
  });

  await t.test('a missing asked-list prunes nothing either', () => {
    given([11, 12]);
    assert.deepEqual(favorites.reconcile(undefined, []), []);
    assert.deepEqual(favorites.list(), [11, 12]);
  });

  await t.test('an honest empty answer is still allowed to empty the list', () => {
    // The other half of the rule, and it has to hold or the feature is a lie:
    // a shop that has taken down everything the customer saved really does owe
    // them an empty page, not three cards that 404.
    given([21, 22]);
    const dropped = favorites.reconcile([21, 22], []);
    assert.deepEqual(dropped, [21, 22]);
    assert.deepEqual(favorites.list(), []);
    assert.ok(favorites.isEmpty());
  });

  // ------------------------------------------------------------ undo

  await t.test('restore puts an id back where it was, not at the front', () => {
    given([31, 32, 33]);
    favorites.remove(32);
    assert.deepEqual(favorites.list(), [31, 33]);
    favorites.restore(32, 1);
    assert.deepEqual(favorites.list(), [31, 32, 33], 'undo must give back the list that was there');
    assert.deepEqual(stored(), [31, 32, 33]);
  });

  await t.test('add is not restore', () => {
    // The distinction the two functions exist for: `add` means "the shopper
    // just hearted this" and says so by putting it first; `restore` means
    // "that tap did not happen".
    given([31, 32, 33]);
    favorites.remove(33);
    favorites.add(33);
    assert.deepEqual(favorites.list(), [33, 31, 32]);
  });

  await t.test('restore survives a nonsense position rather than losing the id', () => {
    for (const index of [-4, 99, NaN, undefined, '1']) {
      given([41, 42]);
      favorites.remove(41);
      favorites.restore(41, index);
      assert.ok(favorites.has(41), `index=${String(index)} lost the id`);
      assert.equal(favorites.list().length, 2);
    }
  });

  await t.test('restoring something already there does not duplicate it', () => {
    given([51, 52]);
    favorites.restore(51, 1);
    assert.deepEqual(favorites.list(), [51, 52]);
  });

  await t.test('restore refuses what is not an id', () => {
    given([61]);
    for (const junk of [0, -1, 'abc', null, undefined, 1.5]) {
      assert.equal(favorites.restore(junk, 0), false, `${String(junk)} must not become a favourite`);
    }
    assert.deepEqual(favorites.list(), [61]);
  });

  // --------------------------------------------------------- storage is a nicety

  await t.test('a browser that refuses to write still shows the right page', () => {
    given([71, 72]);
    storage.failWrites = true;
    try {
      const seen = [];
      const off = favorites.onChange((next) => seen.push(next));
      const dropped = favorites.reconcile([71, 72], [71]);
      off();
      // The write threw; the change still happened for this page, which is the
      // smallest possible version of the failure — the list is only forgotten
      // on the next reload, and the shop does not break in front of a customer.
      assert.deepEqual(dropped, [72]);
      assert.deepEqual(favorites.list(), [71]);
      assert.deepEqual(seen, [[71]]);
    } finally {
      storage.failWrites = false;
    }
  });
});
