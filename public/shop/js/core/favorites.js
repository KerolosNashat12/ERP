/**
 * The favourites list — the hearts on the product cards, kept in
 * `localStorage` so a shopper who closes the tab still has them tomorrow.
 *
 * What is stored is ONLY a list of product ids, most recently added first.
 * Deliberately not a snapshot the way `cart.js` keeps one: a basket is a
 * decision the shopper has already made and has to be able to see instantly,
 * offline, at the price they agreed to. A favourite is a thing they might buy
 * later, and "later" is when the price changed, the last one sold, or the shop
 * took it down. So the page turns these ids back into live cards through
 * `api.productsByIds()` every time it opens, and a product that no longer comes
 * back is a product that is simply gone.
 */

import { apiBase } from './api.js';

/**
 * One key per SHOP, not one key per browser.
 *
 * This is a multi-tenant platform: `/t/hobelbanat/shop` and `/t/mm/shop` are
 * different shops served from the SAME origin, and `localStorage` is scoped to
 * the origin alone. A single `mm.shop.favorites` key would therefore mean a
 * clothes shop showing a customer the accessories they hearted somewhere else —
 * ids that belong to another shop's database entirely, so the cards would
 * resolve to that shop's products or to nothing at all.
 *
 * `apiBase()` is already how every request and every image URL on this page
 * learns which shop it is, so it is what scopes the key too: `''` for the
 * single-shop build, `/t/<slug>` on the platform. The `:` cannot appear in a
 * slug, so no two shops can ever collide on one key.
 */
const STORAGE_KEY = `mm.shop.favorites.v1:${apiBase() || '/'}`;

/**
 * Matches `MAX_IDS` in `StorefrontService` on purpose. The server will only
 * look up that many, so a client that allowed more would hand the customer a
 * list whose oldest entries silently never render — a heart they can see filled
 * on one screen and a card that never appears on another. Cutting here, where
 * it can be explained, is better than cutting there, where it cannot.
 */
const MAX_FAVORITES = 60;

const listeners = new Set();
let ids = load();

/**
 * Reading storage at all can throw, not just parsing it: iOS private browsing
 * has historically thrown on `localStorage` access, and a shop must not fail to
 * paint because a favourites list was unreadable. Anything unexpected — a
 * corrupt value, a value another script wrote, an older version of this file —
 * is treated as "no favourites yet" rather than as an error worth showing.
 */
function load() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return clean(parsed);
  } catch {
    return [];
  }
}

/** Whole positive ids, no duplicates, never longer than the cap. */
function clean(list) {
  const seen = new Set();
  for (const entry of list) {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0) continue;
    seen.add(id);
    if (seen.size >= MAX_FAVORITES) break;
  }
  return [...seen];
}

/**
 * Persist, then tell everyone.
 *
 * The write is allowed to fail and the change still stands for this page: a
 * full quota, a browser with storage switched off and Safari's private mode
 * (which throws on write, not on read) all end here, and none of them is a
 * reason for the heart the customer just tapped to spring back open. What is
 * lost is only the memory of it after a reload, which is the smallest possible
 * version of the failure.
 */
function save() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch { /* a full or disabled store must not break the shop */ }
  listeners.forEach((fn) => fn(list()));
}

/** The ids, most recently added first. A copy — callers must not edit ours. */
export const list = () => ids.slice();
export const count = () => ids.length;
export const has = (id) => ids.includes(Number(id));
export const isEmpty = () => ids.length === 0;

export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/**
 * Newest first, so the list reads in the order the shopper built it.
 *
 * Already-favourited is a no-op rather than a re-order: `add` is only ever
 * reached through a heart that is currently empty, so an id that is already
 * here means two views got out of step, and quietly rewriting the customer's
 * order — and firing a change nobody asked for — is the wrong answer to that.
 */
export function add(id) {
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId <= 0) return false;
  if (ids.includes(productId)) return true;

  ids.unshift(productId);
  // Past the cap the OLDEST goes. The shopper is looking at the one they just
  // added; the one they hearted months ago is the one they will miss least.
  if (ids.length > MAX_FAVORITES) ids.length = MAX_FAVORITES;
  save();
  return true;
}

