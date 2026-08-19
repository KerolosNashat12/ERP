/**
 * The shop's own mark, inside the shop's own back office.
 *
 * Staff open the ERP dozens of times a day; until now the sidebar said `M&M`
 * to every shop on the platform, which is the same bug as the storefront's
 * header, one screen further from the customer and therefore quieter and
 * longer-lived. `/api/session` carries the same `branding` block the
 * storefront's `/api/shop/config` does — deliberately, so that the till and
 * the website can never disagree about what a shop is called or what its mark
 * is — and everything here reads it and nothing here decides it.
 */
import { h } from './ui.js';
import { apiBase } from './api.js';
import { getLanguage } from './i18n.js';
import { session } from './store.js';
import { markFor, monogramFavicon } from '../../shared/brandTheme.js';

/** The monogram alone, for the places a logo image cannot be drawn. */
export const shopMonogram = () => markFor({ ...(session.branding || {}), logo: null }, getLanguage()).text || '';

/**
 * The mark itself.
 *
 * `markFor()` is the same function the storefront's header calls, so a shop
 * with no logo shows the same two letters in both places — and they are the
 * letters the SERVER derived from its name, because "the first letter of each
 * of the first two words" is a different operation in Arabic than in Latin and
 * deriving it twice would derive it differently.
 */
export function shopMark({ className = 'mark', logoClass = 'mark-logo' } = {}) {
  const mark = markFor(session.branding, getLanguage());
  if (mark.kind === 'logo') {
    // `branding.logo` is the storefront's own path; under `/t/<slug>` the ERP
    // has to ask this tenant for it, not the default one.
    const img = h('img', { class: logoClass, src: apiBase() + mark.src, alt: '' });
    // A logo removed in another tab, or a website switched off since this page
    // loaded: the sidebar falls back to the monogram rather than to a broken
    // image icon in the one place staff look at all day.
    img.addEventListener('error', () => {
      img.replaceWith(h('span', { class: className }, shopMonogram() || '·'));
    });
    return img;
  }
  return h('span', { class: className }, mark.text || '·');
}

/**
 * Repaint the mark wherever the shell is already showing it.
 *
 * The sidebar is built once at boot; a logo uploaded on the settings screen
 * would otherwise sit in the database while the staff kept looking at the old
 * mark until they reloaded. One node and the tab icon, not a re-render of the
 * shell — the settings form the user is typing into is inside it.
 */
export function refreshShopMark() {
  const holder = document.querySelector('.sidebar-brand');
  if (holder) holder.firstElementChild?.replaceWith(shopMark());
  applyShopIdentity();
}

/**
 * The browser tab: this shop's mark and this shop's name.
 *
 * Called before sign-in — `/api/session` needs no session precisely so that
 * the login screen can wear the right shop — and again once the settings have
 * loaded, where `company.name` is a better answer than the tenant row's.
 */
export function applyShopIdentity(tenantName = null) {
  const name = session.settings?.['company.name'] || tenantName;
  document.title = name ? `${name} — ERP` : 'ERP';

  const branding = session.branding;
  if (!branding) return;
  const mark = markFor(branding, getLanguage());
  let link = document.head.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'icon');
    document.head.append(link);
  }
  if (mark.kind === 'logo') {
    link.removeAttribute('type');
    link.setAttribute('href', apiBase() + mark.src);
  } else {
    // Drawn from the monogram and the shop's accent — there is no second
    // `favicon` slot to upload, by design: it is derived from the logo, and
    // from the name when there is no logo.
    link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', monogramFavicon(mark.text, { accent: branding.accent, dark: true }));
  }
}
