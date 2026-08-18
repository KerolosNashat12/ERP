/**
 * Settings → Devices.
 *
 * Cheap barcode scanners and thermal printers are never quite the same twice,
 * so every value they need is exposed here rather than hard-coded — and each
 * one has a live test beside it, because the only way to know a label printer
 * is aligned is to print one and look at it.
 */
import api from '../core/api.js';
import {
  h, mount, field, textInput, numberInput, selectInput, checkboxInput,
  toast, toastError, printNode, tag, dataTable,
} from '../core/ui.js';
import { t, getLanguage } from '../core/i18n.js';
import { session, can, loadSession } from '../core/store.js';
import { onScanDiagnostic } from '../core/scanner.js';
import { buildReceipt } from './pos.js';
import { labelSheet } from './labels.js';

export function devicesPanel() {
  const editable = can('settings.update');
  const draft = { ...session.settings };
  const set = (key, value) => { draft[key] = value; };

  const num = (key, fallback) => Number(draft[key] ?? fallback);
  const bool = (key) => draft[key] === true || draft[key] === 1 || draft[key] === '1' || draft[key] === 'true';

  // ---------------------------------------------------------------- scanner

  const scanLog = h('div', { class: 'card-body tight' });
  const scanEvents = [];

  const testBox = textInput({
    placeholder: t('scannerTestPrompt'),
    dataset: { scanTarget: 'true' },
    autocomplete: 'off',
  });

  const unsubscribe = onScanDiagnostic((info) => {
    if (!info.raw) return;
    scanEvents.unshift({
      raw: info.raw,
      code: info.code,
      length: info.code.length,
      elapsed: info.elapsed,
      accepted: info.accepted,
      reason: info.reason,
    });
    scanEvents.splice(8);
    renderScanLog();
  });

  function renderScanLog() {
    mount(scanLog, dataTable({
      columns: [
        { key: 'raw', label: t('rawKeystrokes'), class: 'mono small' },
        { key: 'code', label: t('afterStripping'), class: 'mono small strong' },
        { key: 'length', label: t('length'), type: 'number' },
        { key: 'elapsed', label: t('speedMs'), type: 'number', render: (r) => `${r.elapsed} ms` },
        {
          key: 'accepted',
          label: t('result'),
          render: (r) => (r.accepted
            ? tag(t('recognisedAsScan'), 'ok')
            : tag(t(scanRejectKey(r.reason), r.reason || t('typedByHand')), 'warn')),
        },
      ],
      rows: scanEvents,
      emptyMessage: t('scannerTestEmpty'),
    }));
  }

  // Presets for the model selector: picking one fills the other scanner
  // fields below, which stay fully editable afterwards — a preset is only a
  // starting point, never a lock. 'Custom' and the blank option change
  // nothing, so the owner can always fall back to typing values by hand.
  const SCANNER_PRESETS = [
    {
      value: 'Zebex Z-3151HS', labelKey: 'scannerModelZebex',
      interval: 80, minLength: 4, prefix: '', suffix: '', beep: true,
    },
    {
      value: 'Generic USB laser', labelKey: 'scannerModelGenericUsb',
      interval: 60, minLength: 3, prefix: '', suffix: '', beep: true,
    },
    {
      value: '2D imager (QR + 1D)', labelKey: 'scannerModel2dImager',
      interval: 40, minLength: 3, prefix: '', suffix: '', beep: true,
    },
    {
      value: 'Bluetooth scanner', labelKey: 'scannerModelBluetooth',
      interval: 120, minLength: 4, prefix: '', suffix: '', beep: true,
    },
    { value: 'Custom', labelKey: 'scannerModelCustom' },
  ];

  const speedInput = numberInput({
    value: num('scanner.max_key_interval_ms', 60), min: 10, max: 500, disabled: !editable,
    onchange: (e) => set('scanner.max_key_interval_ms', Number(e.target.value)),
  });
  const minLengthInput = numberInput({
    value: num('scanner.min_length', 3), min: 1, max: 40, disabled: !editable,
    onchange: (e) => set('scanner.min_length', Number(e.target.value)),
  });
  const prefixInput = textInput({
    value: draft['scanner.strip_prefix'] || '', disabled: !editable,
    onchange: (e) => set('scanner.strip_prefix', e.target.value),
  });
  const suffixInput = textInput({
    value: draft['scanner.strip_suffix'] || '', disabled: !editable,
    onchange: (e) => set('scanner.strip_suffix', e.target.value),
  });
  const beepField = checkboxInput({
    label: t('scannerBeep'),
    checked: bool('scanner.beep_on_scan'),
    disabled: !editable,
    onchange: (e) => set('scanner.beep_on_scan', e.target.checked ? 1 : 0),
  });
  const beepCheckbox = beepField.querySelector('input');

  const zebexNotice = h('div', {
    class: 'shipping-example',
    style: { display: draft['scanner.model'] === 'Zebex Z-3151HS' ? 'block' : 'none' },
  }, t('scannerZebexNotice'));

  const modelSelect = selectInput({
    value: draft['scanner.model'] || '',
    disabled: !editable,
    placeholder: t('scannerModelUnset'),
    options: SCANNER_PRESETS.map((p) => ({ value: p.value, label: t(p.labelKey) })),
    onchange: (e) => {
      const value = e.target.value;
      set('scanner.model', value);
      zebexNotice.style.display = value === 'Zebex Z-3151HS' ? 'block' : 'none';
      const preset = SCANNER_PRESETS.find((p) => p.value === value);
      if (!preset || preset.interval === undefined) return; // Custom / unset: leave every other field as-is
      set('scanner.max_key_interval_ms', preset.interval);
      set('scanner.min_length', preset.minLength);
      set('scanner.strip_prefix', preset.prefix);
      set('scanner.strip_suffix', preset.suffix);
      set('scanner.beep_on_scan', preset.beep ? 1 : 0);
      speedInput.value = preset.interval;
      minLengthInput.value = preset.minLength;
      prefixInput.value = preset.prefix;
      suffixInput.value = preset.suffix;
      beepCheckbox.checked = preset.beep;
    },
  });

  const scannerSection = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, t('barcodeScanner')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, t('scannerIntro'))),
    h('div', { class: 'card-body' },
      h('div', { class: 'grid cols-3' },
        h('div', { class: 'field' }, checkboxInput({
          label: t('scannerEnabled'),
          checked: bool('scanner.enabled'),
          disabled: !editable,
          onchange: (e) => set('scanner.enabled', e.target.checked ? 1 : 0),
        })),
        field({
          label: t('scannerModel'),
          input: modelSelect,
          hint: t('scannerModelHint'),
        }),
        h('div'),
        field({ label: t('scannerSpeed'), input: speedInput, hint: t('scannerSpeedHint') }),
        field({ label: t('scannerMinLength'), input: minLengthInput, hint: t('scannerMinLengthHint') }),
        field({ label: t('scannerPrefix'), input: prefixInput, hint: t('scannerPrefixHint') }),
        field({ label: t('scannerSuffix'), input: suffixInput, hint: t('scannerSuffixHint') }),
        h('div', { class: 'field' }, beepField)),
      zebexNotice),

    h('div', { class: 'card-head' },
      h('h3', { style: { fontSize: '13px' } }, t('scannerTest')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm ghost', onclick: () => { scanEvents.length = 0; renderScanLog(); } }, t('clear'))),
    h('div', { class: 'card-body' },
      field({
        label: t('scannerTestLabel'),
        input: testBox,
        hint: t('scannerTestHint'),
      })),
    scanLog);

  // ------------------------------------------------------------ receipt printer

  const receiptPreview = h('div', { class: 'card-body', style: { display: 'grid', justifyContent: 'center' } });

  function renderReceiptPreview() {
    mount(receiptPreview, buildReceipt(sampleSale(), {
      width: String(draft['printer.receipt_width'] || '80'),
      showQr: bool('printer.receipt_show_qr'),
      showTaxLines: bool('printer.receipt_show_tax_lines'),
      fontScale: num('printer.receipt_font_scale', 100),
      footer: getLanguage() === 'ar'
        ? draft['printer.receipt_footer_ar']
        : draft['printer.receipt_footer_en'],
      returnPolicy: getLanguage() === 'ar'
        ? draft['printer.receipt_return_policy_ar']
        : draft['printer.receipt_return_policy_en'],
      preview: true,
    }));
  }

  const receiptSection = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, t('receiptPrinter')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, t('receiptPrinterIntro'))),
    h('div', { class: 'card-body' },
      h('div', { class: 'grid cols-3' },
        field({
          label: t('paperWidth'),
          input: selectInput({
            value: String(draft['printer.receipt_width'] || '80'),
            disabled: !editable,
            options: [
              { value: '58', label: t('thermal58mm') },
              { value: '80', label: t('thermal80mm') },
              { value: 'a4', label: t('a4OfficePrinter') },
            ],
            onchange: (e) => { set('printer.receipt_width', e.target.value); renderReceiptPreview(); },
          }),
          hint: t('paperWidthHint'),
        }),
        field({
          label: t('receiptCopies'),
          input: numberInput({
            value: num('printer.receipt_copies', 1), min: 1, max: 5, disabled: !editable,
            onchange: (e) => set('printer.receipt_copies', Number(e.target.value)),
          }),
          hint: t('receiptCopiesHint'),
        }),
        field({
          label: t('receiptFontScale'),
          input: numberInput({
            value: num('printer.receipt_font_scale', 100), min: 70, max: 160, disabled: !editable,
            onchange: (e) => { set('printer.receipt_font_scale', Number(e.target.value)); renderReceiptPreview(); },
          }),
          hint: t('receiptFontScaleHint'),
        }),
        h('div', { class: 'field' }, checkboxInput({
          label: t('autoPrintReceipt'),
          checked: bool('printer.auto_print_receipt'),
          disabled: !editable,
          onchange: (e) => set('printer.auto_print_receipt', e.target.checked ? 1 : 0),
        })),
        h('div', { class: 'field' }, checkboxInput({
          label: t('receiptShowQr'),
          checked: bool('printer.receipt_show_qr'),
          disabled: !editable,
          onchange: (e) => { set('printer.receipt_show_qr', e.target.checked ? 1 : 0); renderReceiptPreview(); },
        })),
        h('div', { class: 'field' }, checkboxInput({
          label: t('receiptShowTax'),
          checked: bool('printer.receipt_show_tax_lines'),
          disabled: !editable,
          onchange: (e) => { set('printer.receipt_show_tax_lines', e.target.checked ? 1 : 0); renderReceiptPreview(); },
        })),
        field({
          label: t('receiptFooter') + ' (EN)',
          input: textInput({
            value: draft['printer.receipt_footer_en'] || '', disabled: !editable,
            onchange: (e) => { set('printer.receipt_footer_en', e.target.value); renderReceiptPreview(); },
          }),
        }),
        field({
          label: t('receiptFooter') + ' (AR)',
          input: textInput({
            value: draft['printer.receipt_footer_ar'] || '', disabled: !editable,
            onchange: (e) => { set('printer.receipt_footer_ar', e.target.value); renderReceiptPreview(); },
          }),
        }),
        field({
          label: t('receiptReturnPolicy'),
          input: textInput({
            value: draft['printer.receipt_return_policy_en'] || '', disabled: !editable,
            onchange: (e) => { set('printer.receipt_return_policy_en', e.target.value); renderReceiptPreview(); },
          }),
          hint: t('receiptReturnPolicyHint'),
        }))),
    h('div', { class: 'card-head' },
      h('h3', { style: { fontSize: '13px' } }, t('preview')),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn sm primary',
        onclick: () => printNode(buildReceipt(sampleSale(), {
          width: String(draft['printer.receipt_width'] || '80'),
          showQr: bool('printer.receipt_show_qr'),
          showTaxLines: bool('printer.receipt_show_tax_lines'),
          fontScale: num('printer.receipt_font_scale', 100),
          footer: getLanguage() === 'ar' ? draft['printer.receipt_footer_ar'] : draft['printer.receipt_footer_en'],
          returnPolicy: getLanguage() === 'ar' ? draft['printer.receipt_return_policy_ar'] : draft['printer.receipt_return_policy_en'],
        })),
      }, '🖨 ' + t('printTestReceipt'))),
    receiptPreview);

  // -------------------------------------------------------------- label printer

  const labelPreview = h('div', { class: 'card-body' });

  function currentLabelConfig() {
    return {
      widthMm: num('labels.width_mm', 40),
      heightMm: num('labels.height_mm', 30),
      gapMm: num('labels.gap_mm', 2),
      offsetXMm: num('labels.offset_x_mm', 0),
      offsetYMm: num('labels.offset_y_mm', 0),
      qrSizeMm: num('labels.qr_size_mm', 17),
      symbology: draft['labels.symbology'] || 'code128',
      codeHeightMm: num('labels.code_height_mm', 12),
      showCodeText: bool('labels.show_code_text'),
      showProductName: bool('labels.show_product_name'),
      showVariant: bool('labels.show_variant'),
      showPrice: bool('labels.show_price'),
      showSku: bool('labels.show_sku'),
      showShopName: bool('labels.show_shop_name'),
    };
  }

  // EAN-13 only encodes digits, so the sample payload has to switch shape —
  // the usual "MM-HB01-M-BLK" SKU would otherwise 422 the moment EAN-13 is
  // picked.
  const SAMPLE_PAYLOAD = { code128: 'MM-HB01-M-BLK', qr: 'MM-HB01-M-BLK', ean13: '590123412345' };

  /**
   * One sample code fetched fresh from `/api/labels/code`, honouring the
   * still-unsaved symbology (the endpoint's only override — bar height and
   * the show-digits toggle come from the saved settings, same as a batch
   * print). The bar-height setting still previews live: `labelSheet` is
   * asked to size the 1D code off `cfg.codeHeightMm` directly rather than
   * off the label's printable width, so the box visibly grows or shrinks
   * with the number without needing the server to re-render.
   */
  async function fetchSampleCode(cfg) {
    const payload = SAMPLE_PAYLOAD[cfg.symbology] || SAMPLE_PAYLOAD.code128;
    const { dataUri, aspect } = await api.get('/api/labels/code', { payload, symbology: cfg.symbology });
    return {
      qr: dataUri, codeImage: dataUri, codeAspect: aspect || 1, symbology: cfg.symbology, barcode: payload,
    };
  }

  function sampleLabel(code) {
    return {
      sku: code.barcode,
      ...code,
      productNameEn: 'Classic Tote Handbag',
      productNameAr: 'حقيبة يد كلاسيكية',
      variantLabel: 'Medium / Black',
      price: 1250,
      currency: session.settings['company.currency'] || 'EGP',
      company: { name: session.settings['company.name'] },
    };
  }

  async function renderLabelPreview() {
    try {
      const cfg = currentLabelConfig();
      const code = await fetchSampleCode(cfg);
      mount(labelPreview, labelSheet([sampleLabel(code)], cfg, { anchorHeight: true }));
    } catch (error) { toastError(error); }
  }

  const labelSection = h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, t('labelPrinter')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, t('labelPrinterIntro'))),
    h('div', { class: 'card-body' },
      h('div', { class: 'grid cols-4' },
        field({
          label: t('labelWidth'),
          input: numberInput({
            value: num('labels.width_mm', 40), min: 15, max: 120, disabled: !editable,
            onchange: (e) => { set('labels.width_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
        }),
        field({
          label: t('labelHeight'),
          input: numberInput({
            value: num('labels.height_mm', 30), min: 10, max: 120, disabled: !editable,
            onchange: (e) => { set('labels.height_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
        }),
        field({
          label: t('labelGap'),
          input: numberInput({
            value: num('labels.gap_mm', 2), min: 0, max: 20, disabled: !editable,
            onchange: (e) => { set('labels.gap_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
          hint: t('labelGapHint'),
        }),
        field({
          label: t('qrSize'),
          input: numberInput({
            value: num('labels.qr_size_mm', 17), min: 8, max: 60, disabled: !editable,
            onchange: (e) => { set('labels.qr_size_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
          hint: t('qrSizeHint'),
        }),
        field({
          label: t('labelSymbology'),
          input: selectInput({
            value: draft['labels.symbology'] || 'code128',
            disabled: !editable,
            options: [
              { value: 'code128', label: t('labelSymbologyCode128') },
              { value: 'ean13', label: t('labelSymbologyEan13') },
              { value: 'qr', label: t('labelSymbologyQr') },
            ],
            onchange: (e) => { set('labels.symbology', e.target.value); renderLabelPreview(); },
          }),
          hint: t('labelSymbologyHint'),
        }),
        field({
          label: t('codeHeight'),
          input: numberInput({
            value: num('labels.code_height_mm', 12), min: 5, max: 25, disabled: !editable,
            onchange: (e) => { set('labels.code_height_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
          hint: t('codeHeightHint'),
        }),
        h('div', { class: 'field' }, checkboxInput({
          label: t('showCodeText'),
          checked: bool('labels.show_code_text'),
          disabled: !editable,
          onchange: (e) => { set('labels.show_code_text', e.target.checked ? 1 : 0); renderLabelPreview(); },
        })),
        field({
          label: t('offsetX'),
          input: numberInput({
            value: num('labels.offset_x_mm', 0), min: -20, max: 20, step: '0.5', disabled: !editable,
            onchange: (e) => { set('labels.offset_x_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
          hint: t('offsetHint'),
        }),
        field({
          label: t('offsetY'),
          input: numberInput({
            value: num('labels.offset_y_mm', 0), min: -20, max: 20, step: '0.5', disabled: !editable,
            onchange: (e) => { set('labels.offset_y_mm', Number(e.target.value)); renderLabelPreview(); },
          }),
          hint: t('offsetHint'),
        }),
        ...[
          ['labels.show_product_name', t('showProductName')],
          ['labels.show_variant', t('showVariant')],
          ['labels.show_price', t('showPrice')],
          ['labels.show_sku', t('showSku')],
          ['labels.show_shop_name', t('showShopName')],
        ].map(([key, label]) => h('div', { class: 'field' }, checkboxInput({
          label,
          checked: bool(key),
          disabled: !editable,
          onchange: (e) => { set(key, e.target.checked ? 1 : 0); renderLabelPreview(); },
        }))))),
    h('div', { class: 'card-head' },
      h('h3', { style: { fontSize: '13px' } }, t('preview')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, t('labelCalibrationHint')),
      h('button', {
        class: 'btn sm primary',
        onclick: async () => {
          const cfg = currentLabelConfig();
          const code = await fetchSampleCode(cfg);
          printNode(labelSheet(Array.from({ length: 3 }, () => sampleLabel(code)), cfg));
        },
      }, '🖨 ' + t('printTestLabels'))),
    labelPreview);

  // ------------------------------------------------------------------- save

  const saveBar = h('div', { class: 'row', style: { marginTop: '14px' } },
    h('span', { class: 'muted small' }, t('devicesSaveHint')),
    h('span', { class: 'spacer' }),
    editable ? h('button', {
      class: 'btn primary',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const deviceKeys = Object.keys(draft).filter((k) => /^(scanner|printer|labels)\./.test(k));
          await api.put('/api/settings', Object.fromEntries(deviceKeys.map((k) => [k, draft[k]])));
          await loadSession();
          toast(t('saved'));
        } catch (error) { toastError(error); } finally {
          event.currentTarget.disabled = false;
        }
      },
    }, t('save')) : null);

  const node = h('div', { class: 'stack' }, scannerSection, receiptSection, labelSection, saveBar);

  renderScanLog();
  renderReceiptPreview();
  renderLabelPreview();

  return { node, destroy: () => unsubscribe() };
}

const scanRejectKey = (reason) => ({
  too_short: 'rejectedTooShort',
  typing_in_field: 'rejectedTyping',
}[reason] || 'typedByHand');

/** A fake sale used only to preview the receipt layout. */
function sampleSale() {
  return {
    id: 0,
    invoice_no: 'INV-0000-00000',
    sale_date: new Date().toISOString(),
    cashier_name: session.user?.fullName || '',
    customer_name: null,
    lines: [
      {
        description: 'Classic Tote Handbag — Medium / Black',
        quantity: 1, unit_price: 1250, tax_amount: 175, line_total: 1425,
      },
      {
        description: 'Classic Tote Handbag — Large / Beige',
        quantity: 2, unit_price: 1325, tax_amount: 371, line_total: 3021,
      },
    ],
    subtotal: 3900,
    discount_amount: 0,
    tax_amount: 546,
    total_amount: 4446,
    paid_amount: 4500,
    change_amount: 54,
    payment_method: 'cash',
    loyalty_earned: 222,
  };
}
