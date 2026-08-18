/**
 * QR / barcode label generation.
 *
 * Codes are rendered server-side as SVG data URIs so label sheets print
 * identically on any machine with no internet access and no client-side
 * library. The payload is the variant barcode (defaults to the SKU), which is
 * exactly what a hardware scanner emits back into the POS search box.
 */
import QRCode from 'qrcode';
import repositories from '../infrastructure/repositories/index.js';
import { NotFoundError, ValidationError } from '../shared/errors.js';
import { renderBarcode as renderBarcodeSvg } from '../shared/barcode.js';
import auditService from './AuditService.js';

const SUPPORTED_SYMBOLOGIES = new Set(['code128', 'ean13', 'qr']);

function svgToDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** width/height straight out of the SVG's own attributes — the single
 * source of truth for the aspect ratio the label sheet lays the code out
 * with, rather than a second calculation that could drift from the render. */
function svgAspect(svg) {
  const w = Number((/\swidth="([\d.]+)"/.exec(svg) || [])[1]);
  const h = Number((/\sheight="([\d.]+)"/.exec(svg) || [])[1]);
  return w > 0 && h > 0 ? w / h : 1;
}

export class LabelService {
  constructor(deps = {}) {
    this.variants = deps.variants || repositories.variants;
    this.settings = deps.settings || repositories.settings;
    this.audit = deps.audit || auditService;
  }

  async renderQr(payload, { size = 128, margin = 1 } = {}) {
    return QRCode.toString(String(payload), {
      type: 'svg',
      margin,
      width: size,
      errorCorrectionLevel: 'M',
    });
  }

  async qrDataUri(payload, options = {}) {
    // The QR library throws a bare "No input text" on empty input, which reaches
    // the client as a 500. An empty payload is a bad request, and saying so is
    // the difference between a usable error at the counter and a mystery.
    const text = String(payload ?? '').trim();
    if (!text) throw new ValidationError('Nothing to encode — a QR code needs a payload');

    return QRCode.toDataURL(text, {
      margin: options.margin ?? 1,
      width: options.size ?? 160,
      errorCorrectionLevel: 'M',
    });
  }

  /**
   * Renders `payload` in `symbology` ('code128' | 'ean13' | 'qr') as an SVG
   * string. Falls back to `labels.symbology` / `labels.code_height_mm` /
   * `labels.show_code_text` for anything the caller doesn't override, so a
   * single label batch or the `/api/labels/code` endpoint can just say which
   * bits it cares about. 'qr' renders through the existing qrcode library
   * exactly as it always has; 'code128' and 'ean13' go through the
   * hand-written encoder in shared/barcode.js — an un-encodable payload
   * throws a ValidationError there rather than printing something a scanner
   * would misread.
   */
  async renderBarcode(payload, options = {}) {
    const symbology = String(
      options.symbology || await this.settings.get('labels.symbology', 'code128'),
    ).toLowerCase();
    if (!SUPPORTED_SYMBOLOGIES.has(symbology)) {
      throw new ValidationError(`Unknown label symbology "${symbology}" — expected code128, ean13 or qr`);
    }
    if (symbology === 'qr') {
      // renderQr (unlike qrDataUri) has no empty-input guard of its own — the
      // QR library's bare "No input text" would otherwise surface as a 500.
      if (!String(payload ?? '').trim()) throw new ValidationError('Nothing to encode — a QR code needs a payload');
      return this.renderQr(payload, { size: options.size ?? 180, margin: options.margin ?? 1 });
    }
    const heightMm = options.heightMm ?? Number(await this.settings.get('labels.code_height_mm', 12));
    const showText = options.showText ?? await this.settings.get('labels.show_code_text', true);
    return renderBarcodeSvg(payload, { symbology, heightMm, showText });
  }

  /** `renderBarcode` as a `data:image/svg+xml;base64,…` URI, ready to drop into an `<img>`. */
  async barcodeDataUri(payload, options = {}) {
    return svgToDataUri(await this.renderBarcode(payload, options));
  }

  /**
   * One render pass producing everything a label item or the `/api/labels/code`
   * route needs: the data URI, the symbology actually used (after settings
   * fallback), and the SVG's own width/height ratio — a 1D code is wide and
   * short, not square, and the label sheet needs that ratio to lay it out
   * without guessing at the encoder's internals.
   */
  async codeImage(payload, options = {}) {
    const symbology = String(
      options.symbology || await this.settings.get('labels.symbology', 'code128'),
    ).toLowerCase();
    const svg = await this.renderBarcode(payload, { ...options, symbology });
    return { dataUri: svgToDataUri(svg), aspect: svgAspect(svg), symbology };
  }

  /**
   * Build a print-ready label batch.
   * @param {Array<{variant_id:number, copies:number}>} items
   */
  async buildBatch(items = [], options = {}, context = {}) {
    if (!items.length) throw new ValidationError('Select at least one item to print');
    const company = {
      name: await this.settings.get('company.name', 'M&M Accessories'),
      nameAr: await this.settings.get('company.name_ar', 'إم آند إم للإكسسوارات'),
    };
    const currency = await this.settings.get('company.currency', 'EGP');
    const labels = [];

    for (const item of items) {
      const variant = await this.variants.details(item.variant_id);
      if (!variant) throw new NotFoundError('Variant', item.variant_id);
      const payload = variant.barcode || variant.sku;
      const { dataUri: codeImage, aspect: codeAspect, symbology } = await this.codeImage(payload, {
        symbology: options.symbology, size: options.qrSize || 180,
      });
      const copies = Math.min(Math.max(Number(item.copies) || 1, 1), 200);
      for (let i = 0; i < copies; i += 1) {
        labels.push({
          sku: variant.sku,
          barcode: payload,
          symbology,
          codeImage,
          codeAspect,
          // `qr` equals `codeImage` for this release regardless of symbology,
          // so a label sheet mid-deploy that still only knows `label.qr`
          // renders *something* instead of breaking.
          qr: codeImage,
          productNameEn: variant.product_name_en,
          productNameAr: variant.product_name_ar,
          variantLabel: variant.variant_label,
          brandEn: variant.brand_name_en,
          price: variant.selling_price,
          currency,
          company,
        });
      }
    }

    await this.audit.record({
      action: 'PRINT', module: 'labels', entityType: 'label_batch',
      entityLabel: `${labels.length} labels`,
      after: { items: items.length, labels: labels.length, size: options.labelSize || '40x30' },
      actor: context.actor, request: context.request,
    });

    return { labels, labelSize: options.labelSize || '40x30', generatedAt: new Date().toISOString() };
  }

  /** QR for a document (invoice / PO) so it can be pulled up by scanning. */
  async documentQr(type, number) {
    return this.qrDataUri(`${type.toUpperCase()}:${number}`, { size: 140 });
  }
}

export const labelService = new LabelService();
export default labelService;