export function remove(id) {
  const productId = Number(id);
  if (!ids.includes(productId)) return false;
  ids = ids.filter((entry) => entry !== productId);
  save();
  return false;
}

/** The heart. Returns the state it is now in, so the caller can paint it. */
export function toggle(id) {
  return has(id) ? remove(id) : add(id);
}

/**
 * Put an id back exactly where it was — the undo behind the toast on the
 * favourites page.
 *
 * Deliberately not `add()`. `add` means "the shopper has just hearted this",
 * and it says so by putting it at the front of the list; undo means "that tap
 * did not happen", and a list that comes back re-ordered is not the list the
 * shopper had. So the position is passed in by whoever remembered it, clamped
 * to something that exists, and an id that is somehow already back is left
 * alone rather than duplicated.
 */
export function restore(id, index = 0) {
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId <= 0) return false;
  if (ids.includes(productId)) return true;
  const wanted = Number(index);
  const at = Math.min(Math.max(Number.isFinite(wanted) ? Math.trunc(wanted) : 0, 0), ids.length);
  ids.splice(at, 0, productId);
  if (ids.length > MAX_FAVORITES) ids.length = MAX_FAVORITES;
  save();
  return true;
}

/**
 * The list, against what the shop actually still sells.
 *
 * A favourite is a memory, and the shop is the fact. `api.productsByIds()`
 * answers with the published products among the ids it was given, so an id
 * that does not come back is a product that has been unpublished, deleted, or
 * had its whole brand taken down — and leaving it in storage means the
 * customer carries a dead id for ever, silently spending one of their sixty
 * slots and one row of the server's lookup on every future visit.
 *
 * Two arguments, not one, and that is the whole safety of it:
 *
 *   `asked`  the ids that were actually sent on the request. NOTHING outside
 *            this set may be dropped, however the answer came back. The
 *            shopper can heart something in another tab while this request is
 *            in flight — `storage` brings that id into `ids` here — and it
 *            was never asked about, so it cannot have been answered for.
 *   `found`  the ids the shop confirmed.
 *
 * The caller must only reach this on a well-formed answer from the server. A
 * request that failed, timed out, or came back as something other than a list
 * of rows is not evidence that anything was unpublished — it is evidence of
 * nothing at all — and calling this with an empty `found` because a fetch
 * rejected would delete the customer's entire saved list on one flaky
 * connection. `views/favorites.js` is the only caller and it returns before
 * this line on every one of those paths.
 *
 * Returns the ids that were dropped, so the page can say so out loud.
 */
export function reconcile(asked, found) {
  /*
   * The caller's guard, said again here where it cannot be forgotten. Neither
   * argument being a real list means nobody actually answered — and "nobody
   * answered" must never be read as "the shop confirmed none of them", because
   * that reading empties the customer's saved list.
   */
  if (!Array.isArray(asked) || !Array.isArray(found)) return [];
  const askedSet = new Set(asked.map(Number));
  const foundSet = new Set(found.map(Number));
  const dropped = ids.filter((id) => askedSet.has(id) && !foundSet.has(id));
  if (!dropped.length) return [];
  ids = ids.filter((id) => !askedSet.has(id) || foundSet.has(id));
  save();
  return dropped;
}

export function clear() {
  if (!ids.length) return;
  ids = [];
  save();
}

/**
 * The same shop open in a second tab.
 *
 * Two tabs is normal on a phone — a product opened from search while the
 * favourites page sits behind it — and a heart filled in one of them has to
 * fill in the other, or the customer taps it twice and ends up with it off.
 * `storage` only fires in the OTHER tabs, so this can never loop back on the
 * tab that wrote the value.
 *
 * The key is checked because every key in the origin arrives here, including
 * the other shops on this platform: a favourite hearted at `/t/mm/shop` is not
 * a change to this shop's list. `key === null` is the whole store being
 * cleared (`localStorage.clear()`, or a browser clearing site data), which does
 * mean us.
 */
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  ids = load();
  listeners.forEach((fn) => fn(list()));
});
