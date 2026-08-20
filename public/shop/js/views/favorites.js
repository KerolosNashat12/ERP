/**
 * المفضلة — the pieces this browser has hearted.
 *
 * There are no accounts on this shop, so the list is a row of product ids in
 * `localStorage` and nothing else (see core/favorites.js). Ids are not a
 * catalogue: a price moves, the last one sells, the shop takes a piece down —
 * so this page never renders from memory. It turns the ids back into live
 * cards through `api.productsByIds()` on every visit, which is also the only
 * gate that can tell a published product from an unpublished one, and then
 * writes the answer back into the list.
 */
import { el, fill, ICONS } from '../core/dom.js';
import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { href } from '../core/router.js';
import { setPageMeta } from '../core/seo.js';
import * as favorites from '../core/favorites.js';
import { productCard } from '../ui/cards.js';
import { skeletonGrid, emptyState, errorState, toast } from '../ui/states.js';

/**
 * Empty is not an error and it is not a dead end: the heart says what this page
 * is for, the sentence says how to fill it, and the button goes where the
 * things to heart actually are.
 */
const nothingSaved = () => emptyState({
  glyph: ICONS.heart,
  title: t('favoritesEmptyTitle'),
  body: t('favoritesEmptyBody'),
  action: el('a.btn.btn-primary', { href: href('products') }, t('allProducts')),
});

