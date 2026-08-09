/**
 * QR label printing.
 *
 * Label geometry comes from Settings → Devices, so the same code drives a
 * 40×30 thermal roll, a 30×20 jewellery tag or an A4 sticker sheet. Sizes are
 * expressed in millimetres and printed at true scale, which is what lets the
 * calibration offsets actually fix a misaligned printer.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, toast, toastError, numberInput, printNode, tag, spinner,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money } from '../core/format.js';
import { devices } from '../core/store.js';
import { navigate } from '../core/router.js';
import { variantPicker } from './pickers.js';

/**
 * The price must always fit on one line, so its type size steps down as the
 * text-column narrows or the number gets longer.
 */
function priceSize(label, cfg, base) {
  const text = `${label.currency} ${Number(label.price).toFixed(2)}`;
  const columnMm = Math.max(cfg.widthMm - cfg.qrSizeMm - 4, 8);
  // ~0.55mm of width per character at 1mm type.
  const fits = columnMm / (text.length * 0.55);
  return Math.max(Math.min(base * 1.35, fits), base * 0.8);
}

/** One printable label, sized from the device configuration. */
export function labelCard(label, cfg) {
  const ar = getLanguage() === 'ar';
  const name = ar ? (label.productNameAr || label.productNameEn) : label.productNameEn;
  // Type scales with the label so a 30×20 tag stays readable.
  const base = Math.max(Math.min(cfg.heightMm / 4.6, 3.2), 1.7);

  return h('div', {
    class: 'qr-label',
    style: {
      width: `${cfg.widthMm}mm`,
      height: `${cfg.heightMm}mm`,
      marginInlineEnd: `${cfg.gapMm}mm`,
      marginBlockEnd: `${cfg.gapMm}mm`,
      paddingInlineStart: `${Math.max(cfg.offsetXMm, 0) + 1}mm`,
      paddingBlockStart: `${Math.max(cfg.offsetYMm, 0) + 1}mm`,
      transform: (cfg.offsetXMm < 0 || cfg.offsetYMm < 0)
        ? `translate(${Math.min(cfg.offsetXMm, 0)}mm, ${Math.min(cfg.offsetYMm, 0)}mm)`
        : undefined,
    },
  },
  h('img', { src: label.qr, alt: label.barcode, style: { width: `${cfg.qrSizeMm}mm`, height: `${cfg.qrSizeMm}mm` } }),
  h('div', { class: 'info', style: { fontSize: `${base}mm`, lineHeight: 1.2 } },
    cfg.showShopName ? h('div', { class: 'shop', style: { fontSize: `${base * 0.8}mm` } }, label.company?.name || '') : null,
    cfg.showProductName ? h('div', { class: 'n' }, name) : null,
    cfg.showVariant && label.variantLabel ? h('div', { class: 'v' }, label.variantLabel) : null,
    cfg.showPrice
      ? h('div', { class: 'p', style: { fontSize: `${priceSize(label, cfg, base)}mm` } },
        `${label.currency} ${Number(label.price).toFixed(2)}`)
      : null,
    cfg.showSku ? h('div', { class: 's', style: { fontSize: `${base * 0.8}mm` } }, label.sku) : null));
}

/** A full sheet of labels ready to print. */
export function labelSheet(labels, cfg) {
  return h('div', { class: 'label-sheet' }, labels.map((label) => labelCard(label, cfg)));
}

export function labelStyle() {
  return devices().label;
}

export async function labelsView(root) {
  const queue = [];
  const queueHost = h('div');
  const previewHost = h('div', { class: 'card-body' });

  const picker = variantPicker({
    onPick: (variant) => {
      const existing = queue.find((q) => q.variant_id === variant.variant_id);
      if (existing) existing.copies += 1;
      else {
        queue.push({
          variant_id: variant.variant_id,
          sku: variant.sku,
          barcode: variant.barcode,
          name: pick(variant, 'product_name'),
          variant_label: variant.variant_label,
          price: variant.selling_price,
          copies: 1,
        });
      }
      renderQueue();
    },
  });

  function renderQueue() {
    mount(queueHost, dataTable({
      columns: [
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'name', label: t('product'), render: (r) => `${r.name} — ${r.variant_label || ''}` },
        { key: 'barcode', label: t('barcode'), class: 'mono small' },
        { key: 'price', label: t('price'), type: 'money', render: (r) => money(r.price) },
        {
          key: 'copies',
          label: t('copies'),
          align: 'end',
          render: (r) => numberInput({
            value: r.copies, min: 1, max: 200, style: { width: '80px' },
            onchange: (e) => { r.copies = Math.max(1, Number(e.target.value) || 1); renderQueue(); },
          }),
        },
        {
          key: '__x',
          label: '',
          render: (r, index) => h('button', {
            class: 'btn sm ghost',
            onclick: () => { queue.splice(index, 1); renderQueue(); mount(previewHost); },
          }, '✕'),
        },
      ],
      rows: queue,
      emptyMessage: t('scanPrompt'),
      footer: queue.length
        ? h('tr', {},
          h('td', { colspan: 4, class: 'right' }, t('total')),
          h('td', { class: 'num' }, `${queue.reduce((s, q) => s + q.copies, 0)} ${t('labelsQueued')}`),
          h('td', {}))
        : null,
    }));
  }

  async function buildSheet() {
    if (!queue.length) { toast(t('scanPrompt'), 'warn'); return null; }
    mount(previewHost, spinner());
    try {
      const cfg = labelStyle();
      const batch = await api.post('/api/labels/batch', {
        items: queue.map((q) => ({ variant_id: q.variant_id, copies: q.copies })),
        labelSize: `${cfg.widthMm}x${cfg.heightMm}`,
        qrSize: 180,
      });
      const sheet = labelSheet(batch.labels, cfg);
      mount(previewHost, sheet);
      return sheet;
    } catch (error) {
      toastError(error);
      mount(previewHost);
      return null;
    }
  }

  const cfg = labelStyle();

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('labelPrinting')),
        h('p', {}, `${cfg.widthMm} × ${cfg.heightMm} mm · ${t('configuredIn')} ${t('settings')} → ${t('devices')}`)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => navigate('settings?tab=devices') }, '⚙ ' + t('labelSettings')),
      h('button', { class: 'btn', onclick: () => { queue.length = 0; renderQueue(); mount(previewHost); } }, t('clearSheet')),
      h('button', { class: 'btn', onclick: buildSheet }, t('view')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const sheet = await buildSheet();
          if (sheet) printNode(sheet.cloneNode(true));
        },
      }, '🖨 ' + t('printSheet'))),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', {}, t('add')),
        h('span', { class: 'spacer' }),
        tag(`${cfg.widthMm} × ${cfg.heightMm} mm`, 'info')),
      h('div', { class: 'card-body' }, picker.node),
      queueHost),

    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-head' },
        h('h3', {}, t('print')),
        h('span', { class: 'spacer' }),
        tag(t('scanToTest'), 'info')),
      previewHost));

  renderQueue();
  return () => picker.destroy();
}
