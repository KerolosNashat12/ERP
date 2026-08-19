/**
 * The one-time password hand-off.
 *
 * Three callers, one dialog: a shop that was just created, a shop's admin
 * password reset, and a member of that shop's staff given a new password. The
 * server never stores any of them in the clear and never returns one again, so
 * this dialog is the only place that password will ever exist — which is why it
 * refuses to close on a stray backdrop click and why copying is one tap.
 *
 * A new shop needs one more thing than a password: the two addresses it now
 * answers at. The owner's next move after reading the password out is to send
 * somebody a link, and a link they have to go and find is a link they will type
 * from memory. Those URLs are the *server's*, never assembled here — passed in
 * with the create response, or asked for by slug if the caller did not have
 * them to hand.
 */
import { h, mount, modal, toast } from '../core/dom.js';
import api from '../core/api.js';
import { t } from '../core/i18n.js';
import { linkRow, copyText } from '../ui/page.js';
import { skLine } from '../ui/states.js';

/**
 * `{ slug, username, password, headline }`, with `adminUsername` /
 * `adminPassword` accepted as the names the tenant-creation call has always
 * used. `links` may be passed (the create response carries them) and are
 * otherwise fetched by slug; a caller already showing both links on the page
 * behind the dialog passes `withLinks: false` rather than repeating them.
 */
export function showOneTimePassword({
  slug, adminUsername, adminPassword, username, password, headline, links, withLinks = true,
}) {
  const account = username || adminUsername;
  const secret = password || adminPassword;
  const code = h('div', { class: 'otp-code', dir: 'ltr' }, secret);
  const linksHost = (links || withLinks) ? h('div', { class: 'stack', style: { gap: 'var(--s2)' } }) : null;

  if (linksHost) {
    if (links) mount(linksHost, linkNodes(links));
    else {
      // A placeholder the same height as the two rows it will become, so the
      // dialog does not grow under the hand that is about to press Copy.
      mount(linksHost, skLine('80%', 12), skLine('64%', 12));
      api.get(`/tenants/${slug}`)
        .then((tenant) => mount(linksHost, linkNodes(tenant.links, tenant.websiteEnabled)))
        .catch(() => linksHost.remove());
    }
  }

  const dialog = modal({
    title: t('oneTimePassword'),
    size: 'narrow',
    closeOnBackdrop: false,
    body: h('div', { class: 'otp-panel' },
      h('p', { class: 'muted small', style: { margin: 0 } }, headline),
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'small muted' }, `${t('tenant')}: `, h('span', { class: 'mono strong' }, slug)),
        h('div', { class: 'small muted' }, `${t('adminAccount')}: `, h('span', { class: 'mono strong' }, account))),
      code,
      h('div', { class: 'otp-warn' },
        h('span', { class: 'ico' }, '⚠'),
        h('span', {}, t('oneTimePasswordHint'))),
      linksHost
        ? h('div', { class: 'panel stack', style: { gap: 'var(--s2)' } },
          h('div', { class: 'small strong' }, t('createdLinksTitle')),
          linksHost)
        : null),
    footer: [
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (await copyText(secret)) { toast(t('copied')); return; }
          selectContents(code);
          toast(t('copyManually'), 'warn', 6000);
        },
      }, t('copyToClipboard')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => dialog.close() }, t('close')),
    ],
  });
  return dialog;
}

/** The ERP link and the storefront link, each with its copy button. */
function linkNodes(links = {}, websiteEnabled = true) {
  return [
    linkRow({ label: t('erpLink'), url: links.erp }),
    linkRow({
      label: t('storeLink'),
      url: links.shop,
      off: !websiteEnabled,
      title: websiteEnabled ? undefined : t('websiteOffHint'),
    }),
  ].filter((row) => row);
}

/**
 * The other way a tenant can come into being: an existing shop attached as it
 * is. There is no password to hand over, so showing the one-time-password
 * dialog with an empty slot would be worse than useless — this says what was
 * found instead, which is the reassurance the owner actually wants when the
 * database they just pointed at is the one their shop is running on.
 */
export function showAdoptionSummary({ slug, users, products, links }) {
  const linksHost = h('div', { class: 'stack', style: { gap: 'var(--s2)' } });
  if (links) mount(linksHost, linkNodes(links));
  else {
    mount(linksHost, skLine('80%', 12), skLine('64%', 12));
    api.get(`/tenants/${slug}`)
      .then((tenant) => mount(linksHost, linkNodes(tenant.links, tenant.websiteEnabled)))
      .catch(() => linksHost.remove());
  }

  const dialog = modal({
    title: t('tenantAdopted'),
    size: 'narrow',
    body: h('div', { class: 'otp-panel' },
      h('p', { class: 'muted small', style: { margin: 0 } }, t('tenantAdoptedHeadline')),
      h('div', { class: 'small muted' }, `${t('tenant')}: `, h('span', { class: 'mono strong' }, slug)),
      h('div', { class: 'small muted' }, t('adoptedFound')),
      h('div', { class: 'adopted-counts' },
        h('div', {}, h('b', {}, users), h('span', {}, t('usersStat'))),
        h('div', {}, h('b', {}, products), h('span', {}, t('productsStat')))),
      h('div', { class: 'otp-note' },
        h('span', { class: 'ico' }, '✓'),
        h('span', {}, t('tenantAdoptedBody'))),
      h('div', { class: 'panel stack', style: { gap: 'var(--s2)' } },
        h('div', { class: 'small strong' }, t('createdLinksTitle')),
        linksHost)),
    footer: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => dialog.close() }, t('close')),
    ],
  });
  return dialog;
}

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