export default async function favoritesView(root) {
  setPageMeta({ title: t('yourFavorites') });

  const note = el('p.page-note.muted');
  const head = el('div', el('h1.page-title', t('yourFavorites')), note);
  const body = el('div');
  const holder = el('div.wrap.stack', head, body);
  root.append(holder);

  /** The ids as they stand right now — the request is built from these. */
  const asked = favorites.list();

  if (!asked.length) {
    note.remove();
    fill(body, nothingSaved());
    return undefined;
  }

  // As many placeholders as there are things being waited for, so the page does
  // not shrink from eight cards to three the moment the answer lands. Capped at
  // a screenful: a shopper with sixty favourites is waiting for one request
  // either way, and sixty sweeping placeholders is a lot of paint to spend on a
  // phone saying so.
  note.textContent = t('loading');
  fill(body, skeletonGrid(Math.min(asked.length, 12)));

  const again = () => { root.replaceChildren(); return favoritesView(root); };

  let answer;
  try {
    answer = await api.productsByIds(asked);
  } catch (error) {
    // NOTHING is reconciled here. A request that never arrived is not evidence
    // that a single product was unpublished — it is evidence of a tunnel, a
    // dropped 3G connection or a shop that is briefly down — and treating it
    // as an empty answer would delete the customer's whole saved list on the
    // strength of one failed fetch. The list is untouched and the button
    // retries the same lookup in place.
    note.remove();
    fill(body, errorState(error, again));
    return undefined;
  }

  /*
   * The same caution one step further in. A 200 whose body is not a list of
   * rows — a proxy's error page, an older API, a future change to the payload
   * — would otherwise read as "the shop confirmed none of them", which is the
   * one interpretation that destroys data. It is handled as the failure it is.
   */
  if (!Array.isArray(answer?.rows)) {
    note.remove();
    fill(body, errorState({ message: t('errorBody') }, again));
    return undefined;
  }

  const rows = answer.rows;

  /*
   * The write-back. Everything asked about and not answered for is gone, and
   * the customer's list says so from now on — `reconcile` will not touch an id
   * that was not on the request, so a heart tapped in another tab while this
   * was in flight survives.
   *
   * The customer is told, the same way the cart tells them when stock has moved
   * under a basket (`cartAdjusted` in views/cart.js). A list that silently
   * shrinks between two visits looks like a bug in the shop.
   */
  const dropped = favorites.reconcile(asked, rows.map((row) => row.id));
  if (dropped.length) toast(t('favoritesGone', dropped.length));

  if (!rows.length) {
    note.remove();
    fill(body, nothingSaved());
    return undefined;
  }

  note.textContent = t('productsFound', rows.length);

  /*
   * The cards, and a way back to each one's node. Un-hearting has to take a
   * card off THIS page — a filled grid with an empty heart in the corner of it
   * is a page arguing with itself — and it has to be able to put it back.
   */
  const order = rows.map((row) => row.id);
  const nodes = new Map(rows.map((row) => [row.id, productCard(row)]));
  const grid = el('div.grid', [...nodes.values()]);
  fill(body, grid);

  /** Re-insert a card at the position it was rendered in, not at the front. */
  function placeBack(id) {
    const node = nodes.get(id);
    if (!node || node.isConnected) return;
    node.classList.remove('is-leaving');
    // Undoing the LAST one: the page is showing the empty state by now, so the
    // grid has to come back before anything can be put into it.
    if (!grid.isConnected) {
      fill(body, grid);
      head.append(note);
    }
    const after = order.slice(order.indexOf(id) + 1)
      .map((next) => nodes.get(next))
      .find((candidate) => candidate && candidate.isConnected) || null;
    grid.insertBefore(node, after);
  }

  /*
   * Removal is a transition, not a disappearance. The card fades and shrinks
   * for a fifth of a second before it leaves the grid — long enough to read as
   * "that one went", short enough not to be a wait — and the node is detached
   * on a timer rather than on `transitionend`, so it still leaves for a
   * customer whose system has asked for no motion (shop.css switches every
   * transition off for them).
   */
  const LEAVE_MS = 220;
  function takeOff(id) {
    const node = nodes.get(id);
    if (!node || !node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => {
      // Undo may have arrived inside the animation and put it back.
      if (node.classList.contains('is-leaving')) node.remove();
      // The last one out: the page becomes the empty state rather than an
      // empty grid with a heading and a count of nothing over it.
      if (!grid.querySelector('.card')) {
        note.remove();
        fill(body, nothingSaved());
      }
    }, LEAVE_MS);
  }

  /*
   * A shadow copy of the list, so a change can be read as "which id left" —
   * `onChange` hands over the list as it now is, and the position an id used to
   * hold is the thing undo needs and the only place it still exists.
   */
  let known = favorites.list();

  const off = favorites.onChange((next) => {
    /*
     * The router is asked to run this on navigation (it is returned below), but
     * a view whose request outlives the navigation that started it never gets
     * its cleanup registered — see `render()` in core/router.js. So the
     * subscription also lets itself go the moment its page is off the document,
     * which needs nothing outside this file to be true.
     */
    if (!holder.isConnected) { off(); return; }

    const previous = known;
    known = next;
    // Both lists are narrowed to ids this page has a CARD for. An id hearted
    // somewhere else while this page is open — another tab, the header of a
    // product page behind it — has no card here and no row to build one from
    // without a second request; it is simply on the list, and it is on the page
    // the next time the page opens.
    const gone = previous.filter((id) => !next.includes(id) && nodes.has(id));
    const back = next.filter((id) => !previous.includes(id) && nodes.has(id));

    back.forEach(placeBack);
    gone.forEach(takeOff);

    /*
     * Is undo worth it? On a phone the heart is a 34px target in the corner of
     * a card the shopper is reaching past, and the cost of a mis-tap here is
     * losing something they liked enough to save, with no account and no
     * history to find it in again. So yes — and it is offered exactly where
     * the mistake was made, in the toast, for the few seconds it takes to
     * notice.
     *
     * Only for a single card: one heart is one tap, and `toast()` keeps one
     * toast at a time, so an undo offered for a batch would silently only undo
     * the last of them. Everything else just says what happened.
     */
    if (gone.length === 1) {
      const id = gone[0];
      const at = previous.indexOf(id);
      toast(t('favoriteRemoved'), el('button.toast-link', {
        type: 'button',
        // The node goes back FIRST and the list second: cards.js repaints
        // hearts that are in the document when the list changes, so a card
        // restored after the change would come back with an empty heart on it.
        onClick: () => { placeBack(id); favorites.restore(id, at); },
      }, t('undo')));
    } else if (gone.length) {
      toast(t('favoriteRemoved'));
    }

    // Counted off the LIST, not off the DOM: the card being taken off is still
    // on screen for the length of its animation, and the number over the page
    // must not lag a fifth of a second behind the thing it is counting.
    const left = next.filter((id) => nodes.has(id)).length;
    if (left) note.textContent = t('productsFound', left);
  });

  // Handed to the router, which calls it when the customer navigates away.
  return off;
}
