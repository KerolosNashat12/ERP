/**
 * SHOOT MODE — photograph a whole catalogue without losing your place.
 *
 * ── The problem this is for ────────────────────────────────────────────────
 * The owner has hundreds of products and almost no photographs, and he asked
 * four times for somebody to fetch them from the internet. They cannot be
 * fetched: the pictures of a named product belong to the brand that shot them,
 * and a generic stock bottle on a product page is worse than an empty frame —
 * a customer orders the thing in the picture and sends back the thing in the
 * box.
 *
 * So the answer has to be that HIS OWN photographs stop being expensive. The
 * cost was never the shooting, it was the navigation: open the products list,
 * find one without a picture, open it, scroll to the photo card, upload, go
 * back, remember where you were. Two hundred times.
 *
 * This is that loop, removed. One product on the screen, a button, and the
 * next one. Nothing to find, nothing to remember, nothing to scroll past.
 *
 * ── Why it is phone-first ──────────────────────────────────────────────────
 * The camera is on the phone and so is the shop. Every measurement here is for
 * a hand: one column, a photo button big enough to hit without looking, and
 * the product's name where a thumb is not covering it.
 *
 * ── The queue is loaded ONCE ───────────────────────────────────────────────
 * Ordered by brand server-side, so the walk follows the shelves. It is held in
 * memory and advanced locally rather than re-fetched after each upload,
 * because a list that re-sorted itself under somebody's thumb — every
 * photographed product vanishing and everything shuffling up — is the thing
 * that makes people lose their place. `remaining` is asked for once, at the
 * start; the counter then counts down from what this session has done.
 */
import api from '../core/api.js';
import {
  h, mount, spinner, toast, toastError,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { can } from '../core/store.js';
import { navigate } from '../core/router.js';
import { preparePhoto } from '../core/photo.js';
import { invalidate } from '../core/store.js';

export async function shootView(root) {
  if (!can('products.update')) {
    mount(root, h('div', { class: 'empty' }, t('noPermission')));
    return;
  }

  /** The queue, in shelf order. Loaded once — see the note at the top. */
  let queue = [];
  let index = 0;
  let done = 0;
  let remaining = 0;
  let busy = false;

  const host = h('div', { class: 'shoot' });
  mount(root, host);
  mount(host, spinner());

  try {
    const data = await api.get('/api/products/without-photos', { limit: 500 });
    queue = data.rows || [];
    remaining = data.remaining || queue.length;
  } catch (error) {
    mount(host, h('div', { class: 'empty' }, error.message));
    return;
  }

  /*
   * The file input lives OUTSIDE the redrawn area and is reused for every
   * product, so its identity survives a render. An input recreated on each
   * product would lose the tap that opened it on some browsers, and — the part
   * that actually bites — iOS keeps a reference to the element that opened the
   * sheet, so replacing it mid-flight drops the chosen file on the floor.
   *
   * No `capture` attribute. That one word makes the camera the ONLY source on
   * iOS, and half the point of this screen is that a photograph taken earlier
   * is as good as one taken now. See core/proof.js for the full note.
   */
  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    style: { display: 'none' },
    onchange: async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) await attach(file);
    },
  });

  async function attach(file) {
    const product = queue[index];
    if (!product || busy) return;
    busy = true;
    render();
    try {
      // The same preparation every other photograph in this ERP goes through:
      // rotation baked in from EXIF, scaled to something readable, re-encoded.
      // A shop's phone photo is 8MB and its connection is not.
      const photo = await preparePhoto(file);
      await api.post(`/api/products/${product.id}/images`, photo);
      done += 1;
      remaining = Math.max(0, remaining - 1);
      index += 1;
      invalidate('products');
      toast(t('shootSaved'), 'ok', 1400);
    } catch (error) {
      toastError(error);
    } finally {
      busy = false;
      render();
    }
  }

  const skip = () => {
    /*
     * Skipping moves PAST a product without marking it done — it stays in the
     * shop's real list of bare products, so the next run offers it again.
     * Anything else would quietly hide a product from the only screen that
     * knows it is missing a picture.
     */
    index += 1;
    render();
  };

  function progress() {
    const total = remaining + done;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h('div', { class: 'shoot-progress' },
      h('div', { class: 'shoot-bar' }, h('span', { style: { width: `${pct}%` } })),
      h('p', { class: 'muted small' },
        t('shootProgress')
          .replace('{done}', String(done))
          .replace('{total}', String(total))));
  }

  function render() {
    const product = queue[index];

    if (!product) {
      /*
       * Two different endings, and they are not the same news. Finishing the
       * loaded queue when the shop still has bare products means there are
       * more than this screen holds; finishing with nothing left means the
       * catalogue is photographed, which is worth saying out loud.
       */
      mount(host,
        h('div', { class: 'page-head' },
          h('div', {}, h('h2', {}, t('shootTitle'))),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => navigate('products') }, '‹ ' + t('back'))),
        h('div', { class: 'card' },
          h('div', { class: 'card-body' },
            h('h3', {}, remaining > 0 ? t('shootBatchDone') : t('shootAllDone')),
            h('p', { class: 'muted' }, remaining > 0
              ? t('shootMoreLeft').replace('{count}', String(remaining))
              : t('shootAllDoneNote')),
            done ? progress() : null,
            h('div', { class: 'row-actions', style: { marginTop: '14px' } },
              remaining > 0
                ? h('button', { class: 'btn primary', onclick: () => shootView(mount(root)) }, t('shootLoadMore'))
                : null,
              h('button', { class: 'btn', onclick: () => navigate('products') }, t('backToProducts'))))));
      return;
    }

    const brand = product.brand_id ? pick(product, 'brand') : t('shootNoBrand');

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, t('shootTitle')),
          h('p', {}, t('shootHint'))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => navigate('products') }, '‹ ' + t('back'))),

      progress(),

      h('div', { class: 'card shoot-card' },
        h('div', { class: 'card-body' },
          /*
           * The brand above the name, because the walk is by brand: the line
           * that tells somebody they are still in front of the same shelf is
           * the one that stops them wandering.
           */
          h('p', { class: 'shoot-brand' }, brand),
          h('h3', { class: 'shoot-name' }, pick(product, 'name')),
          h('p', { class: 'shoot-code mono muted' }, product.code),
          product.category_en ? h('p', { class: 'muted small' }, pick(product, 'category')) : null,
          !product.is_published
            ? h('p', { class: 'muted small' }, t('shootNotPublished'))
            : null,

          h('button', {
            class: 'btn primary shoot-shot',
            disabled: busy,
            onclick: () => picker.click(),
          }, busy ? t('shootSaving') : `📷 ${t('shootTakePhoto')}`),

          h('button', {
            class: 'btn ghost shoot-skip',
            disabled: busy,
            onclick: skip,
          }, t('shootSkip')))),

      picker);
  }

  render();
}

export default { shootView };
