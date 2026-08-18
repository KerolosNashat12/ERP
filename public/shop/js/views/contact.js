/**
 * تواصل معانا — every channel the shop switched on in `config.contact`, and
 * nothing else. Reachable even when the shop is closed for orders: a shop
 * that stopped selling online has not stopped wanting to hear from people.
 */
import { el, icon, ICONS } from '../core/dom.js';
import { t, getLanguage } from '../core/i18n.js';
import { setPageMeta } from '../core/seo.js';
import { shop } from '../core/store.js';
import { emptyState } from '../ui/states.js';

/** One channel: an icon, a label, and either plain text or a link. */
function row(iconPath, label, value, href) {
  const external = href && /^https?:/i.test(href);
  const content = href
    ? el('a.contact-value', {
      href,
      target: external ? '_blank' : null,
      rel: external ? 'noopener noreferrer' : null,
    }, value)
    : el('p.contact-value', value);
  return el('div.contact-row',
    el('span.contact-row-icon', icon(iconPath, { size: 19 })),
    el('div.contact-row-body', el('span.contact-row-label', label), content));
}

export default function contactView(root) {
  setPageMeta({ title: t('contactTitle'), description: t('contactIntro') });

  const contact = shop.config?.contact || {};
  const lang = getLanguage();
  const address = lang === 'ar' ? contact.address?.ar : contact.address?.en;
  const hours = lang === 'ar' ? contact.hours?.ar : contact.hours?.en;

  const rows = [];
  if (contact.email) rows.push(row(ICONS.mail, t('contactEmail'), contact.email, `mailto:${contact.email}`));
  if (contact.phone) rows.push(row(ICONS.phone, t('contactPhone'), contact.phone, `tel:${contact.phone}`));
  if (contact.whatsapp) rows.push(row(ICONS.whatsapp, t('contactWhatsapp'), t('whatsappUs'), contact.whatsapp));
  if (address) rows.push(row(ICONS.pin, t('contactAddress'), address));
  if (hours) rows.push(row(ICONS.clock, t('contactHours'), hours));
  if (contact.mapUrl) rows.push(row(ICONS.map, t('contactMap'), t('contactMapCta'), contact.mapUrl));

  const wrap = el('div.wrap.stack.narrow',
    el('h1.page-title', t('contactTitle')),
    el('p.page-note.muted', t('contactIntro')),
    rows.length
      ? el('div.panel.contact-card', rows)
      : emptyState({ title: t('contactEmptyTitle'), body: t('contactEmptyBody') }));

  root.append(wrap);
}
